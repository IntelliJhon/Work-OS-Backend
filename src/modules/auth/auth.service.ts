import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../../config/env';
import { AuthRepository } from './auth.repository';
import { zonedTimeToUtc } from '../calendar/task-schedule';

/** The next daily logout moment after `now` (DAILY_LOGOUT_TIME in WORK_TIMEZONE), or null if switched off. */
export function nextDailyLogout(now: Date): Date | null {
  const at = env.DAILY_LOGOUT_TIME;
  if (!at || !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: env.WORK_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const candidate = zonedTimeToUtc(today, at);
  if (candidate > now) return candidate;
  const [y, m, d] = today.split('-').map(Number);
  return zonedTimeToUtc(new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10), at);
}

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
    // Sessions end at the daily logout time (DAILY_LOGOUT_TIME, local to WORK_TIMEZONE), so everyone logs in
    // again each day and that login is the day's attendance check-in. Otherwise they last 7 days.
    const weekLater = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const cutoff = nextDailyLogout(new Date());
    const expiresAt = new Date(cutoff ? Math.min(cutoff.getTime(), weekLater) : weekLater);
    const rawToken = jwt.sign(
      {
        userId: user.id,
        tenantId: user.tenantId,
        roleId: user.roleId,
        email: user.email,
      },
      env.JWT_REFRESH_SECRET,
      { expiresIn: cutoff ? Math.max(60, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) : env.JWT_REFRESH_EXPIRATION as any }
    );
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

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

  static async forgotPassword(tx: any, email: string, tenantId: string) {
    const user = await AuthRepository.findUserByEmail(tx, email);
    if (!user) {
      throw new Error('User not found');
    }

    // Sign a temporary reset token valid for 15 minutes
    const resetToken = jwt.sign(
      { userId: user.id, tenantId: user.tenantId, email: user.email, purpose: 'password-reset' },
      env.JWT_ACCESS_SECRET,
      { expiresIn: '15m' }
    );

    return { resetToken };
  }

  static async resetPassword(tx: any, userId: string, passwordHash: string) {
    // 1. Update password
    await AuthRepository.updatePassword(tx, userId, passwordHash);
    // 2. Revoke all previous active refresh sessions for absolute security
    await AuthRepository.deleteAllRefreshTokens(tx, userId);
  }
}
