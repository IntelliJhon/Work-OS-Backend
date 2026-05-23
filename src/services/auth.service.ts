import { eq } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { db } from '../db';
import { users } from '../db/schema/users';
import { roles } from '../db/schema/roles';
import { refreshTokens } from '../db/schema/auth';
import crypto from 'crypto';

export class AuthService {
  static generateAccessToken(user: any, role: any) {
    return jwt.sign(
      {
        id: user.id,
        tenantId: user.tenantId,
        roleId: user.roleId,
        permissions: role.permissions,
      },
      env.JWT_ACCESS_SECRET,
      { expiresIn: env.JWT_ACCESS_EXPIRATION as any }
    );
  }

  static async generateRefreshToken(user: any) {
    const rawToken = crypto.randomBytes(40).toString('hex');
    const tokenHash = await bcrypt.hash(rawToken, 10);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await db.insert(refreshTokens).values({
      tenantId: user.tenantId,
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    return rawToken; // Return the unhashed token to the user
  }

  static async verifyAndRotateRefreshToken(userId: string, rawToken: string) {
    // 1. Fetch all active tokens for user
    const tokens = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId));

    let matchedTokenId: string | null = null;

    // 2. Find matching hash
    for (const rt of tokens) {
      if (rt.expiresAt > new Date() && await bcrypt.compare(rawToken, rt.tokenHash)) {
        matchedTokenId = rt.id;
        break;
      }
    }

    if (!matchedTokenId) {
      throw new Error('Invalid or expired refresh token');
    }

    // 3. Revoke (delete) the used token
    await db.delete(refreshTokens).where(eq(refreshTokens.id, matchedTokenId));

    // 4. Issue a new one
    // We need the user to get tenantId, so we will return the token logic in controller or fetch user here
    const userRecords = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    return this.generateRefreshToken(userRecords[0]);
  }

  static async revokeAllUserTokens(userId: string) {
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
  }
}
