import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../../config/env';
import { AuthRepository } from './auth.repository';

export class AuthService {
  static generateAccessToken(user: any, role: any) {
    return jwt.sign(
      {
        id: user.id,
        tenantId: user.tenantId,
        roleId: user.roleId,
        permissions: role.permissions,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: role.name,
      },
      env.JWT_ACCESS_SECRET,
      { expiresIn: env.JWT_ACCESS_EXPIRATION as any }
    );
  }

  static async generateRefreshToken(tx: any, user: any) {
    const rawToken = jwt.sign(
      {
        userId: user.id,
        tenantId: user.tenantId,
        roleId: user.roleId,
        email: user.email,
      },
      env.JWT_REFRESH_SECRET,
      { expiresIn: env.JWT_REFRESH_EXPIRATION as any }
    );
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await AuthRepository.insertRefreshToken(tx, {
      tenantId: user.tenantId,
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    return rawToken; // Return the unhashed token to the user
  }

  static async login(tx: any, email: string, passwordRaw: string) {
    const user = await AuthRepository.findUserByEmail(tx, email);
    if (!user) {
      throw new Error('Invalid credentials');
    }

    const isMatch = await bcrypt.compare(passwordRaw, user.passwordHash);
    if (!isMatch) {
      throw new Error('Invalid credentials');
    }

    const role = await AuthRepository.getRoleById(tx, user.roleId);

    const accessToken = this.generateAccessToken(user, role);
    const refreshToken = await this.generateRefreshToken(tx, user);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        tenantId: user.tenantId,
        role: role.name,
        permissions: role.permissions,
      },
    };
  }

  static async verifyAndRotateRefreshToken(tx: any, rawToken: string, decoded: any) {
    const { userId } = decoded;
    const tokens = await AuthRepository.findRefreshTokensByUserId(tx, userId);
    let matchedTokenId: string | null = null;
    let isRevoked = false;
    let isExpired = false;

    const rawTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    for (const rt of tokens) {
      if (rawTokenHash === rt.tokenHash) {
        if (rt.revokedAt) {
          isRevoked = true;
          break;
        }
        if (rt.expiresAt < new Date()) {
          isExpired = true;
          break;
        }
        matchedTokenId = rt.id;
        break;
      }
    }

    if (isRevoked) {
      throw new Error('Refresh token revoked');
    }
    
    if (isExpired) {
      throw new Error('Refresh token expired');
    }

    if (!matchedTokenId) {
      throw new Error('Invalid or expired refresh token');
    }

    await AuthRepository.revokeRefreshToken(tx, matchedTokenId);

    const user = await AuthRepository.findUserById(tx, userId);
    const newRefreshToken = await this.generateRefreshToken(tx, user);
    const role = await AuthRepository.getRoleById(tx, user.roleId);
    const newAccessToken = this.generateAccessToken(user, role);

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        tenantId: user.tenantId,
        role: role.name,
        permissions: role.permissions,
      },
    };
  }

  static async logout(tx: any, userId: string, rawToken: string) {
    const tokens = await AuthRepository.findRefreshTokensByUserId(tx, userId);
    const rawTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    for (const rt of tokens) {
      if (rawTokenHash === rt.tokenHash) {
        await AuthRepository.revokeRefreshToken(tx, rt.id);
        break;
      }
    }
  }
}
