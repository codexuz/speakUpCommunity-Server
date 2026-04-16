import { Request, Response, Router } from 'express';
import { AuthenticatedRequest, authenticateRequest } from '../middleware/auth';
import { sendPushNotification } from '../notifications';
import prisma from '../prisma';
import { sseManager } from '../services/sse';
import { awardXP, checkAllAchievements, XP_REWARDS } from '../services/gamification';
import { incrementReviewsGiven } from '../services/reputation';

const router = Router();

router.use(authenticateRequest);

function getCefrLevel(score: number): string {
  if (score <= 37) return 'A2';
  if (score <= 50) return 'B1';
  if (score <= 64) return 'B2';
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

function getScoreLabel(score: number, examType: string): string {
  return examType === 'ielts' ? `${score}/9` : `${score}/75`;
}

// POST /api/reviews/:sessionId — post or update a review for a session
router.post('/:sessionId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const sessionId = BigInt(req.params.sessionId as string);
    const { score, feedback } = req.body;

    if (score === undefined || score === null) {
      res.status(400).json({ error: 'score is required' });
      return;
    }

    // Check session exists
    const session = await prisma.testSession.findUnique({
      where: { id: sessionId },
      select: {
        userId: true,
        examType: true,
        user: { select: { pushToken: true, fullName: true } },
        test: { select: { title: true } },
      },
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Validate score based on exam type
    const numScore = parseFloat(score);
    if (session.examType === 'ielts') {
      if (isNaN(numScore) || numScore < 0 || numScore > 9 || (numScore * 2) % 1 !== 0) {
        res.status(400).json({ error: 'IELTS score must be 0-9 in 0.5 steps (e.g. 5.5, 6.0, 7.5)' });
        return;
      }
    } else {
      const intScore = parseInt(score);
      if (isNaN(intScore) || intScore < 0 || intScore > 75) {
        res.status(400).json({ error: 'CEFR score must be between 0 and 75' });
        return;
      }
    }

    // Can't review own session
    if (session.userId === auth.userId) {
      res.status(400).json({ error: 'Cannot review your own session' });
      return;
    }

    // Upsert review (one per reviewer per session)
    const review = await prisma.review.upsert({
      where: { sessionId_reviewerId: { sessionId, reviewerId: auth.userId } },
      create: {
        sessionId,
        reviewerId: auth.userId,
        score: numScore,
        feedback: feedback || null,
      },
      update: { score: numScore, feedback: feedback || null },
      include: {
        reviewer: { select: { id: true, fullName: true, avatarUrl: true } },
      },
    });

    // Recalculate average score
    const avgResult = await prisma.review.aggregate({
      where: { sessionId },
      _avg: { score: true },
    });
    await prisma.testSession.update({
      where: { id: sessionId },
      data: { scoreAvg: avgResult._avg.score },
    });

    const cefrLevel = getLevelLabel(numScore, session.examType);

    // SSE + push notify the speaker
    sseManager.sendToUser(session.userId, 'new-review', {
      sessionId: sessionId.toString(),
      reviewerName: auth.username,
      score: numScore,
      examType: session.examType,
      cefrLevel,
    });

    if (session.user.pushToken) {
      await sendPushNotification(
        session.user.pushToken,
        'New Review',
        `${auth.username} gave you ${getScoreLabel(numScore, session.examType)} (${cefrLevel})`,
        { type: 'review', sessionId: sessionId.toString() },
      );
    }

    // Gamification: award XP for reviewing + update reputation
    await awardXP(auth.userId, XP_REWARDS.REVIEW_SESSION, 0, { isReview: true });
    await incrementReviewsGiven(auth.userId);
    await checkAllAchievements(auth.userId);

    res.status(201).json({
      ...review,
      id: review.id.toString(),
      cefrLevel,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/reviews/my-groups — reviews on sessions from students in the teacher's groups
router.get('/my-groups', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    // Find groups where the current user is owner or teacher
    const managedGroups = await prisma.groupMember.findMany({
      where: { userId: auth.userId, role: { in: ['owner', 'teacher'] } },
      select: { groupId: true },
    });
    const groupIds = managedGroups.map((m) => m.groupId);

    if (groupIds.length === 0) {
      res.json({ data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
      return;
    }

    const where = {
      session: { groupId: { in: groupIds } },
    };

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          reviewer: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
          session: {
            select: {
              id: true,
              groupId: true,
              examType: true,
              scoreAvg: true,
              test: { select: { id: true, title: true } },
              user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
              group: { select: { id: true, name: true } },
            },
          },
        },
      }),
      prisma.review.count({ where }),
    ]);

    res.json({
      data: reviews.map((r: any) => ({
        ...r,
        id: r.id.toString(),
        session: { ...r.session, id: r.session.id.toString() },
        cefrLevel: getLevelLabel(r.score, r.session.examType),
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/reviews/:sessionId — all reviews for a session
router.get('/:sessionId', async (req: Request, res: Response) => {
  try {
    const sessionId = BigInt(req.params.sessionId as string);

    const reviews = await prisma.review.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      include: {
        reviewer: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
        session: { select: { examType: true } },
      },
    });

    res.json(reviews.map((r: any) => ({
      ...r,
      id: r.id.toString(),
      cefrLevel: getLevelLabel(r.score, r.session.examType),
    })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/reviews/:sessionId — delete own review
router.delete('/:sessionId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const sessionId = BigInt(req.params.sessionId as string);

    const review = await prisma.review.findUnique({
      where: { sessionId_reviewerId: { sessionId, reviewerId: auth.userId } },
    });
    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    await prisma.review.delete({ where: { id: review.id } });

    // Recalculate average score
    const avgResult = await prisma.review.aggregate({
      where: { sessionId },
      _avg: { score: true },
    });
    await prisma.testSession.update({
      where: { id: sessionId },
      data: { scoreAvg: avgResult._avg.score },
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
