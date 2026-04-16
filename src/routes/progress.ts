import { Request, Response, Router } from 'express';
import { AuthenticatedRequest, authenticateRequest } from '../middleware/auth';
import prisma from '../prisma';
import {
  buyStreakFreeze,
  checkAllAchievements,
  getAllTimeLeaderboard,
  getOrCreateProgress,
  getStreakLeaderboard,
  getWeeklyLeaderboard,
} from '../services/gamification';

const router = Router();

router.use(authenticateRequest);

// GET /api/progress/me — current user's progress, stats, level, streak
router.get('/me', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const progress = await getOrCreateProgress(auth.userId);

    // XP needed for next level
    const xpForNextLevel = progress.level * 100;
    let xpInCurrentLevel = progress.xp;
    let level = 1;
    while (level < progress.level) {
      xpInCurrentLevel -= level * 100;
      level++;
    }

    res.json({
      ...progress,
      xpInCurrentLevel,
      xpForNextLevel,
      xpPercent: Math.min(100, Math.round((xpInCurrentLevel / xpForNextLevel) * 100)),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/progress/achievements — user's achievements
router.get('/achievements', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;

    const [allAchievements, userAchievements] = await Promise.all([
      prisma.achievement.findMany({ orderBy: { category: 'asc' } }),
      prisma.userAchievement.findMany({
        where: { userId: auth.userId },
        select: { achievementId: true, unlockedAt: true },
      }),
    ]);

    const unlockedMap = new Map(userAchievements.map((ua) => [ua.achievementId, ua.unlockedAt]));

    const data = allAchievements.map((a) => ({
      ...a,
      unlocked: unlockedMap.has(a.id),
      unlockedAt: unlockedMap.get(a.id) || null,
    }));

    res.json({ data });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/progress/check-achievements — trigger achievement check
router.post('/check-achievements', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const unlocked = await checkAllAchievements(auth.userId);
    res.json({ newlyUnlocked: unlocked });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/progress/buy-streak-freeze — purchase streak freeze with coins
router.post('/buy-streak-freeze', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const result = await buyStreakFreeze(auth.userId);
    if (!result.success) {
      res.status(400).json({ error: result.message });
      return;
    }
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/progress/leaderboard — leaderboards
router.get('/leaderboard', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const type = (req.query.type as string) || 'weekly';
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));

    let leaderboard;
    switch (type) {
      case 'alltime':
        leaderboard = await getAllTimeLeaderboard(limit);
        break;
      case 'streak':
        leaderboard = await getStreakLeaderboard(limit);
        break;
      default:
        leaderboard = await getWeeklyLeaderboard(limit);
        break;
    }

    // Find current user's rank
    const userProgress = await getOrCreateProgress(auth.userId);
    let userRank: number | null = null;

    if (type === 'weekly') {
      userRank = await prisma.userProgress.count({
        where: { weeklyXP: { gt: userProgress.weeklyXP } },
      }) + 1;
    } else if (type === 'alltime') {
      userRank = await prisma.userProgress.count({
        where: { xp: { gt: userProgress.xp } },
      }) + 1;
    } else {
      userRank = await prisma.userProgress.count({
        where: { currentStreak: { gt: userProgress.currentStreak } },
      }) + 1;
    }

    res.json({
      type,
      data: leaderboard,
      userRank,
      userProgress,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/progress/weekly-summary — user's weekly improvement summary
router.get('/weekly-summary', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const progress = await getOrCreateProgress(auth.userId);

    // Get AI feedbacks from this week
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentFeedbacks = await prisma.aIFeedback.findMany({
      where: {
        response: { studentId: auth.userId },
        createdAt: { gte: weekAgo },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Calculate improvement
    let fluencyImprovement = 0;
    let grammarImprovement = 0;
    let vocabImprovement = 0;

    if (recentFeedbacks.length >= 2) {
      const firstHalf = recentFeedbacks.slice(0, Math.floor(recentFeedbacks.length / 2));
      const secondHalf = recentFeedbacks.slice(Math.floor(recentFeedbacks.length / 2));

      const avg = (arr: any[], key: string) =>
        arr.length ? arr.reduce((s, f) => s + (f as any)[key], 0) / arr.length : 0;

      fluencyImprovement = Math.round(avg(secondHalf, 'fluencyScore') - avg(firstHalf, 'fluencyScore'));
      grammarImprovement = Math.round(avg(secondHalf, 'grammarScore') - avg(firstHalf, 'grammarScore'));
      vocabImprovement = Math.round(avg(secondHalf, 'vocabDiversity') - avg(firstHalf, 'vocabDiversity'));
    }

    // Count recordings this week
    const weeklyRecordings = await prisma.response.count({
      where: { studentId: auth.userId, createdAt: { gte: weekAgo } },
    });

    res.json({
      weeklyXP: progress.weeklyXP,
      weeklyRecordings,
      currentStreak: progress.currentStreak,
      level: progress.level,
      improvements: {
        fluency: fluencyImprovement,
        grammar: grammarImprovement,
        vocabulary: vocabImprovement,
      },
      averages: {
        fluencyWPM: progress.fluencyWPMAvg,
        vocabDiversity: progress.vocabDiversityAvg,
        pronScore: progress.pronScoreAvg,
      },
      totalFeedbacks: recentFeedbacks.length,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/progress/reputation — user's reputation profile
router.get('/reputation', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const userId = (req.query.userId as string) || auth.userId;

    const reputation = await prisma.userReputation.upsert({
      where: { userId },
      create: { userId },
      update: {},
      include: {
        user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
      },
    });

    const mentorLabels = ['', 'Helper', 'Mentor', 'Expert'];

    res.json({
      ...reputation,
      mentorLabel: mentorLabels[reputation.mentorLevel] || '',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
