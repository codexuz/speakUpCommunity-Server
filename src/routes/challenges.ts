import { Request, Response, Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import {
  AuthenticatedRequest,
  authenticateRequest,
  requireRole,
} from '../middleware/auth';
import prisma from '../prisma';
import { uploadAudio } from '../services/minio';
import { enqueueAudioJob } from '../services/queue';
import { awardXP, XP_REWARDS, COIN_REWARDS } from '../services/gamification';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

router.use(authenticateRequest);

// GET /api/challenges — list active challenges
router.get('/', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const type = req.query.type as string;
    const now = new Date();

    const where: any = {
      isActive: true,
      startsAt: { lte: now },
      endsAt: { gte: now },
    };
    if (type && ['daily', 'weekly', 'special'].includes(type)) {
      where.type = type;
    }

    const challenges = await prisma.challenge.findMany({
      where,
      orderBy: { startsAt: 'desc' },
      include: {
        _count: { select: { submissions: true } },
      },
    });

    // Check which ones user has submitted
    const userSubmissions = await prisma.challengeSubmission.findMany({
      where: {
        userId: auth.userId,
        challengeId: { in: challenges.map((c) => c.id) },
      },
      select: { challengeId: true },
    });
    const submittedSet = new Set(userSubmissions.map((s) => s.challengeId));

    const data = challenges.map((c) => ({
      ...c,
      submitted: submittedSet.has(c.id),
      participantCount: c._count.submissions,
    }));

    res.json({ data });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/challenges/history — user's past challenge submissions
router.get('/history', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const where = { userId: auth.userId };
    const [submissions, total] = await Promise.all([
      prisma.challengeSubmission.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          challenge: true,
        },
      }),
      prisma.challengeSubmission.count({ where }),
    ]);

    res.json({
      data: submissions,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/challenges/:id — single challenge with submissions feed
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const challenge = await prisma.challenge.findUnique({
      where: { id: req.params.id as string },
      include: {
        submissions: {
          orderBy: { submittedAt: 'desc' },
          take: 20,
          include: {
            user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
          },
        },
        _count: { select: { submissions: true } },
      },
    });

    if (!challenge) {
      res.status(404).json({ error: 'Challenge not found' });
      return;
    }

    const userSubmission = await prisma.challengeSubmission.findUnique({
      where: { challengeId_userId: { challengeId: challenge.id, userId: auth.userId } },
    });

    res.json({
      ...challenge,
      submitted: !!userSubmission,
      userSubmission,
      participantCount: challenge._count.submissions,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/challenges/:id/submit — submit recording for a challenge
router.post(
  '/:id/submit',
  upload.single('audio'),
  async (req: Request, res: Response) => {
    try {
      const auth = (req as AuthenticatedRequest).auth!;
      const challengeId = req.params.id as string;
      const now = new Date();

      // Validate challenge
      const challenge = await prisma.challenge.findUnique({ where: { id: challengeId } });
      if (!challenge) {
        res.status(404).json({ error: 'Challenge not found' });
        return;
      }
      if (!challenge.isActive || now < challenge.startsAt || now > challenge.endsAt) {
        res.status(400).json({ error: 'Challenge is not active' });
        return;
      }

      // Check duplicate
      const existing = await prisma.challengeSubmission.findUnique({
        where: { challengeId_userId: { challengeId, userId: auth.userId } },
      });
      if (existing) {
        res.status(400).json({ error: 'Already submitted to this challenge' });
        return;
      }

      // Upload audio
      let remoteUrl: string | null = null;
      let fileName: string | null = null;

      if (req.file) {
        fileName = `challenges/${auth.userId}/${Date.now()}_${req.file.originalname || 'audio.m4a'}`;
        remoteUrl = await uploadAudio(fileName, req.file.buffer, req.file.mimetype || 'audio/m4a');
      } else {
        res.status(400).json({ error: 'Audio file is required' });
        return;
      }

      // Create a Response record for the audio
      // Use a special "challenge" question approach — store with questionId=0 won't work,
      // so create response linked to challenge context
      const response = await prisma.response.create({
        data: {
          questionId: parseInt(req.body.questionId) || 1, // optional linked question
          studentId: auth.userId,
          remoteUrl,
        },
      });

      // Enqueue audio processing (will trigger AI feedback)
      if (fileName) {
        await enqueueAudioJob({
          responseId: response.id.toString(),
          fileName,
          userId: auth.userId,
        });
      }

      // Create challenge submission
      const submission = await prisma.challengeSubmission.create({
        data: {
          challengeId,
          userId: auth.userId,
          responseId: response.id,
        },
      });

      // Award XP + coins
      const xpReward = challenge.type === 'weekly'
        ? XP_REWARDS.COMPLETE_WEEKLY_CHALLENGE
        : XP_REWARDS.COMPLETE_DAILY_CHALLENGE;
      const coinReward = challenge.type === 'weekly'
        ? COIN_REWARDS.COMPLETE_WEEKLY_CHALLENGE
        : COIN_REWARDS.COMPLETE_DAILY_CHALLENGE;

      await awardXP(auth.userId, xpReward, coinReward, { isRecording: true });

      res.status(201).json({
        submission,
        responseId: response.id.toString(),
        xpEarned: xpReward,
        coinsEarned: coinReward,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },
);

// ─── Admin: manage challenges ──────────────────────────────────

// POST /api/challenges/admin/create — create challenge (admin/teacher)
router.post('/admin/create', requireRole('teacher'), async (req: Request, res: Response) => {
  try {
    const { title, description, type, difficulty, promptText, promptImage, startsAt, endsAt, xpReward, coinReward } = req.body;

    if (!title || !promptText || !startsAt || !endsAt) {
      res.status(400).json({ error: 'title, promptText, startsAt, endsAt are required' });
      return;
    }

    const challenge = await prisma.challenge.create({
      data: {
        title,
        description: description || null,
        type: type || 'daily',
        difficulty: difficulty || 'beginner',
        promptText,
        promptImage: promptImage || null,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        xpReward: xpReward || 50,
        coinReward: coinReward || 5,
      },
    });

    res.status(201).json(challenge);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/challenges/admin/:id — update challenge
router.put('/admin/:id', requireRole('teacher'), async (req: Request, res: Response) => {
  try {
    const { title, description, type, difficulty, promptText, promptImage, startsAt, endsAt, xpReward, coinReward, isActive } = req.body;

    const challenge = await prisma.challenge.update({
      where: { id: req.params.id as string },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(type !== undefined && { type }),
        ...(difficulty !== undefined && { difficulty }),
        ...(promptText !== undefined && { promptText }),
        ...(promptImage !== undefined && { promptImage }),
        ...(startsAt !== undefined && { startsAt: new Date(startsAt) }),
        ...(endsAt !== undefined && { endsAt: new Date(endsAt) }),
        ...(xpReward !== undefined && { xpReward }),
        ...(coinReward !== undefined && { coinReward }),
        ...(isActive !== undefined && { isActive }),
      },
    });

    res.json(challenge);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/challenges/admin/:id — delete challenge
router.delete('/admin/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    await prisma.challenge.delete({ where: { id: req.params.id as string } });
    res.json({ message: 'Challenge deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
