export interface JobPayload {
  tenantId: string;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  metadata?: any;
  createdAt: string;
}
