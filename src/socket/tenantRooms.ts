export const getTenantRoom = (tenantId: string) => `tenant:${tenantId}`;
export const getUserRoom = (tenantId: string, userId: string) => `tenant:${tenantId}:user:${userId}`;
