import { Response, NextFunction } from 'express';
import { db } from '../../db';
import { auditLog } from '../../db/schema/audit';
import { users } from '../../db/schema/users';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { eq, and, or, ilike, sql, desc } from 'drizzle-orm';

export class AuditController {
  static async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const offset = (page - 1) * limit;
      const search = (req.query.search as string) || '';
      const action = req.query.action as string;

      const result = await withTenant(tenantId, async (tx) => {
        let conditions = eq(auditLog.tenantId, tenantId);

        if (action) {
          conditions = and(conditions, eq(auditLog.action, action)) as any;
        }

        if (search) {
          conditions = and(
            conditions,
            or(
              ilike(auditLog.tableName, `%${search}%`),
              ilike(users.email, `%${search}%`),
              ilike(users.firstName, `%${search}%`),
              ilike(users.lastName, `%${search}%`)
            )
          ) as any;
        }

        const logs = await tx
          .select({
            id: auditLog.id,
            userId: auditLog.userId,
            userEmail: users.email,
            userFirstName: users.firstName,
            userLastName: users.lastName,
            action: auditLog.action,
            tableName: auditLog.tableName,
            recordId: auditLog.recordId,
            oldValue: auditLog.oldValue,
            newValue: auditLog.newValue,
            ipAddress: auditLog.ipAddress,
            createdAt: auditLog.createdAt,
          })
          .from(auditLog)
          .leftJoin(users, eq(auditLog.userId, users.id))
          .where(conditions)
          .orderBy(desc(auditLog.createdAt))
          .limit(limit)
          .offset(offset);

        const [totalCountObj] = await tx
          .select({ count: sql`count(*)` })
          .from(auditLog)
          .leftJoin(users, eq(auditLog.userId, users.id))
          .where(conditions);

        const total = parseInt(totalCountObj?.count as string || '0');

        return {
          logs,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit)
          }
        };
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }
}
