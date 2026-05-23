import { eq } from 'drizzle-orm';
import { users } from '../../db/schema/users';
import { roles } from '../../db/schema/roles';
import { refreshTokens } from '../../db/schema/auth';

export class AuthRepository {
  static async findUserByEmail(tx: any, email: string) {
    const records = await tx.select().from(users).where(eq(users.email, email)).limit(1);
    return records[0];
  }

  static async findUserById(tx: any, userId: string) {
    const records = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    return records[0];
  }

  static async getRoleById(tx: any, roleId: string) {
    const records = await tx.select().from(roles).where(eq(roles.id, roleId)).limit(1);
    return records[0];
  }

  static async insertRefreshToken(tx: any, data: { tenantId: string, userId: string, tokenHash: string, expiresAt: Date }) {
    await tx.insert(refreshTokens).values(data);
  }

  static async findRefreshTokensByUserId(tx: any, userId: string) {
    return await tx.select().from(refreshTokens).where(eq(refreshTokens.userId, userId));
  }

  static async revokeRefreshToken(tx: any, tokenId: string) {
    await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, tokenId));
  }

  static async deleteAllRefreshTokens(tx: any, userId: string) {
    await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
  }
}
