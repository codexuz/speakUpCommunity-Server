import { Request, Response, Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import {
    AuthenticatedRequest,
    authenticateRequest,
    requireRole,
} from '../middleware/auth';
import { uploadLimiter } from '../middleware/rateLimiter';
import { sendPushNotification, sendPushToMultiple } from '../notifications';
import prisma from '../prisma';
import { uploadAudio } from '../services/minio';
import { enqueueAudioJob } from '../services/queue';
import { sseManager } from '../services/sse';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

router.use(authenticateRequest);

// ---------- SSE ----------

// GET /api/speaking/events — real-time event stream
router.get('/events', (req: Request, res: Response) => {
  const auth = (req as AuthenticatedRequest).auth!;
  const clientId = uuidv4();
  sseManager.addClient(clientId, auth.userId, res);
});

// ---------- List endpoints (before /:id) ----------

// GET /api/speaking/my — current user's submissions
router.get('/my', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const where = { studentId: auth.userId };
    const [responses, total] = await Promise.all([
      prisma.response.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          question: { select: { qText: true, part: true } },
        },
      }),
      prisma.response.count({ where }),
    ]);

    res.json({
      data: responses.map((r: any) => ({ ...r, id: r.id.toString() })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/speaking/pending — submissions without reviews (for teachers)
router.get('/pending', requireRole('teacher'), async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const where = { reviews: { none: {} } };
    const [responses, total] = await Promise.all([
      prisma.response.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          student: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
          question: { select: { qText: true, part: true } },
        },
      }),
      prisma.response.count({ where }),
    ]);

    res.json({
      data: responses.map((r: any) => ({ ...r, id: r.id.toString() })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- CRUD ----------

// POST /api/speaking — submit speaking with audio upload
router.post(
  '/',
  requireRole('student'),
  uploadLimiter,
  upload.single('audio'),
  async (req: Request, res: Response) => {
    try {
      const auth = (req as AuthenticatedRequest).auth!;
      const { questionId, visibility, groupId } = req.body;

      if (!questionId) {
        res.status(400).json({ error: 'questionId is required' });
        return;
      }

      const vis = ['private', 'group', 'community'].includes(visibility)
        ? visibility
        : 'private';

      let remoteUrl: string | null = null;
      let fileName: string | null = null;

      // Upload audio to MinIO
      if (req.file) {
        fileName = `${auth.userId}/${Date.now()}_${req.file.originalname || 'audio.m4a'}`;
        remoteUrl = await uploadAudio(
          fileName,
          req.file.buffer,
          req.file.mimetype || 'audio/m4a',
        );
      }

      const response = await prisma.response.create({
        data: {
          questionId: parseInt(questionId),
          studentId: auth.userId,
          remoteUrl,
          visibility: vis,
          groupId: groupId || null,
        },
        include: {
          student: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
          question: { select: { qText: true, part: true } },
        },
      });

      // Enqueue audio compression if file was uploaded
      if (fileName) {
        await enqueueAudioJob({
          responseId: response.id.toString(),
          fileName,
          userId: auth.userId,
        });
      }

      // SSE + push notify group members
      if (groupId) {
        const members = await prisma.groupMember.findMany({
          where: { groupId },
          select: { userId: true, user: { select: { pushToken: true } } },
        });

        const otherMemberIds = members
          .map((m) => m.userId)
          .filter((id) => id !== auth.userId);

        sseManager.sendToUsers(otherMemberIds, 'new-speaking', {
          id: response.id.toString(),
          studentName: response.student.fullName,
          question: response.question.qText.slice(0, 80),
        });

        const teacherTokens = members
          .filter(
            (m) =>
              m.userId !== auth.userId && m.user.pushToken,
          )
          .map((m) => m.user.pushToken!)
          .filter(Boolean);

        if (teacherTokens.length > 0) {
          await sendPushToMultiple(
            teacherTokens,
            'New Speaking Submission',
            `${response.student.fullName} submitted: "${response.question.qText.slice(0, 50)}..."`,
            { type: 'new_submission', responseId: response.id.toString() },
          );
        }
      }

      res.status(201).json({ ...response, id: response.id.toString() });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },
);

// GET /api/speaking/:id — single submission
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const response = await prisma.response.findUnique({
      where: { id: BigInt(req.params.id as string) },
      include: {
        student: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
        question: { select: { qText: true, part: true } },
        reviews: {
          include: { reviewer: { select: { id: true, fullName: true, avatarUrl: true } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!response) {
      res.status(404).json({ error: 'Speaking submission not found' });
      return;
    }

    // Visibility check
    if (response.visibility === 'private' && response.studentId !== auth.userId) {
      if (response.groupId) {
        const membership = await prisma.groupMember.findUnique({
          where: { groupId_userId: { groupId: response.groupId, userId: auth.userId } },
        });
        if (!membership || !['owner', 'teacher'].includes(membership.role)) {
          res.status(403).json({ error: 'This submission is private' });
          return;
        }
      } else {
        res.status(403).json({ error: 'This submission is private' });
        return;
      }
    } else if (response.visibility === 'group' && response.groupId) {
      if (response.studentId !== auth.userId) {
        const membership = await prisma.groupMember.findUnique({
          where: { groupId_userId: { groupId: response.groupId, userId: auth.userId } },
        });
        if (!membership) {
          res.status(403).json({ error: 'Only group members can view this' });
          return;
        }
      }
    }

    // Check if current user liked this
    const liked = await prisma.like.findUnique({
      where: { responseId_userId: { responseId: response.id, userId: auth.userId } },
    });

    res.json({
      ...response,
      id: response.id.toString(),
      isLiked: !!liked,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/speaking/:id — update (visibility)
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const existing = await prisma.response.findUnique({
      where: { id: BigInt(req.params.id as string) },
      select: { studentId: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (existing.studentId !== auth.userId) {
      res.status(403).json({ error: "Cannot edit others' submissions" });
      return;
    }

    const { visibility } = req.body;
    const updates: any = {};
    if (visibility && ['private', 'group', 'community'].includes(visibility)) {
      updates.visibility = visibility;
    }

    const response = await prisma.response.update({
      where: { id: BigInt(req.params.id as string) },
      data: updates,
    });

    res.json({ ...response, id: response.id.toString() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/speaking/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const existing = await prisma.response.findUnique({
      where: { id: BigInt(req.params.id as string) },
      select: { studentId: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (auth.role === 'student' && existing.studentId !== auth.userId) {
      res.status(403).json({ error: "Cannot delete others' submissions" });
      return;
    }

    await prisma.response.delete({ where: { id: BigInt(req.params.id as string) } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Likes ----------

// POST /api/speaking/:id/like
router.post('/:id/like', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const responseId = BigInt(req.params.id as string);

    const existing = await prisma.like.findUnique({
      where: { responseId_userId: { responseId, userId: auth.userId } },
    });
    if (existing) {
      res.status(409).json({ error: 'Already liked' });
      return;
    }

    await prisma.$transaction([
      prisma.like.create({ data: { responseId, userId: auth.userId } }),
      prisma.response.update({
        where: { id: responseId },
        data: { likes: { increment: 1 } },
      }),
    ]);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/speaking/:id/like
router.delete('/:id/like', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const responseId = BigInt(req.params.id as string);

    const existing = await prisma.like.findUnique({
      where: { responseId_userId: { responseId, userId: auth.userId } },
    });
    if (!existing) {
      res.status(404).json({ error: 'Not liked' });
      return;
    }

    await prisma.$transaction([
      prisma.like.delete({
        where: { responseId_userId: { responseId, userId: auth.userId } },
      }),
      prisma.response.update({
        where: { id: responseId },
        data: { likes: { decrement: 1 } },
      }),
    ]);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Comments ----------

// POST /api/speaking/:id/comment
router.post('/:id/comment', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const responseId = BigInt(req.params.id as string);
    const { text } = req.body;

    if (!text?.trim()) {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    const [comment] = await prisma.$transaction([
      prisma.comment.create({
        data: { responseId, userId: auth.userId, text: text.trim() },
        include: {
          user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
        },
      }),
      prisma.response.update({
        where: { id: responseId },
        data: { commentsCount: { increment: 1 } },
      }),
    ]);

    // Notify the speaker
    const speaking = await prisma.response.findUnique({
      where: { id: responseId },
      select: { studentId: true, student: { select: { pushToken: true } } },
    });
    if (speaking && speaking.studentId !== auth.userId && speaking.student.pushToken) {
      await sendPushNotification(
        speaking.student.pushToken,
        'New Comment',
        `${auth.username} commented on your speaking`,
        { type: 'comment', responseId: responseId.toString() },
      );
    }

    // SSE notify the speaker
    if (speaking && speaking.studentId !== auth.userId) {
      sseManager.sendToUser(speaking.studentId, 'new-comment', {
        speakingId: responseId.toString(),
        commenterName: auth.username,
        text: text.trim().slice(0, 100),
      });
    }

    res.status(201).json({ ...comment, id: comment.id.toString() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/speaking/:id/comments
router.get('/:id/comments', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const responseId = BigInt(req.params.id as string);

    const [comments, total] = await Promise.all([
      prisma.comment.findMany({
        where: { responseId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
        },
      }),
      prisma.comment.count({ where: { responseId } }),
    ]);

    res.json({
      data: comments.map((c: any) => ({ ...c, id: c.id.toString() })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
