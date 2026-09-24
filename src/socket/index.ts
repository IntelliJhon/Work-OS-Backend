import { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { setIoInstance } from './socketServer';
import { socketAuthMiddleware } from './socketAuth';
import { logger } from '../config/logger';
import { getTenantRoom, getUserRoom } from './tenantRooms';
import { and, eq } from 'drizzle-orm';
import { projects } from '../db/schema/projects';
import { withTenant } from '../middleware/tenant.middleware';

const PROJECT_ROOM_REGEX = /^project:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** True only if the project exists and belongs to the given tenant. */
const projectBelongsToTenant = async (projectId: string, tenantId: string): Promise<boolean> => {
  const [project] = await withTenant(tenantId, async (tx) =>
    tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.tenantId, tenantId)))
      .limit(1),
  );
  return !!project;
};

export const initSocket = (httpServer: HttpServer) => {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: '*', // In production, restrict to frontend domain
      methods: ['GET', 'POST']
    }
  });

  setIoInstance(io);

  io.use(socketAuthMiddleware);

  io.on('connection', async (socket) => {
    const user = socket.data.user;
    const tenantRoom = getTenantRoom(user.tenantId);
    const userRoom = getUserRoom(user.tenantId, user.id);

    // Join tenant and user-specific rooms
    await socket.join(tenantRoom);
    await socket.join(userRoom);

    // MVP Presence Tracking: Broadcast to other users in the tenant
    socket.to(tenantRoom).emit('presence_event', {
      type: 'USER_ONLINE',
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      timestamp: new Date().toISOString()
    });

    // Send list of currently online users in this tenant to the newly connected socket
    const activeSockets = await io.in(tenantRoom).fetchSockets();
    const uniqueUsersMap = new Map<string, any>();
    activeSockets.forEach((s) => {
      const u = s.data?.user;
      if (u && u.id) {
        uniqueUsersMap.set(String(u.id), {
          userId: String(u.id),
          email: u.email,
          firstName: u.firstName,
          lastName: u.lastName,
          role: u.role
        });
      }
    });
    const onlineUsers = Array.from(uniqueUsersMap.values());
    const onlineUserIds = Array.from(uniqueUsersMap.keys());

    socket.emit('online_users_list', {
      userIds: onlineUserIds,
      users: onlineUsers
    });

    // Allow clients to request the online users list on-demand (avoids SPA mounting race conditions)
    socket.on('request_online_users', async () => {
      const currentActiveSockets = await io.in(tenantRoom).fetchSockets();
      const currentUniqueUsersMap = new Map<string, any>();
      currentActiveSockets.forEach((s) => {
        const u = s.data?.user;
        if (u && u.id) {
          currentUniqueUsersMap.set(String(u.id), {
            userId: String(u.id),
            email: u.email,
            firstName: u.firstName,
            lastName: u.lastName,
            role: u.role
          });
        }
      });
      const currentOnlineUsers = Array.from(currentUniqueUsersMap.values());
      const currentOnlineUserIds = Array.from(currentUniqueUsersMap.keys());

      socket.emit('online_users_list', {
        userIds: currentOnlineUserIds,
        users: currentOnlineUsers
      });
    });

    /**
     * Room for client-initiated relays. A project room is used only if this socket has joined it
     * (join_room verifies the project against the DB); anything else, e.g. 'global' tasks, goes to
     * the sender's own tenant room. This keeps a client from relaying into another tenant's rooms.
     */
    const relayRoom = (projectId: unknown): string => {
      const room = `project:${projectId}`;
      return projectId && socket.rooms.has(room) ? room : tenantRoom;
    };

    const relayRoomFromRoomId = (roomId: unknown): string =>
      typeof roomId === 'string' && roomId.startsWith('project:')
        ? relayRoom(roomId.slice('project:'.length))
        : tenantRoom;

    // Custom Room Orchestration
    // Allowlist: clients may only join `project:<uuid>` rooms of their own tenant.
    // Tenant and user rooms are joined server-side above and are never client-joinable.
    socket.on('join_room', async (payload) => {
      const roomId = typeof payload?.roomId === 'string' ? payload.roomId : '';
      const match = PROJECT_ROOM_REGEX.exec(roomId);
      if (!match) {
        logger.warn({ userId: user.id, roomId }, 'Socket join_room rejected: room not allowed');
        socket.emit('room_join_error', { roomId, code: 'room_not_allowed', error: 'Room not allowed' });
        return;
      }

      try {
        if (!(await projectBelongsToTenant(match[1], user.tenantId))) {
          logger.warn({ userId: user.id, tenantId: user.tenantId, roomId }, 'Socket join_room rejected: project not in tenant');
          socket.emit('room_join_error', { roomId, code: 'project_not_found', error: 'Project not found' });
          return;
        }
      } catch (err) {
        logger.error({ err, userId: user.id, roomId }, 'Socket join_room project lookup failed');
        socket.emit('room_join_error', { roomId, code: 'join_failed', error: 'Could not join room' });
        return;
      }

      await socket.join(roomId);
      // Notify other active members in the room
      socket.to(roomId).emit('user_joined_room', {
        user: {
          userId: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          role: user.role
        },
        roomId
      });
      logger.info({ userId: user.id, roomId }, 'Socket joined room');
    });

    socket.on('leave_room', (payload) => {
      const roomId = typeof payload?.roomId === 'string' ? payload.roomId : '';
      // Only joined project rooms can be left; tenant and user rooms are server-managed
      if (!PROJECT_ROOM_REGEX.test(roomId) || !socket.rooms.has(roomId)) return;
      socket.leave(roomId);
      socket.to(roomId).emit('user_left_room', {
        userId: user.id,
        roomId
      });
      logger.info({ userId: user.id, roomId }, 'Socket left room');
    });

    // Focus heartbeat reporting (heartbeat focus updates across the tenant)
    socket.on('report_focus', ({ projectId, page }) => {
      const tenantRoom = getTenantRoom(user.tenantId);
      socket.to(tenantRoom).emit('collaborator_focus_updated', {
        userId: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        projectId,
        page
      });
    });

    // Typing Indicators
    socket.on('typing_start', ({ roomId, entityId }) => {
      socket.to(relayRoomFromRoomId(roomId)).emit('user_typing_start', {
        userId: user.id,
        userName: `${user.firstName} ${user.lastName}`,
        entityId
      });
    });

    socket.on('typing_end', ({ roomId, entityId }) => {
      socket.to(relayRoomFromRoomId(roomId)).emit('user_typing_end', {
        userId: user.id,
        entityId
      });
    });

    // Threaded Comments Broadcast
    socket.on('broadcast_comment', async ({ projectId, entityId, comment }) => {
      const room = relayRoom(projectId);
      socket.to(room).emit('comment_received', { entityId, comment });

      // Trigger comment mentions notification in user tenant context
      try {
        const text = comment?.text || '';
        const mentionRegex = /@([A-Za-z0-9]+)\s+([A-Za-z0-9]+)/g;
        let match;
        const matches: { first: string; last: string }[] = [];
        while ((match = mentionRegex.exec(text)) !== null) {
          matches.push({ first: match[1], last: match[2] });
        }

        if (matches.length > 0) {
          const { users } = require('../db/schema/users');
          const { eq, and } = require('drizzle-orm');
          const { db } = require('../db');
          const { NotificationsService } = require('../modules/notifications/notifications.service');

          for (const m of matches) {
            const matchedUsers = await db.select().from(users).where(and(
              eq(users.tenantId, user.tenantId),
              eq(users.firstName, m.first),
              eq(users.lastName, m.last)
            ));

            for (const matchedUser of matchedUsers) {
              if (matchedUser.id === user.id) continue; // Don't notify self

              await NotificationsService.notify({
                tenantId: user.tenantId,
                recipientUserId: matchedUser.id,
                actorUserId: user.id,
                type: 'COMMENT_MENTION',
                title: 'Mentioned in Comment',
                message: `${user.firstName} ${user.lastName} mentioned you in a comment: "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`,
                entityType: 'task', // Help navigate to the task where comments reside
                entityId,
                priority: 'medium',
                metadata: {
                  commentText: text
                }
              });
            }
          }
        }
      } catch (err) {
        logger.error({ err }, 'Failed to parse comment mentions');
      }
    });

    socket.on('broadcast_comment_delete', ({ projectId, entityId, commentId }) => {
      const room = relayRoom(projectId);
      socket.to(room).emit('comment_deleted', { entityId, commentId });
    });

    socket.on('broadcast_comment_reaction', ({ projectId, entityId, commentId, reaction, userId }) => {
      const room = relayRoom(projectId);
      socket.to(room).emit('comment_reaction_received', { entityId, commentId, reaction, userId });
    });

    // Kanban movements broadcast
    socket.on('kanban_task_moved', ({ projectId, taskId, fromStatus, toStatus, actorName }) => {
      const room = relayRoom(projectId);
      socket.to(room).emit('kanban_task_moved_received', { taskId, fromStatus, toStatus, actorName });
    });

    socket.on('kanban_task_created', ({ projectId, sprintId, task, actorName }) => {
      const room = relayRoom(projectId);
      socket.to(room).emit('kanban_task_created_received', { sprintId, task, actorName });
    });

    socket.on('kanban_task_deleted', ({ projectId, sprintId, taskId }) => {
      const room = relayRoom(projectId);
      socket.to(room).emit('kanban_task_deleted_received', { sprintId, taskId });
    });

    socket.on('kanban_task_updated', ({ projectId, sprintId, taskId, updates }) => {
      const room = relayRoom(projectId);
      socket.to(room).emit('kanban_task_updated_received', { sprintId, taskId, updates });
    });

    socket.on('request_kanban_sync', ({ projectId }) => {
      const room = relayRoom(projectId);
      socket.to(room).emit('request_kanban_sync_received', { requesterId: socket.id });
    });

    socket.on('send_kanban_sync', ({ targetSocketId, sprintTasks }) => {
      io.to(targetSocketId).emit('send_kanban_sync_received', { sprintTasks });
    });

    socket.on('request_comments_sync', ({ projectId }) => {
      const room = relayRoom(projectId);
      socket.to(room).emit('request_comments_sync_received', { requesterId: socket.id });
    });

    socket.on('send_comments_sync', ({ targetSocketId, comments }) => {
      io.to(targetSocketId).emit('send_comments_sync_received', { comments });
    });

    socket.on('disconnect', async () => {
      // Prevent false offline indicators by checking if this user has other active socket connections
      const currentActiveSockets = await io.in(tenantRoom).fetchSockets();
      const stillHasSocket = currentActiveSockets.some((s) => s.data?.user?.id === user.id && s.id !== socket.id);

      if (!stillHasSocket) {
        io.to(tenantRoom).emit('presence_event', {
          type: 'USER_OFFLINE',
          userId: user.id,
          tenantId: user.tenantId,
          timestamp: new Date().toISOString()
        });
      }
      logger.info({ userId: user.id, socketId: socket.id }, 'Socket disconnected');
    });
  });

  logger.info('Socket.IO initialized successfully');
  return io;
};
