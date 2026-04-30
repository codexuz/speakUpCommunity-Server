import { Request, Response, Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest, authenticateRequest } from '../middleware/auth';
import prisma from '../prisma';
import { uploadImage, uploadRawVideo } from '../services/minio';
import { enqueueVideoJob } from '../services/queue';

const router = Router();
router.use(authenticateRequest);

// Accept up to 4 images OR 1 video per thread post
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
  fileFilter(_req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm'];
    cb(null, allowed.includes(file.mimetype));
  },
});

const AUTHOR_SELECT = {
  id: true,
  username: true,
  fullName: true,
  avatarUrl: true,
  verifiedTeacher: true,
};

/** Shape a thread record for API responses */
function formatThread(thread: any, viewerId: string) {
  return {
    id: thread.id.toString(),
    author: thread.author,
    text: thread.text,
    media: (thread.media ?? []).map((m: any) => ({
      id: m.id.toString(),
      type: m.type,
      url: m.url,
      thumbnailUrl: m.thumbnailUrl ?? null,
      width: m.width,
      height: m.height,
      durationSecs: m.durationSecs,
      mimeType: m.mimeType,
      order: m.order,
    })),
    parentId: thread.parentId?.toString() ?? null,
    rootId: thread.rootId?.toString() ?? null,
    visibility: thread.visibility,
    likesCount: thread.likesCount,
    repliesCount: thread.repliesCount,
    savesCount: thread.savesCount,
    likedByMe: thread.likes?.some((l: any) => l.userId === viewerId) ?? false,
    savedByMe: (thread.saves ?? []).some((s: any) => s.userId === viewerId),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function parsePaging(req: Request) {
  const cursor = req.query.cursor ? BigInt(req.query.cursor as string) : undefined;
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
  return { cursor, limit };
}

const THREAD_INCLUDE = (userId: string) => ({
  author: { select: AUTHOR_SELECT },
  media: { orderBy: { order: 'asc' as const } },
  likes: { where: { userId }, select: { userId: true } },
  saves: { where: { userId }, select: { userId: true } },
});

// ─── POST /api/threads ──────────────────────────────────────────
// Create a new thread with optional media
router.post('/', upload.array('media', 4), async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const { text, visibility = 'public' } = req.body as {
      text?: string;
      visibility?: 'public' | 'followers';
    };

    if (!text?.trim() && (!req.files || (req.files as Express.Multer.File[]).length === 0)) {
      res.status(400).json({ error: 'Thread must have text or media' });
      return;
    }

    const files = (req.files as Express.Multer.File[]) ?? [];

    // Validate: at most 1 video
    const videoFiles = files.filter((f) => f.mimetype.startsWith('video/'));
    if (videoFiles.length > 1) {
      res.status(400).json({ error: 'Only one video per thread is allowed' });
      return;
    }
    if (videoFiles.length === 1 && files.length > 1) {
      res.status(400).json({ error: 'Cannot mix video with other media' });
      return;
    }
    const imageFiles = files.filter((f) => f.mimetype.startsWith('image/'));
    if (imageFiles.length > 4) {
      res.status(400).json({ error: 'Maximum 4 images per thread' });
      return;
    }

    // Upload media (images immediately; videos as raw temp → enqueue compression)
    const mediaPayloads: Array<{
      type: 'image' | 'video';
      url: string;
      thumbnailUrl?: string;
      durationSecs?: number;
      sizeBytes: number;
      mimeType: string;
      order: number;
    }> = [];
    const videoPendingItems: Array<{ rawObjectKey: string; ext: string; payloadIndex: number }> = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = (file.originalname.split('.').pop() ?? 'bin').toLowerCase();
      const id = uuidv4();

      if (file.mimetype.startsWith('video/')) {
        const rawObjectKey = `threads/tmp/${id}.${ext}`;
        await uploadRawVideo(rawObjectKey, file.buffer, file.mimetype);
        mediaPayloads.push({
          type: 'video',
          url: '',          // filled in after DB insert
          sizeBytes: file.size,
          mimeType: file.mimetype,
          order: i,
        });
        videoPendingItems.push({ rawObjectKey, ext, payloadIndex: mediaPayloads.length - 1 });
      } else {
        const url = await uploadImage(`threads/${id}.${ext}`, file.buffer, file.mimetype);
        mediaPayloads.push({
          type: 'image',
          url,
          sizeBytes: file.size,
          mimeType: file.mimetype,
          order: i,
        });
      }
    }

    const thread = await prisma.thread.create({
      data: {
        authorId: auth.userId,
        text: text?.trim() || null,
        visibility: visibility as any,
        media: {
          create: mediaPayloads,
        },
      },
      include: THREAD_INCLUDE(auth.userId),
    });

    // Enqueue compression jobs for any video media
    for (const pending of videoPendingItems) {
      const mediaRow = thread.media[pending.payloadIndex];
      await enqueueVideoJob({
        mediaId: mediaRow.id.toString(),
        userId: auth.userId,
        rawObjectKey: pending.rawObjectKey,
        ext: pending.ext,
      });
    }

    const formatted = formatThread(thread, auth.userId);
    // Mark video items as still processing so the client knows to listen on SSE
    for (const pending of videoPendingItems) {
      formatted.media[pending.payloadIndex].processing = true;
    }

    res.status(201).json(formatted);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/threads/:id/reply ────────────────────────────────
// Reply to a thread
router.post('/:id/reply', upload.array('media', 4), async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const parentId = BigInt(req.params.id as string);
    const { text, visibility = 'public' } = req.body as {
      text?: string;
      visibility?: 'public' | 'followers';
    };

    const files = (req.files as Express.Multer.File[]) ?? [];

    if (!text?.trim() && files.length === 0) {
      res.status(400).json({ error: 'Reply must have text or media' });
      return;
    }

    const videoFiles = files.filter((f) => f.mimetype.startsWith('video/'));
    if (videoFiles.length > 1) {
      res.status(400).json({ error: 'Only one video per reply is allowed' });
      return;
    }
    if (videoFiles.length === 1 && files.length > 1) {
      res.status(400).json({ error: 'Cannot mix video with other media' });
      return;
    }

    const parent = await prisma.thread.findUnique({
      where: { id: parentId },
      select: { id: true, rootId: true, isDeleted: true },
    });
    if (!parent || parent.isDeleted) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const rootId = parent.rootId ?? parent.id;

    const mediaPayloads: Array<{
      type: 'image' | 'video';
      url: string;
      thumbnailUrl?: string;
      durationSecs?: number;
      sizeBytes: number;
      mimeType: string;
      order: number;
    }> = [];
    const videoPendingItems: Array<{ rawObjectKey: string; ext: string; payloadIndex: number }> = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = (file.originalname.split('.').pop() ?? 'bin').toLowerCase();
      const id = uuidv4();

      if (file.mimetype.startsWith('video/')) {
        const rawObjectKey = `threads/tmp/${id}.${ext}`;
        await uploadRawVideo(rawObjectKey, file.buffer, file.mimetype);
        mediaPayloads.push({ type: 'video', url: '', sizeBytes: file.size, mimeType: file.mimetype, order: i });
        videoPendingItems.push({ rawObjectKey, ext, payloadIndex: mediaPayloads.length - 1 });
      } else {
        const url = await uploadImage(`threads/${id}.${ext}`, file.buffer, file.mimetype);
        mediaPayloads.push({ type: 'image', url, sizeBytes: file.size, mimeType: file.mimetype, order: i });
      }
    }

    const [reply] = await prisma.$transaction([
      prisma.thread.create({
        data: {
          authorId: auth.userId,
          text: text?.trim() || null,
          parentId,
          rootId,
          visibility: visibility as any,
          media: { create: mediaPayloads },
        },
        include: THREAD_INCLUDE(auth.userId),
      }),
      prisma.thread.update({
        where: { id: parentId },
        data: { repliesCount: { increment: 1 } },
      }),
    ]);

    // Enqueue compression for any video in the reply
    for (const pending of videoPendingItems) {
      const mediaRow = reply.media[pending.payloadIndex];
      await enqueueVideoJob({
        mediaId: mediaRow.id.toString(),
        userId: auth.userId,
        rawObjectKey: pending.rawObjectKey,
        ext: pending.ext,
      });
    }

    const formatted = formatThread(reply, auth.userId);
    for (const pending of videoPendingItems) {
      formatted.media[pending.payloadIndex].processing = true;
    }

    res.status(201).json(formatted);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/threads/feed ──────────────────────────────────────
// Feed of threads from users the current user follows
router.get('/feed', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const { cursor, limit } = parsePaging(req);

    // Get list of followed user IDs
    const following = await prisma.userFollow.findMany({
      where: { followerId: auth.userId },
      select: { followingId: true },
    });
    const followingIds = following.map((f) => f.followingId);
    // Include own threads in feed
    followingIds.push(auth.userId);

    const threads = await prisma.thread.findMany({
      where: {
        authorId: { in: followingIds },
        parentId: null, // root-level only
        isDeleted: false,
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit,
      include: THREAD_INCLUDE(auth.userId),
    });

    const nextCursor = threads.length === limit ? threads[threads.length - 1].id.toString() : null;

    res.json({
      threads: threads.map((t) => formatThread(t, auth.userId)),
      nextCursor,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/threads/discover ──────────────────────────────────
// Public discovery feed — all public root threads
router.get('/discover', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const { cursor, limit } = parsePaging(req);

    const threads = await prisma.thread.findMany({
      where: {
        visibility: 'public',
        parentId: null,
        isDeleted: false,
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit,
      include: THREAD_INCLUDE(auth.userId),
    });

    const nextCursor = threads.length === limit ? threads[threads.length - 1].id.toString() : null;

    res.json({
      threads: threads.map((t) => formatThread(t, auth.userId)),
      nextCursor,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/threads/user/:userId ──────────────────────────────
// All root threads by a specific user
router.get('/user/:userId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const targetUserId = req.params.userId as string;
    const { cursor, limit } = parsePaging(req);

    const isOwnProfile = auth.userId === targetUserId;
    let isFollowing = false;
    if (!isOwnProfile) {
      const follow = await prisma.userFollow.findUnique({
        where: { followerId_followingId: { followerId: auth.userId, followingId: targetUserId } },
      });
      isFollowing = !!follow;
    }

    const visibilityFilter: any = isOwnProfile
      ? {}
      : isFollowing
      ? { visibility: { in: ['public', 'followers'] } }
      : { visibility: 'public' };

    const threads = await prisma.thread.findMany({
      where: {
        authorId: targetUserId,
        parentId: null,
        isDeleted: false,
        ...visibilityFilter,
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit,
      include: THREAD_INCLUDE(auth.userId),
    });

    const nextCursor = threads.length === limit ? threads[threads.length - 1].id.toString() : null;

    res.json({
      threads: threads.map((t) => formatThread(t, auth.userId)),
      nextCursor,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/threads/:id ───────────────────────────────────────
// Single thread detail
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const id = BigInt(req.params.id as string);

    const thread = await prisma.thread.findUnique({
      where: { id },
      include: THREAD_INCLUDE(auth.userId),
    });

    if (!thread || thread.isDeleted) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    // Visibility check
    if (thread.visibility === 'followers' && thread.authorId !== auth.userId) {
      const follow = await prisma.userFollow.findUnique({
        where: { followerId_followingId: { followerId: auth.userId, followingId: thread.authorId } },
      });
      if (!follow) {
        res.status(403).json({ error: 'This thread is only visible to followers' });
        return;
      }
    }

    res.json(formatThread(thread, auth.userId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/threads/:id/replies ──────────────────────────────
// Paginated replies to a thread
router.get('/:id/replies', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const parentId = BigInt(req.params.id as string);
    const { cursor, limit } = parsePaging(req);

    const replies = await prisma.thread.findMany({
      where: {
        parentId,
        isDeleted: false,
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit,
      include: THREAD_INCLUDE(auth.userId),
    });

    const nextCursor = replies.length === limit ? replies[replies.length - 1].id.toString() : null;

    res.json({
      replies: replies.map((t) => formatThread(t, auth.userId)),
      nextCursor,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/threads/:id/like ─────────────────────────────────
// Toggle like on a thread
router.post('/:id/like', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const threadId = BigInt(req.params.id as string);

    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { id: true, isDeleted: true },
    });
    if (!thread || thread.isDeleted) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const existing = await prisma.threadLike.findUnique({
      where: { threadId_userId: { threadId, userId: auth.userId } },
    });

    if (existing) {
      await prisma.$transaction([
        prisma.threadLike.delete({ where: { threadId_userId: { threadId, userId: auth.userId } } }),
        prisma.thread.update({ where: { id: threadId }, data: { likesCount: { decrement: 1 } } }),
      ]);
      res.json({ liked: false });
    } else {
      await prisma.$transaction([
        prisma.threadLike.create({ data: { threadId, userId: auth.userId } }),
        prisma.thread.update({ where: { id: threadId }, data: { likesCount: { increment: 1 } } }),
      ]);
      res.json({ liked: true });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/threads/saved ─────────────────────────────────────
// List threads saved by the current user
router.get('/saved', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const { cursor, limit } = parsePaging(req);

    const saves = await prisma.threadSave.findMany({
      where: {
        userId: auth.userId,
        ...(cursor ? { id: { lt: BigInt(cursor) } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        thread: { include: THREAD_INCLUDE(auth.userId) },
      },
    });

    const nextCursor = saves.length === limit ? saves[saves.length - 1].id.toString() : null;

    res.json({
      threads: saves
        .filter((s) => !s.thread.isDeleted)
        .map((s) => formatThread(s.thread, auth.userId)),
      nextCursor,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/threads/:id/save ──────────────────────────────────
// Toggle save (bookmark) on a thread
router.post('/:id/save', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const threadId = BigInt(req.params.id as string);

    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { id: true, isDeleted: true },
    });
    if (!thread || thread.isDeleted) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const existing = await prisma.threadSave.findUnique({
      where: { threadId_userId: { threadId, userId: auth.userId } },
    });

    if (existing) {
      await prisma.$transaction([
        prisma.threadSave.delete({ where: { threadId_userId: { threadId, userId: auth.userId } } }),
        prisma.thread.update({ where: { id: threadId }, data: { savesCount: { decrement: 1 } } }),
      ]);
      res.json({ saved: false });
    } else {
      await prisma.$transaction([
        prisma.threadSave.create({ data: { threadId, userId: auth.userId } }),
        prisma.thread.update({ where: { id: threadId }, data: { savesCount: { increment: 1 } } }),
      ]);
      res.json({ saved: true });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/threads/:id ─────────────────────────────────────
// Edit a thread or reply — author only
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const threadId = BigInt(req.params.id as string);
    const { text, visibility } = req.body as {
      text?: string;
      visibility?: 'public' | 'followers';
    };

    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { id: true, authorId: true, isDeleted: true, media: { select: { id: true } } },
    });

    if (!thread || thread.isDeleted) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }
    if (thread.authorId !== auth.userId) {
      res.status(403).json({ error: 'Not authorised' });
      return;
    }

    const trimmedText = text?.trim();
    if (trimmedText === '' && thread.media.length === 0) {
      res.status(400).json({ error: 'Thread must have text or media' });
      return;
    }

    const updates: Record<string, any> = {};
    if (text !== undefined) updates.text = trimmedText || null;
    if (visibility !== undefined) updates.visibility = visibility;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No editable fields provided' });
      return;
    }

    const updated = await prisma.thread.update({
      where: { id: threadId },
      data: updates,
      include: THREAD_INCLUDE(auth.userId),
    });

    res.json(formatThread(updated, auth.userId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/threads/:id ─────────────────────────────────────
// Soft-delete a thread or reply (author only; admin can also delete any).
// When a reply is deleted: parent repliesCount is decremented and all
// likes on the deleted node are removed to keep denormalised counts accurate.
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const threadId = BigInt(req.params.id as string);

    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { id: true, authorId: true, isDeleted: true, parentId: true },
    });

    if (!thread || thread.isDeleted) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }
    if (thread.authorId !== auth.userId && auth.role !== 'admin') {
      res.status(403).json({ error: 'Not authorised' });
      return;
    }

    const ops: any[] = [
      prisma.thread.update({
        where: { id: threadId },
        data: { isDeleted: true, text: null, likesCount: 0 },
      }),
      // Remove likes on the soft-deleted node so the count stays clean
      prisma.threadLike.deleteMany({ where: { threadId } }),
    ];

    // Keep parent repliesCount in sync when a reply is deleted
    if (thread.parentId) {
      ops.push(
        prisma.thread.update({
          where: { id: thread.parentId },
          data: { repliesCount: { decrement: 1 } },
        }),
      );
    }

    await prisma.$transaction(ops);

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/threads/:id/report ───────────────────────────────
// Report a thread or reply for moderation; one report per user per thread
router.post('/:id/report', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const threadId = BigInt(req.params.id as string);
    const { reason } = req.body as { reason?: string };

    if (!reason?.trim()) {
      res.status(400).json({ error: 'A reason is required' });
      return;
    }

    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { id: true, isDeleted: true, authorId: true },
    });
    if (!thread || thread.isDeleted) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }
    if (thread.authorId === auth.userId) {
      res.status(400).json({ error: 'Cannot report your own thread' });
      return;
    }

    const existing = await prisma.threadReport.findUnique({
      where: { threadId_userId: { threadId, userId: auth.userId } },
    });
    if (existing) {
      res.status(409).json({ error: 'Already reported' });
      return;
    }

    await prisma.threadReport.create({
      data: { threadId, userId: auth.userId, reason: reason.trim() },
    });

    res.status(201).json({ reported: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/threads/:id/report ─────────────────────────────
// Retract a previously submitted report (reporter only)
router.delete('/:id/report', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const threadId = BigInt(req.params.id as string);

    const report = await prisma.threadReport.findUnique({
      where: { threadId_userId: { threadId, userId: auth.userId } },
    });
    if (!report) {
      res.status(404).json({ error: 'Report not found' });
      return;
    }

    await prisma.threadReport.delete({
      where: { threadId_userId: { threadId, userId: auth.userId } },
    });

    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
