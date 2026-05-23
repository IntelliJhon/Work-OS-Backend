import { db } from '../db';
import { auditLog } from '../db/schema/audit';
import { withTenant } from '../middleware/tenant.middleware';

export class AuditService {
  static async logAction(
    params: {
      tenantId: string;
      userId?: string;
      action: 'INSERT' | 'UPDATE' | 'DELETE';
      tableName: string;
      recordId: string;
      oldValue?: any;
      newValue?: any;
      ipAddress?: string;
    },
    tx?: any
  ) {
    const run = async (client: any) => {
      await client.insert(auditLog).values({
        tenantId: params.tenantId,
        userId: params.userId,
        action: params.action,
        tableName: params.tableName,
        recordId: params.recordId,
        oldValue: params.oldValue,
        newValue: params.newValue,
        ipAddress: params.ipAddress,
      });
    };

    if (tx) {
      await run(tx);
    } else {
      await withTenant(params.tenantId, async (innerTx) => {
        await run(innerTx);
      });
    }
  }
}
