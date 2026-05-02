import { Request, Response, Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest, authenticateRequest } from '../middleware/auth';
import prisma from '../prisma';
import { sendPushNotification } from '../notifications';
import { uploadImage, uploadRawVideo, uploadFile, deleteMediaFromUrl, getImageDimensions } from '../services/minio';
import { enqueueVideoJob } from '../services/queue';

const router = Router();
router.use(authenticateRequest);

/**
 * Multer instance used for thread media uploads.
 *
 * Accepted form-data fields:
 *   - `media`  — up to 4 images (jpeg/png/webp/gif) OR 1 video (mp4/mov/mkv/webm)
 *   - `files`  — up to 5 generic file attachments:
 *                  PDF, Word (.doc/.docx), plain text, ZIP,
 *                  audio (mp3/wav/ogg/aac/m4a), or any other non-image/video mime
 *
 * Individual file size limit: 200 MB.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB per file
  fileFilter(_req, file, cb) {
    const allowed = [
      // Images
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      // Videos
      'video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm',
      // Documents
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      // Audio
      'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4', 'audio/aac',
      // Misc
      'text/plain', 'application/zip', 'application/x-zip-compressed',
    ];
    cb(null, allowed.includes(file.mimetype));
  },
});

/**
 * Multer fields config:
 *  - `media` — images / videos (max 4 files)
 *  - `files` — generic file attachments (max 5 files)
 */
const uploadFields = upload.fields([
  { name: 'media', maxCount: 4 },
  { name: 'files', maxCount: 5 },
]);

const AUTHOR_SELECT = {
  id: true,
  username: true,
  fullName: true,
  avatarUrl: true,
  verifiedTeacher: true,
};

/** Shape a thread record for API responses.
 *
 * `media` — images and videos only (type: 'image' | 'video')
 * `files` — generic file attachments (type: 'file')
 */
function formatThread(thread: any, viewerId: string) {
  const allMedia: any[] = thread.media ?? [];

  const media = allMedia
    .map((m: any) => ({
      id: m.id.toString(),
      type: m.type,
      url: m.url,
      thumbnailUrl: m.thumbnailUrl ?? null,
      width: m.width,
      height: m.height,
      durationSecs: m.durationSecs,
      mimeType: m.mimeType,
      order: m.order,
    } as any));

  const files = (thread.files ?? [])
    .map((m: any) => ({
      id: m.id.toString(),
      url: m.url,
      fileName: m.fileName ?? null,
      mimeType: m.mimeType,
      sizeBytes: m.sizeBytes,
      order: m.order,
    } as any));

  return {
    id: thread.id.toString(),
    author: thread.author,
    text: thread.text,
    media,
    files,
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
  let cursor: bigint | undefined;
  if (req.query.cursor) {
    try {
      cursor = BigInt(req.query.cursor as string);
    } catch {
      cursor = undefined;
    }
  }
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
  return { cursor, limit };
}

type FeedFilter = 'new' | 'top_liked' | 'top_commented';

function parseFilter(req: Request): { filter: FeedFilter; offset: number } {
  const raw = (req.query.filter as string || '').toLowerCase();
  const filter: FeedFilter = (['top_liked', 'top_commented'].includes(raw) ? raw : 'new') as FeedFilter;
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  return { filter, offset };
}

const THREAD_INCLUDE = (userId: string) => ({
  author: { select: AUTHOR_SELECT },
  media: { orderBy: { order: 'asc' as const } },
  files: { orderBy: { order: 'asc' as const } },
  likes: { where: { userId }, select: { userId: true } },
  saves: { where: { userId }, select: { userId: true } },
});

// ─── POST /api/threads ──────────────────────────────────────────
// Create a new thread with optional media (images/videos) and/or file attachments
router.post('/', uploadFields, async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const { text, visibility = 'public' } = req.body as {
      text?: string;
      visibility?: 'public' | 'followers';
    };

    const fieldFiles = req.files as Record<string, Express.Multer.File[]> | undefined;
    const mediaFiles = fieldFiles?.['media'] ?? [];
    const attachmentFiles = fieldFiles?.['files'] ?? [];
    const allFiles = [...mediaFiles, ...attachmentFiles];

    if (!text?.trim() && allFiles.length === 0) {
      res.status(400).json({ error: 'Thread must have text or media' });
      return;
    }

    // Validate media field: at most 1 video, max 4 images, no mixing
    const videoFiles = mediaFiles.filter((f) => f.mimetype.startsWith('video/'));
    if (videoFiles.length > 1) {
      res.status(400).json({ error: 'Only one video per thread is allowed' });
      return;
    }
    if (videoFiles.length === 1 && mediaFiles.length > 1) {
      res.status(400).json({ error: 'Cannot mix video with other media' });
      return;
    }
    const imageFiles = mediaFiles.filter((f) => f.mimetype.startsWith('image/'));
    if (imageFiles.length > 4) {
      res.status(400).json({ error: 'Maximum 4 images per thread' });
      return;
    }
    if (attachmentFiles.length > 5) {
      res.status(400).json({ error: 'Maximum 5 file attachments per thread' });
      return;
    }

    // Upload media (images immediately; videos as raw temp → enqueue compression)
    const mediaPayloads: Array<{
      type: 'image' | 'video';
      url: string;
      thumbnailUrl?: string;
      durationSecs?: number;
      width?: number;
      height?: number;
      sizeBytes: number;
      mimeType: string;
      order: number;
    }> = [];
    const videoPendingItems: Array<{ rawObjectKey: string; ext: string; payloadIndex: number }> = [];

    // Process media files (images & videos) first
    for (let i = 0; i < mediaFiles.length; i++) {
      const file = mediaFiles[i];
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
      } else if (file.mimetype.startsWith('image/')) {
        const url = await uploadImage(`threads/${id}.${ext}`, file.buffer, file.mimetype);
        const { width, height } = await getImageDimensions(file.buffer, ext);
        mediaPayloads.push({
          type: 'image',
          url,
          width: width || undefined,
          height: height || undefined,
          sizeBytes: file.size,
          mimeType: file.mimetype,
          order: i,
        });
      }
    }

    // Process file attachments (documents, audio, zip, etc.)
    const filePayloads: Array<{
      type: 'file';
      url: string;
      fileName?: string;
      sizeBytes: number;
      mimeType: string;
      order: number;
    }> = [];

    for (let i = 0; i < attachmentFiles.length; i++) {
      const file = attachmentFiles[i];
      const ext = (file.originalname.split('.').pop() ?? 'bin').toLowerCase();
      const id = uuidv4();
      const url = await uploadFile(`threads/files/${id}.${ext}`, file.buffer, file.mimetype);
      filePayloads.push({
        type: 'file',
        url,
        fileName: file.originalname,
        sizeBytes: file.size,
        mimeType: file.mimetype,
        order: mediaFiles.length + i, // files come after media in order
      });
    }

    const thread: any = await prisma.thread.create({
      data: {
        authorId: auth.userId,
        text: text?.trim() || null,
        visibility: visibility as any,
        media: {
          create: mediaPayloads as any,
        },
        files: {
          create: filePayloads as any,
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
// Reply to a thread with optional media and/or file attachments
router.post('/:id/reply', uploadFields, async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const parentId = BigInt(req.params.id as string);
    const { text, visibility = 'public' } = req.body as {
      text?: string;
      visibility?: 'public' | 'followers';
    };

    const replyFieldFiles = req.files as Record<string, Express.Multer.File[]> | undefined;
    const mediaFiles = replyFieldFiles?.['media'] ?? [];
    const attachmentFiles = replyFieldFiles?.['files'] ?? [];

    if (!text?.trim() && mediaFiles.length === 0 && attachmentFiles.length === 0) {
      res.status(400).json({ error: 'Reply must have text or media' });
      return;
    }

    const videoFiles = mediaFiles.filter((f) => f.mimetype.startsWith('video/'));
    if (videoFiles.length > 1) {
      res.status(400).json({ error: 'Only one video per reply is allowed' });
      return;
    }
    if (videoFiles.length === 1 && mediaFiles.length > 1) {
      res.status(400).json({ error: 'Cannot mix video with other media' });
      return;
    }
    if (attachmentFiles.length > 5) {
      res.status(400).json({ error: 'Maximum 5 file attachments per reply' });
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
      width?: number;
      height?: number;
      sizeBytes: number;
      mimeType: string;
      order: number;
    }> = [];
    const videoPendingItems: Array<{ rawObjectKey: string; ext: string; payloadIndex: number }> = [];

    // Process media files (images & videos)
    for (let i = 0; i < mediaFiles.length; i++) {
      const file = mediaFiles[i];
      const ext = (file.originalname.split('.').pop() ?? 'bin').toLowerCase();
      const id = uuidv4();

      if (file.mimetype.startsWith('video/')) {
        const rawObjectKey = `threads/tmp/${id}.${ext}`;
        await uploadRawVideo(rawObjectKey, file.buffer, file.mimetype);
        mediaPayloads.push({ type: 'video', url: '', sizeBytes: file.size, mimeType: file.mimetype, order: i });
        videoPendingItems.push({ rawObjectKey, ext, payloadIndex: mediaPayloads.length - 1 });
      } else if (file.mimetype.startsWith('image/')) {
        const url = await uploadImage(`threads/${id}.${ext}`, file.buffer, file.mimetype);
        const { width, height } = await getImageDimensions(file.buffer, ext);
        mediaPayloads.push({ type: 'image', url, width: width || undefined, height: height || undefined, sizeBytes: file.size, mimeType: file.mimetype, order: i });
      }
    }

    // Process file attachments (documents, audio, zip, etc.)
    const filePayloads: Array<{
      type: 'file';
      url: string;
      fileName?: string;
      sizeBytes: number;
      mimeType: string;
      order: number;
    }> = [];

    for (let i = 0; i < attachmentFiles.length; i++) {
      const file = attachmentFiles[i];
      const ext = (file.originalname.split('.').pop() ?? 'bin').toLowerCase();
      const id = uuidv4();
      const url = await uploadFile(`threads/files/${id}.${ext}`, file.buffer, file.mimetype);
      filePayloads.push({
        type: 'file',
        url,
        fileName: file.originalname,
        sizeBytes: file.size,
        mimeType: file.mimetype,
        order: mediaFiles.length + i,
      });
    }

    const [reply]: [any, any] = await prisma.$transaction([
      prisma.thread.create({
        data: {
          authorId: auth.userId,
          text: text?.trim() || null,
          parentId,
          rootId,
          visibility: visibility as any,
          media: { create: mediaPayloads as any },
          files: { create: filePayloads as any },
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

    // Push notification to parent thread author (skip if replying to own thread)
    if (parent && !parent.isDeleted) {
      const parentThread = await prisma.thread.findUnique({
        where: { id: parentId },
        select: { authorId: true, text: true },
      });
      if (parentThread && parentThread.authorId !== auth.userId) {
        const author = await prisma.user.findUnique({
          where: { id: parentThread.authorId },
          select: { pushToken: true },
        });
        if (author?.pushToken) {
          const preview = text?.trim().slice(0, 80) || '📷 Media';
          sendPushNotification(
            author.pushToken,
            `${auth.username} replied`,
            preview,
            { type: 'thread-reply', threadId: parentId.toString() },
          ).catch(() => { });
        }
      }
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/threads/feed ──────────────────────────────────────
// Feed of threads from users the current user follows
// Supports ?filter=new (default) | top_liked | top_commented
router.get('/feed', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const { cursor, limit } = parsePaging(req);
    const { filter, offset } = parseFilter(req);

    // Get list of followed user IDs
    const following = await prisma.userFollow.findMany({
      where: { followerId: auth.userId },
      select: { followingId: true },
    });
    const followingIds = following.map((f) => f.followingId);
    // Include own threads in feed
    followingIds.push(auth.userId);

    const baseWhere = {
      authorId: { in: followingIds },
      parentId: null, // root-level only
      isDeleted: false,
    };

    if (filter === 'new') {
      // Cursor-based pagination for chronological feed
      const threads = await prisma.thread.findMany({
        where: {
          ...baseWhere,
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
    } else {
      // Offset-based pagination for sorted feeds
      const orderBy = filter === 'top_liked'
        ? [{ likesCount: 'desc' as const }, { id: 'desc' as const }]
        : [{ repliesCount: 'desc' as const }, { id: 'desc' as const }];

      const threads = await prisma.thread.findMany({
        where: baseWhere,
        orderBy,
        skip: offset,
        take: limit,
        include: THREAD_INCLUDE(auth.userId),
      });

      const nextOffset = threads.length === limit ? offset + limit : null;

      res.json({
        threads: threads.map((t) => formatThread(t, auth.userId)),
        nextOffset,
      });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/threads/discover ──────────────────────────────────
// Public discovery feed — all public root threads
// Supports ?filter=new (default) | top_liked | top_commented
router.get('/discover', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const { cursor, limit } = parsePaging(req);
    const { filter, offset } = parseFilter(req);

    const baseWhere = {
      visibility: 'public' as const,
      parentId: null,
      isDeleted: false,
    };

    if (filter === 'new') {
      // Cursor-based pagination for chronological feed
      const threads = await prisma.thread.findMany({
        where: {
          ...baseWhere,
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
    } else {
      // Offset-based pagination for sorted feeds
      const orderBy = filter === 'top_liked'
        ? [{ likesCount: 'desc' as const }, { id: 'desc' as const }]
        : [{ repliesCount: 'desc' as const }, { id: 'desc' as const }];

      const threads = await prisma.thread.findMany({
        where: baseWhere,
        orderBy,
        skip: offset,
        take: limit,
        include: THREAD_INCLUDE(auth.userId),
      });

      const nextOffset = threads.length === limit ? offset + limit : null;

      res.json({
        threads: threads.map((t) => formatThread(t, auth.userId)),
        nextOffset,
      });
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
        ...(cursor ? { id: { lt: cursor } } : {}),
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

      // Push notification to thread author (skip self-like)
      const likedThread = await prisma.thread.findUnique({
        where: { id: threadId },
        select: { authorId: true, text: true },
      });
      if (likedThread && likedThread.authorId !== auth.userId) {
        const author = await prisma.user.findUnique({
          where: { id: likedThread.authorId },
          select: { pushToken: true },
        });
        if (author?.pushToken) {
          const preview = likedThread.text?.slice(0, 60) || 'your thread';
          sendPushNotification(
            author.pushToken,
            `${auth.username} liked your thread`,
            `❤️ ${preview}`,
            { type: 'thread-like', threadId: threadId.toString() },
          ).catch(() => { });
        }
      }
    }
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
      select: { id: true, authorId: true, isDeleted: true, media: { select: { id: true } }, files: { select: { id: true } } },
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
    if (trimmedText === '' && thread.media.length === 0 && thread.files.length === 0) {
      res.status(400).json({ error: 'Thread must have text or media/files' });
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
      select: {
        id: true,
        authorId: true,
        isDeleted: true,
        parentId: true,
        media: { select: { url: true, thumbnailUrl: true } },
        files: { select: { url: true } },
      },
    });

    if (!thread || thread.isDeleted) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }
    if (thread.authorId !== auth.userId && auth.role !== 'admin') {
      res.status(403).json({ error: 'Not authorised' });
      return;
    }

    // Delete media files from object storage
    if (thread.media && thread.media.length > 0) {
      for (const m of thread.media) {
        await deleteMediaFromUrl(m.url);
        if (m.thumbnailUrl) {
          await deleteMediaFromUrl(m.thumbnailUrl);
        }
      }
    }
    // Delete file attachments from object storage
    if (thread.files && thread.files.length > 0) {
      for (const f of thread.files) {
        await deleteMediaFromUrl(f.url);
      }
    }

    const ops: any[] = [
      prisma.thread.update({
        where: { id: threadId },
        data: { isDeleted: true, text: null, likesCount: 0 },
      }),
      // Remove likes on the soft-deleted node so the count stays clean
      prisma.threadLike.deleteMany({ where: { threadId } }),
      // Remove media/files records from DB since the objects are gone
      prisma.threadMedia.deleteMany({ where: { threadId } }),
      prisma.threadFile.deleteMany({ where: { threadId } }),
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
