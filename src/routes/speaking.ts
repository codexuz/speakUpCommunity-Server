import { Request, Response, Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import {
    AuthenticatedRequest,
    authenticateRequest,
    requireRole,
} from '../middleware/auth';
import { uploadLimiter } from '../middleware/rateLimiter';
import { sendPushNotification } from '../notifications';
import prisma from '../prisma';
import { uploadAudio } from '../services/minio';
import { enqueueAudioJob } from '../services/queue';
import { sseManager } from '../services/sse';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

function getCefrLevel(score: number): string {
  if (score <= 37) return 'A2';
  if (score <= 51) return 'B1';
  if (score <= 65) return 'B2';
  return 'C1';
}

function getIeltsBand(score: number): string {
  if (score <= 3.5) return 'A2';
  if (score <= 4.5) return 'B1';
  if (score <= 6.0) return 'B2';
  if (score <= 7.5) return 'C1';
  return 'C2';
}

function getLevelLabel(score: number, examType: string): string {
  return examType === 'ielts' ? getIeltsBand(score) : getCefrLevel(score);
}

router.use(authenticateRequest);

// ---------- SSE ----------

// GET /api/speaking/events — real-time event stream
router.get('/events', (req: Request, res: Response) => {
  const auth = (req as AuthenticatedRequest).auth!;
  const clientId = uuidv4();
  sseManager.addClient(clientId, auth.userId, res);
});

// ---------- List endpoints (before /:id) ----------

// GET /api/speaking/my — current user's sessions (grouped by test session)
router.get('/my', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const where = { userId: auth.userId };
    const [sessions, total] = await Promise.all([
      prisma.testSession.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          test: { select: { id: true, title: true, description: true } },
          _count: { select: { responses: true } },
        },
      }),
      prisma.testSession.count({ where }),
    ]);

    res.json({
      data: sessions.map((s: any) => ({ ...s, id: s.id.toString() })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/speaking/user/:userId — get any user's sessions (with visibility filters)
router.get('/user/:userId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const userId = req.params.userId;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const isOwner = auth.userId === userId;
    const isPrivileged = auth.role === 'teacher' || auth.role === 'admin';

    const where: any = { userId };

    // If not owner/teacher/admin, only show community sessions
    if (!isOwner && !isPrivileged) {
      where.visibility = 'community';
    }

    const [sessions, total] = await Promise.all([
      prisma.testSession.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          test: { select: { id: true, title: true, description: true } },
          _count: { select: { responses: true } },
        },
      }),
      prisma.testSession.count({ where }),
    ]);

    res.json({
      data: sessions.map((s: any) => ({ ...s, id: s.id.toString() })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/speaking/sessions/:sessionId — get a session with test, user, responses, and labeled checks
router.get('/sessions/:sessionId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const sessionId = BigInt(req.params.sessionId as string);

    const session = await prisma.testSession.findUnique({
      where: { id: sessionId },
      include: {
        test: { select: { id: true, title: true, description: true } },
        user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
        responses: {
          orderBy: { createdAt: 'asc' },
          include: {
            question: { select: { id: true, qText: true, part: true, speakingTimer: true, prepTimer: true } },
            aiFeedback: {
              select: {
                aiScore: true,
                examType: true,
                overallScore: true,
                grammarScore: true,
                fluencyScore: true,
                vocabDiversity: true,
                pronScore: true,
                aiSummary: true,
                naturalness: true,
                fluencyWPM: true,
                pauseCount: true,
                grammarIssues: true,
                vocabSuggestions: true,
                pronIssues: true,
                fillerWords: true,
                transcript: true,
              } as any,
            },
          },
        },
        reviews: {
          include: { reviewer: { select: { id: true, fullName: true, avatarUrl: true } } },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { comments: true } },
      },
    }) as any;

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Access control: owner, teacher, admin, or public community session
    const isOwner = session.userId === auth.userId;
    const isPrivileged = auth.role === 'teacher' || auth.role === 'admin' || auth.role === 'student';
    if (!isOwner && !isPrivileged && session.visibility !== 'community') {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Check if current user liked this session
    const liked = await prisma.like.findUnique({
      where: { sessionId_userId: { sessionId: session.id, userId: auth.userId } },
    });

    // Build labeled checks: TEACHER reviews + AI feedback per response
    const teacherChecks = session.reviews.map((r: any) => ({
      label: 'TEACHER' as const,
      id: r.id.toString(),
      reviewer: r.reviewer,
      score: r.score,
      level: getLevelLabel(r.score, session.examType),
      feedback: r.feedback,
      createdAt: r.createdAt,
    }));

    const aiChecks = session.responses
      .filter((r: any) => r.aiFeedback)
      .map((r: any) => ({
        label: 'AI' as const,
        responseId: r.id.toString(),
        score: r.aiFeedback.aiScore,
        level: getLevelLabel(r.aiFeedback.aiScore, r.aiFeedback.examType),
        overallScore: r.aiFeedback.overallScore,
        grammarScore: r.aiFeedback.grammarScore,
        fluencyScore: r.aiFeedback.fluencyScore,
        vocabDiversity: r.aiFeedback.vocabDiversity,
        pronScore: r.aiFeedback.pronScore,
        fluencyWPM: r.aiFeedback.fluencyWPM,
        pauseCount: r.aiFeedback.pauseCount,
        aiSummary: r.aiFeedback.aiSummary,
        naturalness: r.aiFeedback.naturalness,
        grammarIssues: r.aiFeedback.grammarIssues,
        vocabSuggestions: r.aiFeedback.vocabSuggestions,
        pronIssues: r.aiFeedback.pronIssues,
        fillerWords: r.aiFeedback.fillerWords,
        transcript: r.aiFeedback.transcript,
      }));

    res.json({
      ...session,
      id: session.id.toString(),
      isLiked: !!liked,
      cefrLevel: session.scoreAvg != null ? getLevelLabel(Math.round(session.scoreAvg), session.examType) : null,
      responses: session.responses.map((r: any) => ({
        ...r,
        id: r.id.toString(),
        aiFeedback: undefined, // exposed via checks instead
      })),
      checks: [...teacherChecks, ...aiChecks],
      // keep reviews for backwards compat
      reviews: undefined,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/speaking/pending — all unreviewed sessions (teacher/admin)
router.get('/pending', requireRole('teacher'), async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const where = { reviews: { none: {} } };

    const [sessions, total] = await Promise.all([
      prisma.testSession.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
          test: { select: { id: true, title: true, description: true } },
          _count: { select: { responses: true } },
        },
      }),
      prisma.testSession.count({ where }),
    ]);

    res.json({
      data: sessions.map((s: any) => ({ ...s, id: s.id.toString() })),
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
      const { questionId, visibility, sessionId, testId } = req.body;

      if (!questionId) {
        res.status(400).json({ error: 'questionId is required' });
        return;
      }

      const vis = ['private', 'community', 'ai_only'].includes(visibility)
        ? visibility
        : 'community';

      // Resolve or create a session
      let resolvedSessionId: bigint | null = null;

      if (sessionId) {
        // Use existing session
        const session = await prisma.testSession.findUnique({
          where: { id: BigInt(sessionId) },
          select: { id: true, userId: true },
        });
        if (!session || session.userId !== auth.userId) {
          res.status(400).json({ error: 'Invalid sessionId' });
          return;
        }
        resolvedSessionId = session.id;
      } else if (testId) {
        // Create a new session for this test
        const test = await prisma.test.findUnique({ where: { id: parseInt(testId) } });
        if (!test) {
          res.status(400).json({ error: 'Invalid testId' });
          return;
        }
        const session = await prisma.testSession.create({
          data: {
            testId: test.id,
            userId: auth.userId,
            visibility: vis,
            examType: test.testType,
            isAnonymous: req.body.isAnonymous === true || req.body.isAnonymous === 'true',
          },
        });
        resolvedSessionId = session.id;
      }

      let remoteUrl: string | null = null;
      let fileName: string | null = null;

      // Upload audio to MinIO
      if (req.file) {
        const audioName = `${Date.now()}_${req.file.originalname ? req.file.originalname.replace(/\.[^/.]+$/, '') : 'audio'}`;
        fileName = `speaking_responses/${auth.userId}/${audioName}.m4a`;
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
          sessionId: resolvedSessionId,
          remoteUrl,
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

      res.status(201).json({
        ...response,
        id: response.id.toString(),
        sessionId: resolvedSessionId?.toString() || null,
      });
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
      },
    });

    if (!response) {
      res.status(404).json({ error: 'Speaking submission not found' });
      return;
    }

    // Visibility check via session
    const session = response.sessionId
      ? await prisma.testSession.findUnique({
          where: { id: response.sessionId },
          select: { visibility: true, userId: true },
        })
      : null;

    if (session) {
      const isOwner = response.studentId === auth.userId;
      const isPrivileged = auth.role === 'teacher' || auth.role === 'admin';
      if (!isOwner && !isPrivileged && session.visibility === 'private') {
        res.status(403).json({ error: 'This submission is private' });
        return;
      }
    }

    // Check if current user liked the session
    const liked = response.sessionId
      ? await prisma.like.findUnique({
          where: { sessionId_userId: { sessionId: response.sessionId, userId: auth.userId } },
        })
      : null;

    res.json({
      ...response,
      id: response.id.toString(),
      isLiked: !!liked,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/speaking/sessions/:sessionId — update session visibility
router.put('/sessions/:sessionId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const sessionId = BigInt(req.params.sessionId as string);

    const session = await prisma.testSession.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.userId !== auth.userId) {
      res.status(403).json({ error: "Cannot edit others' sessions" });
      return;
    }

    const { visibility } = req.body;
    if (!visibility || !['private', 'community', 'ai_only'].includes(visibility)) {
      res.status(400).json({ error: 'visibility must be one of: private, community, ai_only' });
      return;
    }

    const updated = await prisma.testSession.update({
      where: { id: sessionId },
      data: { visibility },
    });

    res.json({ ...updated, id: updated.id.toString() });
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

// DELETE /api/speaking/sessions/:sessionId — delete session with all its responses
router.delete('/sessions/:sessionId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const sessionId = BigInt(req.params.sessionId as string);

    const session = await prisma.testSession.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (auth.role === 'student' && session.userId !== auth.userId) {
      res.status(403).json({ error: "Cannot delete others' sessions" });
      return;
    }

    await prisma.$transaction([
      prisma.response.deleteMany({ where: { sessionId } }),
      prisma.testSession.delete({ where: { id: sessionId } }),
    ]);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Likes (session-based) ----------

// POST /api/speaking/sessions/:sessionId/like
router.post('/sessions/:sessionId/like', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const sessionId = BigInt(req.params.sessionId as string);

    const existing = await prisma.like.findUnique({
      where: { sessionId_userId: { sessionId, userId: auth.userId } },
    });
    if (existing) {
      res.status(409).json({ error: 'Already liked' });
      return;
    }

    await prisma.$transaction([
      prisma.like.create({ data: { sessionId, userId: auth.userId } }),
      prisma.testSession.update({
        where: { id: sessionId },
        data: { likes: { increment: 1 } },
      }),
    ]);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/speaking/sessions/:sessionId/like
router.delete('/sessions/:sessionId/like', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const sessionId = BigInt(req.params.sessionId as string);

    const existing = await prisma.like.findUnique({
      where: { sessionId_userId: { sessionId, userId: auth.userId } },
    });
    if (!existing) {
      res.status(404).json({ error: 'Not liked' });
      return;
    }

    await prisma.$transaction([
      prisma.like.delete({
        where: { sessionId_userId: { sessionId, userId: auth.userId } },
      }),
      prisma.testSession.update({
        where: { id: sessionId },
        data: { likes: { decrement: 1 } },
      }),
    ]);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Comments (session-based) ----------

// POST /api/speaking/sessions/:sessionId/comment
router.post('/sessions/:sessionId/comment', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const sessionId = BigInt(req.params.sessionId as string);
    const { text } = req.body;

    if (!text?.trim()) {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    const [comment] = await prisma.$transaction([
      prisma.comment.create({
        data: { sessionId, userId: auth.userId, text: text.trim() },
        include: {
          user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
        },
      }),
      prisma.testSession.update({
        where: { id: sessionId },
        data: { commentsCount: { increment: 1 } },
      }),
    ]);

    // Notify the session owner
    const session = await prisma.testSession.findUnique({
      where: { id: sessionId },
      select: { userId: true, user: { select: { pushToken: true } } },
    });
    if (session && session.userId !== auth.userId && session.user.pushToken) {
      await sendPushNotification(
        session.user.pushToken,
        'New Comment',
        `${auth.username} commented on your session`,
        { type: 'comment', sessionId: sessionId.toString() },
      );
    }

    // SSE notify the session owner
    if (session && session.userId !== auth.userId) {
      sseManager.sendToUser(session.userId, 'new-comment', {
        sessionId: sessionId.toString(),
        commenterName: auth.username,
        text: text.trim().slice(0, 100),
      });
    }

    res.status(201).json({ ...comment, id: comment.id.toString() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/speaking/comments/:commentId — edit comment (author only)
router.put('/comments/:commentId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const commentId = BigInt(req.params.commentId as string);
    const { text } = req.body;

    if (!text?.trim()) {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    const existing = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { userId: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }
    if (existing.userId !== auth.userId) {
      res.status(403).json({ error: 'You can only edit your own comments' });
      return;
    }

    const updated = await prisma.comment.update({
      where: { id: commentId },
      data: { text: text.trim() },
      include: {
        user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
      },
    });

    res.json({ ...updated, id: updated.id.toString() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/speaking/comments/:commentId — delete comment (author only)
router.delete('/comments/:commentId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const commentId = BigInt(req.params.commentId as string);

    const existing = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { userId: true, sessionId: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }
    if (existing.userId !== auth.userId) {
      res.status(403).json({ error: 'You can only delete your own comments' });
      return;
    }

    await prisma.$transaction([
      prisma.comment.delete({ where: { id: commentId } }),
      prisma.testSession.update({
        where: { id: existing.sessionId },
        data: { commentsCount: { decrement: 1 } },
      }),
    ]);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/speaking/sessions/:sessionId/comments
router.get('/sessions/:sessionId/comments', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const sessionId = BigInt(req.params.sessionId as string);

    const [comments, total] = await Promise.all([
      prisma.comment.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
        },
      }),
      prisma.comment.count({ where: { sessionId } }),
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
