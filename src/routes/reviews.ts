import { Request, Response, Router } from 'express';
import { AuthenticatedRequest, authenticateRequest } from '../middleware/auth';
import { sendPushNotification } from '../notifications';
import prisma from '../prisma';
import { sseManager } from '../services/sse';

const router = Router();

router.use(authenticateRequest);

// POST /api/reviews/:speakingId — post or update a review
router.post('/:speakingId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const responseId = BigInt(req.params.speakingId as string);
    const { score, feedback } = req.body;

    if (score === undefined || score === null) {
      res.status(400).json({ error: 'score is required' });
      return;
    }

    const numScore = parseInt(score);
    if (isNaN(numScore) || numScore < 0 || numScore > 9) {
      res.status(400).json({ error: 'Score must be between 0 and 9' });
      return;
    }

    // Check speaking submission exists
    const speaking = await prisma.response.findUnique({
      where: { id: responseId },
      select: {
        studentId: true,
        student: { select: { pushToken: true, fullName: true } },
      },
    });
    if (!speaking) {
      res.status(404).json({ error: 'Speaking submission not found' });
      return;
    }

    // Can't review own submission
    if (speaking.studentId === auth.userId) {
      res.status(400).json({ error: 'Cannot review your own submission' });
      return;
    }

    // Upsert review (one per reviewer per submission)
    const review = await prisma.review.upsert({
      where: { responseId_reviewerId: { responseId, reviewerId: auth.userId } },
      create: {
        responseId,
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
      where: { responseId },
      _avg: { score: true },
    });
    await prisma.response.update({
      where: { id: responseId },
      data: { scoreAvg: avgResult._avg.score },
    });

    // SSE + push notify the speaker
    sseManager.sendToUser(speaking.studentId, 'new-review', {
      speakingId: responseId.toString(),
      reviewerName: auth.username,
      score: numScore,
    });

    if (speaking.student.pushToken) {
      await sendPushNotification(
        speaking.student.pushToken,
        'New Review',
        `${auth.username} gave you ${numScore}/9`,
        { type: 'review', responseId: responseId.toString() },
      );
    }

    res.status(201).json({ ...review, id: review.id.toString() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/reviews/:speakingId — all reviews for a submission
router.get('/:speakingId', async (req: Request, res: Response) => {
  try {
    const responseId = BigInt(req.params.speakingId as string);

    const reviews = await prisma.review.findMany({
      where: { responseId },
      orderBy: { createdAt: 'desc' },
      include: {
        reviewer: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
      },
    });

    res.json(reviews.map((r: any) => ({ ...r, id: r.id.toString() })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/reviews/:speakingId — delete own review
router.delete('/:speakingId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const responseId = BigInt(req.params.speakingId as string);

    const review = await prisma.review.findUnique({
      where: { responseId_reviewerId: { responseId, reviewerId: auth.userId } },
    });
    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    await prisma.review.delete({ where: { id: review.id } });

    // Recalculate average score
    const avgResult = await prisma.review.aggregate({
      where: { responseId },
      _avg: { score: true },
    });
    await prisma.response.update({
      where: { id: responseId },
      data: { scoreAvg: avgResult._avg.score },
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
