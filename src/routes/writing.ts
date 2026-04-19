import { ExamType } from '@prisma/client';
import { Request, Response, Router } from 'express';
import {
  AuthenticatedRequest,
  authenticateRequest,
  requireRole,
} from '../middleware/auth';
import { sendPushNotification } from '../notifications';
import prisma from '../prisma';
import { awardXP, checkAllAchievements, XP_REWARDS } from '../services/gamification';
import { enqueueWritingJob } from '../services/queue';
import { sseManager } from '../services/sse';
import { deriveCefrLevel, generateWritingAIFeedback } from '../services/writingAiFeedback';

const router = Router();

router.use(authenticateRequest);

// ─── WRITING TESTS CRUD ────────────────────────────────────────

// GET /api/writing/tests — list writing tests (paginated)
router.get('/tests', async (req: Request, res: Response) => {
  try {
    const { examType } = req.query;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 10));
    const skip = (page - 1) * limit;

    const auth = (req as AuthenticatedRequest).auth;
    const isAdminOrTeacher = auth?.role === 'admin' || auth?.role === 'teacher';

    const where: any = {};
    if (examType && Object.values(ExamType).includes(examType as ExamType)) {
      where.examType = examType as ExamType;
    }
    if (!isAdminOrTeacher) {
      where.isPublished = true;
    } else if (req.query.isPublished !== undefined) {
      where.isPublished = req.query.isPublished === 'true';
    }

    const [tests, total] = await Promise.all([
      prisma.writingTest.findMany({
        where,
        orderBy: { id: 'asc' },
        skip,
        take: limit,
        include: { tasks: { orderBy: { id: 'asc' } } },
      }),
      prisma.writingTest.count({ where }),
    ]);

    res.json({
      data: tests,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/writing/tests/:id — single writing test
router.get('/tests/:id', async (req: Request, res: Response) => {
  try {
    const test = await prisma.writingTest.findUnique({
      where: { id: parseInt(req.params.id as string) },
      include: { tasks: { orderBy: { id: 'asc' } } },
    });
    if (!test) {
      res.status(404).json({ error: 'Writing test not found' });
      return;
    }
    res.json(test);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/writing/tests — create writing test
router.post('/tests', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can create writing tests' });
      return;
    }
    const { title, description, examType, isPublished } = req.body;
    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    const test = await prisma.writingTest.create({
      data: {
        title,
        description,
        examType: examType === 'ielts' ? 'ielts' : 'cefr',
        ...(isPublished !== undefined && { isPublished: Boolean(isPublished) }),
      },
      include: { tasks: true },
    });
    res.status(201).json(test);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/writing/tests/:id — update writing test
router.put('/tests/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can update writing tests' });
      return;
    }
    const id = parseInt(req.params.id as string);
    const { title, description, examType, isPublished } = req.body;
    const test = await prisma.writingTest.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(examType !== undefined && { examType: examType === 'ielts' ? 'ielts' as const : 'cefr' as const }),
        ...(isPublished !== undefined && { isPublished: Boolean(isPublished) }),
      },
      include: { tasks: { orderBy: { id: 'asc' } } },
    });
    res.json(test);
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Writing test not found' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/writing/tests/:id
router.delete('/tests/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can delete writing tests' });
      return;
    }
    await prisma.writingTest.delete({ where: { id: parseInt(req.params.id as string) } });
    res.json({ message: 'Writing test deleted' });
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Writing test not found' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// ─── WRITING TASKS CRUD ────────────────────────────────────────

// GET /api/writing/tests/:testId/tasks
router.get('/tests/:testId/tasks', async (req: Request, res: Response) => {
  try {
    const testId = parseInt(req.params.testId as string);
    const tasks = await prisma.writingTask.findMany({
      where: { testId },
      orderBy: { id: 'asc' },
    });
    res.json(tasks);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/writing/tests/:testId/tasks
router.post('/tests/:testId/tasks', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can create tasks' });
      return;
    }
    const testId = parseInt(req.params.testId as string);
    const { taskText, part, image, minWords, maxWords, timeLimit } = req.body;
    if (!taskText || !part) {
      res.status(400).json({ error: 'taskText and part are required' });
      return;
    }
    const task = await prisma.writingTask.create({
      data: {
        testId,
        taskText,
        part,
        image: image || undefined,
        ...(minWords !== undefined && { minWords: parseInt(minWords) }),
        ...(maxWords !== undefined && { maxWords: parseInt(maxWords) }),
        ...(timeLimit !== undefined && { timeLimit: parseInt(timeLimit) }),
      },
    });
    res.status(201).json(task);
  } catch (error: any) {
    if (error.code === 'P2003') {
      res.status(404).json({ error: 'Writing test not found' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/writing/tasks/:id
router.put('/tasks/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can update tasks' });
      return;
    }
    const id = parseInt(req.params.id as string);
    const { taskText, part, image, minWords, maxWords, timeLimit } = req.body;
    const task = await prisma.writingTask.update({
      where: { id },
      data: {
        ...(taskText !== undefined && { taskText }),
        ...(part !== undefined && { part }),
        ...(image !== undefined && { image: image || null }),
        ...(minWords !== undefined && { minWords: parseInt(minWords) }),
        ...(maxWords !== undefined && { maxWords: parseInt(maxWords) }),
        ...(timeLimit !== undefined && { timeLimit: parseInt(timeLimit) }),
      },
    });
    res.json(task);
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/writing/tasks/:id
router.delete('/tasks/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can delete tasks' });
      return;
    }
    await prisma.writingTask.delete({ where: { id: parseInt(req.params.id as string) } });
    res.json({ message: 'Task deleted' });
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// ─── WRITING SUBMISSIONS ───────────────────────────────────────

// POST /api/writing/submit — submit an essay
router.post('/submit', requireRole('student'), async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const { taskId, essayText, sessionId, testId, visibility, groupId, timeTakenSec } = req.body;

    if (!taskId || !essayText?.trim()) {
      res.status(400).json({ error: 'taskId and essayText are required' });
      return;
    }

    const task = await prisma.writingTask.findUnique({
      where: { id: parseInt(taskId) },
      include: { test: true },
    });
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    const wordCount = essayText.trim().split(/\s+/).length;
    const vis = ['private', 'group', 'community', 'ai_only'].includes(visibility)
      ? visibility
      : 'private';

    // Validate group membership
    let resolvedGroupId: string | null = null;
    if (groupId) {
      const group = await prisma.group.findUnique({
        where: { id: groupId },
        select: { isGlobal: true },
      });
      if (group) {
        if (group.isGlobal) {
          resolvedGroupId = groupId;
        } else {
          const membership = await prisma.groupMember.findUnique({
            where: { groupId_userId: { groupId, userId: auth.userId } },
          });
          if (membership) resolvedGroupId = groupId;
        }
      }
    }

    const finalVisibility = resolvedGroupId ? vis : (vis === 'group' ? 'private' : vis);

    // Resolve or create session
    let resolvedSessionId: bigint | null = null;
    if (sessionId) {
      const session = await prisma.writingSession.findUnique({
        where: { id: BigInt(sessionId) },
        select: { id: true, userId: true },
      });
      if (!session || session.userId !== auth.userId) {
        res.status(400).json({ error: 'Invalid sessionId' });
        return;
      }
      resolvedSessionId = session.id;
    } else if (testId) {
      const test = await prisma.writingTest.findUnique({ where: { id: parseInt(testId) } });
      if (!test) {
        res.status(400).json({ error: 'Invalid testId' });
        return;
      }
      const session = await prisma.writingSession.create({
        data: {
          testId: test.id,
          userId: auth.userId,
          examType: test.examType,
          visibility: finalVisibility,
          groupId: resolvedGroupId,
        },
      });
      resolvedSessionId = session.id;
    }

    const response = await prisma.writingResponse.create({
      data: {
        taskId: parseInt(taskId),
        studentId: auth.userId,
        sessionId: resolvedSessionId,
        essayText: essayText.trim(),
        wordCount,
        ...(timeTakenSec !== undefined && { timeTakenSec: parseInt(timeTakenSec) }),
      },
      include: {
        student: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
        task: { select: { taskText: true, part: true } },
      },
    });

    // Enqueue writing processing job (AI feedback + gamification)
    const examType = task.test.examType;
    enqueueWritingJob({
      responseId: response.id.toString(),
      essayText: essayText.trim(),
      taskText: task.taskText,
      examType,
      userId: auth.userId,
    }).catch((err) => console.error('Failed to enqueue writing job:', err));

    res.status(201).json({
      ...response,
      id: response.id.toString(),
      sessionId: resolvedSessionId?.toString() || null,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── WRITING SESSIONS ──────────────────────────────────────────

// GET /api/writing/my — current user's writing sessions
router.get('/my', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const where = { userId: auth.userId };
    const [sessions, total] = await Promise.all([
      prisma.writingSession.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          test: { select: { id: true, title: true, description: true } },
          _count: { select: { responses: true } },
        },
      }),
      prisma.writingSession.count({ where }),
    ]);

    res.json({
      data: sessions.map((s: any) => ({ ...s, id: s.id.toString() })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/writing/sessions/:sessionId
router.get('/sessions/:sessionId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const sessionId = BigInt(req.params.sessionId as string);

    const session = await prisma.writingSession.findUnique({
      where: { id: sessionId },
      include: {
        test: { select: { id: true, title: true, description: true } },
        user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
        responses: {
          orderBy: { createdAt: 'asc' },
          include: {
            task: { select: { id: true, taskText: true, part: true, minWords: true, maxWords: true } },
            aiFeedback: true,
          },
        },
        reviews: {
          include: { reviewer: { select: { id: true, fullName: true, avatarUrl: true } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Access check
    if (session.userId !== auth.userId && auth.role !== 'teacher' && auth.role !== 'admin') {
      if (session.groupId) {
        const membership = await prisma.groupMember.findUnique({
          where: { groupId_userId: { groupId: session.groupId, userId: auth.userId } },
        });
        if (!membership) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }
      } else if (session.visibility !== 'community') {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
    }

    res.json({
      ...session,
      id: session.id.toString(),
      responses: session.responses.map((r: any) => ({ ...r, id: r.id.toString() })),
      reviews: session.reviews.map((r: any) => ({
        ...r,
        id: r.id.toString(),
        cefrLevel: deriveCefrLevel(r.score, session.examType),
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/writing/sessions/:sessionId
router.delete('/sessions/:sessionId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const sessionId = BigInt(req.params.sessionId as string);

    const session = await prisma.writingSession.findUnique({
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
      prisma.writingResponse.deleteMany({ where: { sessionId } }),
      prisma.writingSession.delete({ where: { id: sessionId } }),
    ]);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── AI FEEDBACK ────────────────────────────────────────────────

// GET /api/writing/ai-feedback/:responseId
router.get('/ai-feedback/:responseId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const responseId = BigInt(req.params.responseId as string);

    const feedback = await prisma.writingAIFeedback.findUnique({
      where: { responseId },
      include: {
        response: {
          select: {
            studentId: true,
            task: { select: { taskText: true, part: true } },
          },
        },
      },
    });

    if (!feedback) {
      res.status(404).json({ error: 'AI feedback not found. It may still be processing.' });
      return;
    }

    if (
      feedback.response.studentId !== auth.userId &&
      auth.role !== 'teacher' &&
      auth.role !== 'admin'
    ) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    res.json({ ...feedback, responseId: feedback.responseId.toString() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/writing/ai-feedback/session/:sessionId — all AI feedbacks for a session
router.get('/ai-feedback/session/:sessionId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const sessionId = BigInt(req.params.sessionId as string);

    const session = await prisma.writingSession.findUnique({
      where: { id: sessionId },
      select: { userId: true, visibility: true, groupId: true, examType: true },
    });

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (session.userId !== auth.userId && auth.role !== 'teacher' && auth.role !== 'admin') {
      if (session.visibility === 'private' || session.visibility === 'ai_only') {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
    }

    const feedbacks = await prisma.writingAIFeedback.findMany({
      where: { response: { sessionId } },
      orderBy: { createdAt: 'asc' },
      include: {
        response: {
          select: {
            id: true,
            task: { select: { id: true, taskText: true, part: true } },
          },
        },
      },
    });

    const avgScore = feedbacks.length > 0
      ? Math.round(feedbacks.reduce((s, f) => s + f.overallScore, 0) / feedbacks.length * 10) / 10
      : null;

    res.json({
      feedbacks: feedbacks.map((f) => ({
        ...f,
        responseId: f.responseId.toString(),
        response: { ...f.response, id: f.response.id.toString() },
      })),
      aggregate: {
        averageOverallScore: avgScore,
        cefrLevel: avgScore != null ? deriveCefrLevel(avgScore, session.examType) : null,
        totalResponses: feedbacks.length,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── TEACHER REVIEWS ────────────────────────────────────────────

// GET /api/writing/pending-reviews — all sessions awaiting teacher review (verified teachers only)
router.get('/pending-reviews', requireRole('teacher', 'admin'), async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;

    // Verify the teacher is actually verified
    if (auth.role === 'teacher') {
      const user = await prisma.user.findUnique({
        where: { id: auth.userId },
        select: { verifiedTeacher: true },
      });
      if (!user?.verifiedTeacher) {
        res.status(403).json({ error: 'Only verified teachers can view pending reviews' });
        return;
      }
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const examType = req.query.examType as string | undefined;

    const where: any = {
      reviews: { none: {} },
      responses: { some: {} },
      visibility: { in: ['community', 'group'] },
    };

    if (examType && ['ielts', 'cefr'].includes(examType)) {
      where.examType = examType;
    }

    // For group-visible sessions, ensure the teacher is a member
    const teacherGroups = await prisma.groupMember.findMany({
      where: { userId: auth.userId },
      select: { groupId: true },
    });
    const teacherGroupIds = teacherGroups.map((g) => g.groupId);

    where.OR = [
      { visibility: 'community' },
      { visibility: 'group', groupId: { in: teacherGroupIds } },
    ];
    delete where.visibility;

    const [sessions, total] = await Promise.all([
      prisma.writingSession.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          test: { select: { id: true, title: true, examType: true } },
          user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
          _count: { select: { responses: true } },
        },
      }),
      prisma.writingSession.count({ where }),
    ]);

    res.json({
      data: sessions.map((s: any) => ({ ...s, id: s.id.toString() })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/writing/sessions/:sessionId/review
router.post('/sessions/:sessionId/review', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can review' });
      return;
    }

    const sessionId = BigInt(req.params.sessionId as string);
    const { score, feedback } = req.body;

    if (score === undefined || score === null) {
      res.status(400).json({ error: 'score is required' });
      return;
    }

    const session = await prisma.writingSession.findUnique({
      where: { id: sessionId },
      select: { examType: true },
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Validate score range
    const maxScore = session.examType === 'ielts' ? 9 : 6;
    const minScore = session.examType === 'ielts' ? 0 : 1;
    const parsedScore = parseFloat(score);
    if (isNaN(parsedScore) || parsedScore < minScore || parsedScore > maxScore) {
      res.status(400).json({
        error: `Score must be between ${minScore} and ${maxScore} for ${session.examType.toUpperCase()}`,
      });
      return;
    }

    const review = await prisma.writingReview.create({
      data: {
        sessionId,
        reviewerId: auth.userId,
        score: parsedScore,
        feedback: feedback || null,
      },
      include: {
        reviewer: { select: { id: true, fullName: true, avatarUrl: true } },
      },
    });

    // Recalculate session average score & CEFR level
    const allReviews = await prisma.writingReview.findMany({
      where: { sessionId },
      select: { score: true },
    });
    const avgScore = allReviews.reduce((s, r) => s + r.score, 0) / allReviews.length;
    const cefrLevel = deriveCefrLevel(avgScore, session.examType);

    await prisma.writingSession.update({
      where: { id: sessionId },
      data: { scoreAvg: Math.round(avgScore * 10) / 10, cefrLevel },
    });

    // Gamification for reviewer
    await awardXP(auth.userId, XP_REWARDS.REVIEW_SESSION, 0, { isReview: true });
    await checkAllAchievements(auth.userId);

    // Notify the student about the teacher review
    const sessionOwner = await prisma.writingSession.findUnique({
      where: { id: sessionId },
      select: { userId: true, user: { select: { pushToken: true } } },
    });
    if (sessionOwner && sessionOwner.userId !== auth.userId) {
      const reviewerName = review.reviewer.fullName || 'O\'qituvchi';
      if (sessionOwner.user.pushToken) {
        await sendPushNotification(
          sessionOwner.user.pushToken,
          'Writing tekshirildi ✅',
          `${reviewerName} sizning inshoingizni baholadi: ${parsedScore}/${maxScore}`,
          { type: 'writing-review', sessionId: sessionId.toString(), score: parsedScore },
        );
      }
      sseManager.sendToUser(sessionOwner.userId, 'writing-review', {
        sessionId: sessionId.toString(),
        reviewerName,
        score: parsedScore,
        cefrLevel,
      });
    }

    res.status(201).json({
      ...review,
      id: review.id.toString(),
      cefrLevel,
    });
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ error: 'You have already reviewed this session' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

export default router;
