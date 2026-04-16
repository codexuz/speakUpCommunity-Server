import { Request, Response, Router } from 'express';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest, authenticateRequest } from '../middleware/auth';
import prisma from '../prisma';
import { uploadFile } from '../services/minio';
import { emitGroupMessage, emitGroupMessageEdited, emitGroupMessageDeleted } from '../services/chatSocket';
import { sendPushToMultiple } from '../notifications';

const router = Router();

router.use(authenticateRequest);

// ── Multer setup for chat attachments ────────────────────────────

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_ATTACHMENTS = 10;

const ENTITY_TYPES = ['mention', 'hashtag', 'url', 'bold', 'italic', 'underline', 'code', 'pre', 'text_link', 'text_mention'] as const;

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_ATTACHMENTS },
});

// ── Helpers ──────────────────────────────────────────────────────

interface MessageEntity {
  type: (typeof ENTITY_TYPES)[number];
  offset: number;
  length: number;
  url?: string;   // for text_link
  userId?: string; // for text_mention
}

function validateEntities(entities: unknown, textLength: number): MessageEntity[] | null {
  if (!Array.isArray(entities)) return null;
  if (entities.length > 200) return null;

  for (const e of entities) {
    if (!e || typeof e !== 'object') return null;
    if (!ENTITY_TYPES.includes(e.type)) return null;
    if (typeof e.offset !== 'number' || typeof e.length !== 'number') return null;
    if (e.offset < 0 || e.length <= 0 || e.offset + e.length > textLength) return null;
    if (e.type === 'text_link' && (typeof e.url !== 'string' || e.url.length > 2048)) return null;
    if (e.type === 'text_mention' && typeof e.userId !== 'string') return null;
  }

  return entities as MessageEntity[];
}

// ── Helpers ──────────────────────────────────────────────────────

async function requireChatMembership(groupId: string, userId: string, res: Response) {
  const membership = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });
  if (!membership) {
    res.status(403).json({ error: 'You are not a member of this group' });
    return null;
  }
  return membership;
}

function detectMessageType(mimeType: string): 'image' | 'video' | 'file' {
  if (ALLOWED_IMAGE_TYPES.includes(mimeType)) return 'image';
  if (ALLOWED_VIDEO_TYPES.includes(mimeType)) return 'video';
  return 'file';
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

async function getGroupMemberIds(groupId: string, excludeUserId?: string): Promise<string[]> {
  const members = await prisma.groupMember.findMany({
    where: { groupId },
    select: { userId: true },
  });
  return members
    .map((m) => m.userId)
    .filter((id) => id !== excludeUserId);
}

async function notifyGroupMembers(
  groupId: string,
  senderId: string,
  senderName: string,
  groupName: string,
  preview: string,
  messageData: unknown,
) {
  const memberIds = await getGroupMemberIds(groupId, senderId);

  // Real-time WebSocket
  emitGroupMessage(groupId, messageData);

  // Push notifications
  const members = await prisma.groupMember.findMany({
    where: { groupId, userId: { in: memberIds } },
    include: { user: { select: { pushToken: true } } },
  });
  const tokens = members
    .map((m) => m.user.pushToken)
    .filter((t): t is string => !!t);

  if (tokens.length > 0) {
    sendPushToMultiple(tokens, groupName, `${senderName}: ${preview}`, {
      type: 'group-message',
      groupId,
    });
  }
}

// ── GET /api/group-chat/unread/counts ─────────────────────────────
// Get unread message counts for all groups the user belongs to
// IMPORTANT: This route must be before /:groupId routes
router.get('/unread/counts', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;

    const memberships = await prisma.groupMember.findMany({
      where: { userId: auth.userId },
      select: { groupId: true },
    });

    if (memberships.length === 0) {
      res.json({ data: [] });
      return;
    }

    const groupIds = memberships.map((m) => m.groupId);

    // Get read cursors for all groups
    const cursors = await prisma.groupMessageReadCursor.findMany({
      where: { userId: auth.userId, groupId: { in: groupIds } },
      select: { groupId: true, lastReadMsgId: true },
    });
    const cursorMap = new Map(cursors.map((c) => [c.groupId, c.lastReadMsgId]));

    // Count unread messages per group
    const unreadCounts = await Promise.all(
      groupIds.map(async (groupId) => {
        const lastReadId = cursorMap.get(groupId);
        const count = await prisma.groupMessage.count({
          where: {
            groupId,
            isDeleted: false,
            ...(lastReadId ? { id: { gt: lastReadId } } : {}),
          },
        });

        // Get the latest message for preview
        const lastMessage = await prisma.groupMessage.findFirst({
          where: { groupId, isDeleted: false },
          orderBy: { id: 'desc' },
          select: {
            id: true,
            text: true,
            type: true,
            createdAt: true,
            sender: { select: { id: true, fullName: true, username: true } },
          },
        });

        return {
          groupId,
          unreadCount: count,
          lastMessage: lastMessage
            ? {
                id: lastMessage.id.toString(),
                text: lastMessage.text,
                type: lastMessage.type,
                createdAt: lastMessage.createdAt,
                sender: lastMessage.sender,
              }
            : null,
        };
      }),
    );

    res.json({ data: unreadCounts });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/group-chat/:groupId/messages ────────────────────────
// Cursor-based pagination (load older messages)
router.get('/:groupId/messages', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const groupId = req.params.groupId as string;

    const membership = await requireChatMembership(groupId, auth.userId, res);
    if (!membership) return;

    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 30));
    const cursor = req.query.cursor as string | undefined;

    const messages = await prisma.groupMessage.findMany({
      where: {
        groupId,
        ...(cursor ? { id: { lt: BigInt(cursor) } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit,
      include: {
        sender: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
        attachments: true,
        replyTo: {
          include: {
            sender: { select: { id: true, fullName: true, username: true } },
          },
        },
      },
    });

    const hasMore = messages.length === limit;
    const nextCursor = hasMore ? messages[messages.length - 1].id.toString() : null;

    res.json({
      data: messages.map((m) => ({
        ...m,
        id: m.id.toString(),
        replyToId: m.replyToId?.toString() || null,
        attachments: m.attachments.map((a) => ({ ...a, id: a.id.toString(), messageId: a.messageId.toString() })),
        replyTo: m.replyTo
          ? { ...m.replyTo, id: m.replyTo.id.toString(), replyToId: m.replyTo.replyToId?.toString() || null }
          : null,
      })),
      nextCursor,
      hasMore,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/group-chat/:groupId/messages ───────────────────────
// Send a text message (optionally reply to another)
router.post('/:groupId/messages', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const groupId = req.params.groupId as string;

    const membership = await requireChatMembership(groupId, auth.userId, res);
    if (!membership) return;

    const { text, replyToId, entities } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    if (text.length > 4000) {
      res.status(400).json({ error: 'Message text must be 4000 characters or fewer' });
      return;
    }

    // Validate entities if provided
    let validatedEntities: MessageEntity[] | null = null;
    if (entities) {
      validatedEntities = validateEntities(entities, text.trim().length);
      if (!validatedEntities) {
        res.status(400).json({ error: 'Invalid message entities' });
        return;
      }
    }

    // Validate replyToId if provided
    if (replyToId) {
      const parentMsg = await prisma.groupMessage.findFirst({
        where: { id: BigInt(replyToId), groupId },
      });
      if (!parentMsg) {
        res.status(400).json({ error: 'Replied message not found in this group' });
        return;
      }
    }

    const message = await prisma.groupMessage.create({
      data: {
        groupId,
        senderId: auth.userId,
        type: 'text',
        text: text.trim(),
        entities: validatedEntities as unknown as Prisma.InputJsonValue ?? undefined,
        replyToId: replyToId ? BigInt(replyToId) : null,
      },
      include: {
        sender: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
        replyTo: {
          include: {
            sender: { select: { id: true, fullName: true, username: true } },
          },
        },
      },
    });

    const responseMsg = {
      ...message,
      id: message.id.toString(),
      replyToId: message.replyToId?.toString() || null,
      attachments: [],
      replyTo: message.replyTo
        ? { ...message.replyTo, id: message.replyTo.id.toString(), replyToId: message.replyTo.replyToId?.toString() || null }
        : null,
    };

    // Get group name for notification
    const group = await prisma.group.findUnique({ where: { id: groupId }, select: { name: true } });
    notifyGroupMembers(groupId, auth.userId, message.sender.fullName, group?.name || 'Group', text.trim().slice(0, 100), responseMsg);

    res.status(201).json(responseMsg);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/group-chat/:groupId/messages/attachment ────────────
// Send message with file attachments (images, videos, files)
router.post(
  '/:groupId/messages/attachment',
  chatUpload.array('files', MAX_ATTACHMENTS),
  async (req: Request, res: Response) => {
    try {
      const auth = (req as AuthenticatedRequest).auth!;
      const groupId = req.params.groupId as string;

      const membership = await requireChatMembership(groupId, auth.userId, res);
      if (!membership) return;

      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        res.status(400).json({ error: 'At least one file is required' });
        return;
      }

      const text = (req.body.text as string | undefined)?.trim() || null;
      if (text && text.length > 4000) {
        res.status(400).json({ error: 'Caption must be 4000 characters or fewer' });
        return;
      }
      const replyToId = req.body.replyToId as string | undefined;

      // Validate entities for caption
      let validatedEntities: MessageEntity[] | null = null;
      if (req.body.entities && text) {
        validatedEntities = validateEntities(
          typeof req.body.entities === 'string' ? JSON.parse(req.body.entities) : req.body.entities,
          text.length,
        );
      }

      if (replyToId) {
        const parentMsg = await prisma.groupMessage.findFirst({
          where: { id: BigInt(replyToId), groupId },
        });
        if (!parentMsg) {
          res.status(400).json({ error: 'Replied message not found in this group' });
          return;
        }
      }

      // Validate file sizes
      for (const file of files) {
        if (ALLOWED_IMAGE_TYPES.includes(file.mimetype) && file.size > MAX_IMAGE_SIZE) {
          res.status(400).json({ error: `Image ${file.originalname} exceeds 10 MB limit` });
          return;
        }
        if (ALLOWED_VIDEO_TYPES.includes(file.mimetype) && file.size > MAX_VIDEO_SIZE) {
          res.status(400).json({ error: `Video ${file.originalname} exceeds 50 MB limit` });
          return;
        }
      }

      // Determine message type from the first attachment
      const primaryType = detectMessageType(files[0].mimetype);

      const message = await prisma.$transaction(async (tx) => {
        const msg = await tx.groupMessage.create({
          data: {
            groupId,
            senderId: auth.userId,
            type: primaryType,
            text,
            entities: validatedEntities as unknown as Prisma.InputJsonValue ?? undefined,
            replyToId: replyToId ? BigInt(replyToId) : null,
          },
        });

        // Upload files and create attachment records
        const attachmentData = await Promise.all(
          files.map(async (file) => {
            const safeName = sanitizeFileName(file.originalname);
            const ext = safeName.split('.').pop() || 'bin';
            const objectKey = `chat/${groupId}/${msg.id}/${uuidv4()}.${ext}`;
            const url = await uploadFile(objectKey, file.buffer, file.mimetype);

            return {
              messageId: msg.id,
              url,
              fileName: safeName,
              fileSize: file.size,
              mimeType: file.mimetype,
            };
          }),
        );

        await tx.groupMessageAttachment.createMany({ data: attachmentData });

        return tx.groupMessage.findUnique({
          where: { id: msg.id },
          include: {
            sender: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
            attachments: true,
            replyTo: {
              include: {
                sender: { select: { id: true, fullName: true, username: true } },
              },
            },
          },
        });
      });

      if (!message) {
        res.status(500).json({ error: 'Failed to create message' });
        return;
      }

      const responseMsg = {
        ...message,
        id: message.id.toString(),
        replyToId: message.replyToId?.toString() || null,
        attachments: message.attachments.map((a) => ({ ...a, id: a.id.toString(), messageId: a.messageId.toString() })),
        replyTo: message.replyTo
          ? { ...message.replyTo, id: message.replyTo.id.toString(), replyToId: message.replyTo.replyToId?.toString() || null }
          : null,
      };

      const group = await prisma.group.findUnique({ where: { id: groupId }, select: { name: true } });
      const previewText = text || `Sent ${files.length} ${primaryType}(s)`;
      notifyGroupMembers(groupId, auth.userId, message.sender.fullName, group?.name || 'Group', previewText.slice(0, 100), responseMsg);

      res.status(201).json(responseMsg);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },
);

// ── PUT /api/group-chat/:groupId/messages/:messageId ─────────────
// Edit a message (sender only, text only)
router.put('/:groupId/messages/:messageId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const groupId = req.params.groupId as string;
    const messageId = req.params.messageId as string;

    const membership = await requireChatMembership(groupId, auth.userId, res);
    if (!membership) return;

    const { text, entities } = req.body;
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    if (text.length > 4000) {
      res.status(400).json({ error: 'Message text must be 4000 characters or fewer' });
      return;
    }

    // Validate entities if provided
    let validatedEntities: MessageEntity[] | null | undefined = undefined;
    if (entities !== undefined) {
      if (entities === null) {
        validatedEntities = null;
      } else {
        validatedEntities = validateEntities(entities, text.trim().length);
        if (!validatedEntities) {
          res.status(400).json({ error: 'Invalid message entities' });
          return;
        }
      }
    }

    const message = await prisma.groupMessage.findFirst({
      where: { id: BigInt(messageId), groupId },
    });
    if (!message) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    if (message.senderId !== auth.userId) {
      res.status(403).json({ error: 'You can only edit your own messages' });
      return;
    }
    if (message.isDeleted) {
      res.status(400).json({ error: 'Cannot edit a deleted message' });
      return;
    }

    const updated = await prisma.groupMessage.update({
      where: { id: message.id },
      data: {
        text: text.trim(),
        isEdited: true,
        ...(validatedEntities !== undefined
          ? { entities: validatedEntities === null ? Prisma.JsonNull : (validatedEntities as unknown as Prisma.InputJsonValue) }
          : {}),
      },
      include: {
        sender: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
        attachments: true,
        replyTo: {
          include: {
            sender: { select: { id: true, fullName: true, username: true } },
          },
        },
      },
    });

    const responseMsg = {
      ...updated,
      id: updated.id.toString(),
      replyToId: updated.replyToId?.toString() || null,
      attachments: updated.attachments.map((a) => ({ ...a, id: a.id.toString(), messageId: a.messageId.toString() })),
      replyTo: updated.replyTo
        ? { ...updated.replyTo, id: updated.replyTo.id.toString(), replyToId: updated.replyTo.replyToId?.toString() || null }
        : null,
    };

    // Notify members about the edit via WebSocket
    emitGroupMessageEdited(groupId, responseMsg);

    res.json(responseMsg);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE /api/group-chat/:groupId/messages/:messageId ──────────
// Soft-delete a message (sender or group owner/teacher)
router.delete('/:groupId/messages/:messageId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const groupId = req.params.groupId as string;
    const messageId = req.params.messageId as string;

    const membership = await requireChatMembership(groupId, auth.userId, res);
    if (!membership) return;

    const message = await prisma.groupMessage.findFirst({
      where: { id: BigInt(messageId), groupId },
    });
    if (!message) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    if (message.isDeleted) {
      res.status(400).json({ error: 'Message already deleted' });
      return;
    }

    // Sender can delete own messages; owner/teacher can delete anyone's
    const canDelete =
      message.senderId === auth.userId ||
      membership.role === 'owner' ||
      membership.role === 'teacher';

    if (!canDelete) {
      res.status(403).json({ error: 'You do not have permission to delete this message' });
      return;
    }

    await prisma.groupMessage.update({
      where: { id: message.id },
      data: { isDeleted: true, text: null },
    });

    emitGroupMessageDeleted(groupId, message.id.toString());

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/group-chat/:groupId/messages/search ─────────────────
// Search messages in a group
router.get('/:groupId/messages/search', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const groupId = req.params.groupId as string;

    const membership = await requireChatMembership(groupId, auth.userId, res);
    if (!membership) return;

    const q = (req.query.q as string || '').trim();
    if (!q || q.length < 2) {
      res.status(400).json({ error: 'Search query must be at least 2 characters' });
      return;
    }

    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));

    const messages = await prisma.groupMessage.findMany({
      where: {
        groupId,
        isDeleted: false,
        text: { contains: q, mode: 'insensitive' },
      },
      orderBy: { id: 'desc' },
      take: limit,
      include: {
        sender: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
        attachments: true,
      },
    });

    res.json(
      messages.map((m) => ({
        ...m,
        id: m.id.toString(),
        replyToId: m.replyToId?.toString() || null,
        attachments: m.attachments.map((a) => ({ ...a, id: a.id.toString(), messageId: a.messageId.toString() })),
      })),
    );
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/group-chat/:groupId/messages/:messageId ─────────────
// Get a single message by ID
router.get('/:groupId/messages/:messageId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const groupId = req.params.groupId as string;
    const messageId = req.params.messageId as string;

    const membership = await requireChatMembership(groupId, auth.userId, res);
    if (!membership) return;

    const message = await prisma.groupMessage.findFirst({
      where: { id: BigInt(messageId), groupId },
      include: {
        sender: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
        attachments: true,
        replyTo: {
          include: {
            sender: { select: { id: true, fullName: true, username: true } },
          },
        },
      },
    });

    if (!message) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    res.json({
      ...message,
      id: message.id.toString(),
      replyToId: message.replyToId?.toString() || null,
      attachments: message.attachments.map((a) => ({ ...a, id: a.id.toString(), messageId: a.messageId.toString() })),
      replyTo: message.replyTo
        ? { ...message.replyTo, id: message.replyTo.id.toString(), replyToId: message.replyTo.replyToId?.toString() || null }
        : null,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/group-chat/:groupId/media ───────────────────────────
// List media messages (images/videos) — gallery view
router.get('/:groupId/media', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const groupId = req.params.groupId as string;

    const membership = await requireChatMembership(groupId, auth.userId, res);
    if (!membership) return;

    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 30));
    const cursor = req.query.cursor as string | undefined;

    const attachments = await prisma.groupMessageAttachment.findMany({
      where: {
        message: { groupId, isDeleted: false, type: { in: ['image', 'video'] } },
        ...(cursor ? { id: { lt: BigInt(cursor) } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit,
      include: {
        message: {
          select: {
            id: true,
            senderId: true,
            type: true,
            createdAt: true,
            sender: { select: { id: true, fullName: true, username: true } },
          },
        },
      },
    });

    const hasMore = attachments.length === limit;
    const nextCursor = hasMore ? attachments[attachments.length - 1].id.toString() : null;

    res.json({
      data: attachments.map((a) => ({
        ...a,
        id: a.id.toString(),
        messageId: a.messageId.toString(),
        message: { ...a.message, id: a.message.id.toString() },
      })),
      nextCursor,
      hasMore,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/group-chat/:groupId/files ───────────────────────────
// List file attachments (non-media)
router.get('/:groupId/files', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const groupId = req.params.groupId as string;

    const membership = await requireChatMembership(groupId, auth.userId, res);
    if (!membership) return;

    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 30));
    const cursor = req.query.cursor as string | undefined;

    const attachments = await prisma.groupMessageAttachment.findMany({
      where: {
        message: { groupId, isDeleted: false, type: 'file' },
        ...(cursor ? { id: { lt: BigInt(cursor) } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit,
      include: {
        message: {
          select: {
            id: true,
            senderId: true,
            createdAt: true,
            sender: { select: { id: true, fullName: true, username: true } },
          },
        },
      },
    });

    const hasMore = attachments.length === limit;
    const nextCursor = hasMore ? attachments[attachments.length - 1].id.toString() : null;

    res.json({
      data: attachments.map((a) => ({
        ...a,
        id: a.id.toString(),
        messageId: a.messageId.toString(),
        message: { ...a.message, id: a.message.id.toString() },
      })),
      nextCursor,
      hasMore,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/group-chat/:groupId/read ────────────────────────────
// Mark messages as read up to a given message ID
router.post('/:groupId/read', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const groupId = req.params.groupId as string;

    const membership = await requireChatMembership(groupId, auth.userId, res);
    if (!membership) return;

    const { lastMessageId } = req.body;
    if (!lastMessageId || typeof lastMessageId !== 'string') {
      res.status(400).json({ error: 'lastMessageId is required' });
      return;
    }

    // Verify the message exists in this group
    const msg = await prisma.groupMessage.findFirst({
      where: { id: BigInt(lastMessageId), groupId },
      select: { id: true },
    });
    if (!msg) {
      res.status(400).json({ error: 'Message not found in this group' });
      return;
    }

    await prisma.groupMessageReadCursor.upsert({
      where: { groupId_userId: { groupId, userId: auth.userId } },
      create: { groupId, userId: auth.userId, lastReadMsgId: msg.id },
      update: { lastReadMsgId: msg.id },
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
