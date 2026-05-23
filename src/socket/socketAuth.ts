import { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { getTenantRoom, getUserRoom } from './tenantRooms';

export const socketAuthMiddleware = (socket: Socket, next: (err?: Error) => void) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Authentication token missing'));
    }

    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as any;
    
    // Attach user to socket context
    socket.data.user = decoded;

    // Immediately enforce tenant isolation by joining rooms
    socket.join(getTenantRoom(decoded.tenantId));
    socket.join(getUserRoom(decoded.tenantId, decoded.id));

    logger.info({ userId: decoded.id, tenantId: decoded.tenantId, socketId: socket.id }, 'Socket authenticated and rooms joined');

    next();
  } catch (err) {
    logger.warn({ err, socketId: socket.id }, 'Socket authentication failed');
    next(new Error('Authentication failed'));
  }
};
