import { Request, Response, Router } from 'express';
import { AuthenticatedRequest, authenticateRequest } from '../middleware/auth';
import prisma from '../prisma';
import { addHelpfulVote } from '../services/reputation';
import { awardXP, COIN_REWARDS, XP_REWARDS } from '../services/gamification';

const router = Router();

router.use(authenticateRequest);

// GET /api/ai-feedback/:responseId — get AI feedback for a response
router.get('/:responseId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const responseId = BigInt(req.params.responseId);

    const feedback = await prisma.aIFeedback.findUnique({
      where: { responseId },
      include: {
        response: {
          select: {
            studentId: true,
            question: { select: { qText: true, part: true } },
          },
        },
      },
    });

    if (!feedback) {
      res.status(404).json({ error: 'AI feedback not found. It may still be processing.' });
      return;
    }

    // Allow owner, teacher, admin
    if (
      feedback.response.studentId !== auth.userId &&
      auth.role !== 'teacher' &&
      auth.role !== 'admin'
    ) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    res.json(feedback);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ai-feedback/session/:sessionId — all AI feedbacks for a session
router.get('/session/:sessionId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const sessionId = BigInt(req.params.sessionId);

    const session = await prisma.testSession.findUnique({
      where: { id: sessionId },
      select: { userId: true, visibility: true, groupId: true },
    });

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Access check
    if (session.userId !== auth.userId && auth.role !== 'teacher' && auth.role !== 'admin') {
      if (session.visibility === 'private' || session.visibility === 'ai_only') {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
    }

    const feedbacks = await prisma.aIFeedback.findMany({
      where: { response: { sessionId } },
      orderBy: { createdAt: 'asc' },
      include: {
        response: {
          select: {
            id: true,
            question: { select: { id: true, qText: true, part: true } },
          },
        },
      },
    });

    // Calculate session-level aggregates
    const avgScore = feedbacks.length > 0
      ? Math.round(feedbacks.reduce((s, f) => s + f.overallScore, 0) / feedbacks.length)
      : null;

    const avgFluency = feedbacks.length > 0
      ? Math.round(feedbacks.reduce((s, f) => s + f.fluencyWPM, 0) / feedbacks.length * 10) / 10
      : null;

    res.json({
      feedbacks: feedbacks.map((f) => ({
        ...f,
        responseId: f.responseId.toString(),
        response: {
          ...f.response,
          id: f.response.id.toString(),
        },
      })),
      aggregate: {
        averageOverallScore: avgScore,
        averageFluencyWPM: avgFluency,
        totalResponses: feedbacks.length,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/ai-feedback/:responseId/helpful — mark AI feedback as helpful (community reaction)
router.post('/:responseId/helpful', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const responseId = BigInt(req.params.responseId);

    const feedback = await prisma.aIFeedback.findUnique({
      where: { responseId },
      select: { response: { select: { studentId: true } } },
    });

    if (!feedback) {
      res.status(404).json({ error: 'AI feedback not found' });
      return;
    }

    // Can't vote on own
    if (feedback.response.studentId === auth.userId) {
      res.status(400).json({ error: 'Cannot vote on your own feedback' });
      return;
    }

    // This is a general helpful vote, affects the speaker's reputation
    await addHelpfulVote(feedback.response.studentId);
    await awardXP(feedback.response.studentId, XP_REWARDS.RECEIVE_HELPFUL_VOTE, COIN_REWARDS.RECEIVE_HELPFUL_VOTE);

    res.json({ message: 'Helpful vote recorded' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
