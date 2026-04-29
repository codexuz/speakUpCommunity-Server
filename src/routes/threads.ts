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
    repostsCount: thread.repostsCount,
    likedByMe: thread.likes?.some((l: any) => l.userId === viewerId) ?? false,
    repostedByMe: thread.reposts?.some((r: any) => r.userId === viewerId) ?? false,
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
  reposts: { where: { userId }, select: { userId: true } },
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

// ─── POST /api/threads/:id/repost ───────────────────────────────
// Toggle repost (optionally with quote text)
router.post('/:id/repost', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const threadId = BigInt(req.params.id as string);
    const { quoteText } = req.body as { quoteText?: string };

    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { id: true, isDeleted: true, authorId: true },
    });
    if (!thread || thread.isDeleted) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }
    if (thread.authorId === auth.userId) {
      res.status(400).json({ error: 'Cannot repost your own thread' });
      return;
    }

    const existing = await prisma.threadRepost.findUnique({
      where: { threadId_userId: { threadId, userId: auth.userId } },
    });

    if (existing) {
      await prisma.$transaction([
        prisma.threadRepost.delete({ where: { threadId_userId: { threadId, userId: auth.userId } } }),
        prisma.thread.update({ where: { id: threadId }, data: { repostsCount: { decrement: 1 } } }),
      ]);
      res.json({ reposted: false });
    } else {
      await prisma.$transaction([
        prisma.threadRepost.create({
          data: { threadId, userId: auth.userId, quoteText: quoteText?.trim() || null },
        }),
        prisma.thread.update({ where: { id: threadId }, data: { repostsCount: { increment: 1 } } }),
      ]);
      res.json({ reposted: true });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/threads/:id ────────────────────────────────────
// Soft-delete a thread (author only; admin can also hard-delete)
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const threadId = BigInt(req.params.id as string);

    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { id: true, authorId: true, isDeleted: true },
    });

    if (!thread || thread.isDeleted) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    if (thread.authorId !== auth.userId && auth.role !== 'admin') {
      res.status(403).json({ error: 'Not authorised' });
      return;
    }

    await prisma.thread.update({
      where: { id: threadId },
      data: { isDeleted: true, text: null },
    });

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
