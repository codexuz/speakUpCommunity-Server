import { Server as HttpServer } from 'http';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Server, Socket } from 'socket.io';
import prisma from '../prisma';
import { getRedis } from './redis';

const SESSION_PREFIX = 'sess:';

interface AuthPayload {
  userId: string;
  role: string;
  username: string;
  sessionId: string;
}

interface ChatSocket extends Socket {
  auth: AuthPayload;
}

let io: Server;

// ── Bootstrap ────────────────────────────────────────────────────

export function initChatSocket(httpServer: HttpServer): Server {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  io = new Server(httpServer, {
    path: '/ws/chat',
    cors: {
      origin: allowedOrigins.length > 0 ? allowedOrigins : '*',
      methods: ['GET', 'POST'],
    },
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  // ── Auth middleware ──────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const secret = process.env.JWT_SECRET;
      if (!secret) return next(new Error('Server misconfiguration'));

      // Check blacklist
      const redis = getRedis();
      const blacklisted = await redis.get(`bl:${token}`);
      if (blacklisted) return next(new Error('Token revoked'));

      const decoded = jwt.verify(token, secret) as JwtPayload;
      const userId = typeof decoded.sub === 'string' ? decoded.sub : null;
      const sessionId = typeof decoded.jti === 'string' ? decoded.jti : null;

      if (!userId || typeof decoded.role !== 'string' || typeof decoded.username !== 'string') {
        return next(new Error('Invalid token'));
      }

      // Verify active session
      if (sessionId) {
        const exists = await redis.exists(`${SESSION_PREFIX}${sessionId}`);
        if (!exists) return next(new Error('Session revoked'));
      }

      (socket as ChatSocket).auth = {
        userId,
        role: decoded.role,
        username: decoded.username,
        sessionId: sessionId || '',
      };

      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  // ── Connection handler ──────────────────────────────────────
  io.on('connection', async (rawSocket: Socket) => {
    const socket = rawSocket as ChatSocket;
    const { userId } = socket.auth;

    // Auto-join all group rooms the user belongs to
    const memberships = await prisma.groupMember.findMany({
      where: { userId },
      select: { groupId: true },
    });
    for (const m of memberships) {
      socket.join(`group:${m.groupId}`);
    }

    // Also join a personal room for DM-style pushes
    socket.join(`user:${userId}`);

    // ── Client events ───────────────────────────────────────

    // Join a specific group room (e.g. when user opens chat)
    socket.on('join-group', async (groupId: string) => {
      if (typeof groupId !== 'string') return;
      const membership = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId, userId } },
      });
      if (!membership) {
        socket.emit('error', { message: 'Not a member of this group' });
        return;
      }
      socket.join(`group:${groupId}`);
      socket.emit('joined-group', { groupId });
    });

    // Leave a group room (e.g. navigate away from chat screen)
    socket.on('leave-group', (groupId: string) => {
      if (typeof groupId !== 'string') return;
      socket.leave(`group:${groupId}`);
    });

    // Typing indicator
    socket.on('typing', async (data: { groupId: string; isTyping: boolean }) => {
      if (!data || typeof data.groupId !== 'string') return;
      const membership = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId: data.groupId, userId } },
      });
      if (!membership) return;

      socket.to(`group:${data.groupId}`).emit('user-typing', {
        groupId: data.groupId,
        userId,
        username: socket.auth.username,
        isTyping: !!data.isTyping,
      });
    });

    // Mark messages as read — persists to DB and emits receipt
    socket.on('mark-read', async (data: { groupId: string; lastMessageId: string }) => {
      if (!data || typeof data.groupId !== 'string' || typeof data.lastMessageId !== 'string') return;

      try {
        const msgId = BigInt(data.lastMessageId);

        // Verify message exists in this group
        const msg = await prisma.groupMessage.findFirst({
          where: { id: msgId, groupId: data.groupId },
          select: { id: true },
        });
        if (!msg) return;

        // Upsert the read cursor (only advance forward)
        await prisma.$executeRaw`
          INSERT INTO group_message_read_cursors (group_id, user_id, last_read_msg_id, updated_at)
          VALUES (${data.groupId}::uuid, ${userId}::uuid, ${msgId}, NOW())
          ON CONFLICT (group_id, user_id)
          DO UPDATE SET last_read_msg_id = GREATEST(group_message_read_cursors.last_read_msg_id, EXCLUDED.last_read_msg_id),
                        updated_at = NOW()
        `;

        socket.to(`group:${data.groupId}`).emit('messages-read', {
          groupId: data.groupId,
          userId,
          lastMessageId: data.lastMessageId,
        });
      } catch {
        // Silently ignore invalid message IDs
      }
    });

    socket.on('disconnect', () => {
      // Rooms are auto-cleaned by socket.io
    });
  });

  return io;
}

// ── Emitter helpers (called from REST routes) ────────────────────

export function getIO(): Server {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

/** Emit a new message to all group members */
export function emitGroupMessage(groupId: string, message: unknown): void {
  if (!io) return;
  io.to(`group:${groupId}`).emit('new-message', message);
}

/** Emit a message edit to all group members */
export function emitGroupMessageEdited(groupId: string, message: unknown): void {
  if (!io) return;
  io.to(`group:${groupId}`).emit('message-edited', message);
}

/** Emit a message deletion to all group members */
export function emitGroupMessageDeleted(groupId: string, messageId: string): void {
  if (!io) return;
  io.to(`group:${groupId}`).emit('message-deleted', { groupId, messageId });
}

/** Emit to a specific user across all their sockets */
export function emitToUser(userId: string, event: string, data: unknown): void {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, data);
}

/** Make sockets for a user join a new group room (e.g. after joining group) */
export async function addUserToGroupRoom(userId: string, groupId: string): Promise<void> {
  if (!io) return;
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const s of sockets) {
    s.join(`group:${groupId}`);
  }
}

/** Remove a user's sockets from a group room (e.g. after leaving/kicked) */
export async function removeUserFromGroupRoom(userId: string, groupId: string): Promise<void> {
  if (!io) return;
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const s of sockets) {
    s.leave(`group:${groupId}`);
  }
}
