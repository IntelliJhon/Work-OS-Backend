export interface NotificationInput {
  tenantId: string;
  recipientUserId: string;
  actorUserId?: string;
  type: string;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  priority?: string;
  metadata?: any;
}
