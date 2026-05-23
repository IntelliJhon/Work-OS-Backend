import { getIoInstance } from './socketServer';
import { getTenantRoom } from './tenantRooms';
import { SocketEventPayload } from './types';
import { logger } from '../config/logger';

export const emitWorkflowEvent = (payload: SocketEventPayload) => {
  try {
    const io = getIoInstance();
    const room = getTenantRoom(payload.tenantId);
    
    io.to(room).emit('workflow_event', payload);
    
    logger.debug({ room, type: payload.type, entityId: payload.entityId }, 'Workflow event emitted');
  } catch (error) {
    logger.error({ error, payload }, 'Failed to emit workflow event');
  }
};
