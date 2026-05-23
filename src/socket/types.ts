export interface SocketEventPayload {
  type: string;
  tenantId: string;
  actorId: string;
  timestamp: string;
  entityType: string;
  entityId: string;
  payload?: any;
}
