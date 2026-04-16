import prisma from '../prisma';

// ─── XP Reward Table ────────────────────────────────────────────

export const XP_REWARDS = {
  SUBMIT_RECORDING: 20,
  COMPLETE_DAILY_CHALLENGE: 50,
  COMPLETE_WEEKLY_CHALLENGE: 200,
  AI_SCORE_ABOVE_60: 30,
  REVIEW_SESSION: 15,
  RECEIVE_HELPFUL_VOTE: 10,
  COMPLETE_LESSON: 10,
  STREAK_7_DAY: 100,
  STREAK_30_DAY: 500,
} as const;

export const COIN_REWARDS = {
  COMPLETE_DAILY_CHALLENGE: 5,
  COMPLETE_WEEKLY_CHALLENGE: 50,
  RECEIVE_HELPFUL_VOTE: 2,
  STREAK_7_DAY: 20,
  STREAK_30_DAY: 100,
} as const;

/**
 * Get or create UserProgress for a user
 */
export async function getOrCreateProgress(userId: string) {
  return prisma.userProgress.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

/**
 * Calculate level from total XP. Level curve: XP needed = level * 100
 * Level 1→2 = 100 XP, Level 2→3 = 200 XP, etc.
 * Total XP for level N = N*(N-1)*50
 */
function calculateLevel(totalXP: number): number {
  // Solve: totalXP >= level*(level-1)*50
  // level = floor((1 + sqrt(1 + totalXP/12.5)) / 2)
  let level = 1;
  let xpNeeded = 0;
  while (xpNeeded + level * 100 <= totalXP) {
    xpNeeded += level * 100;
    level++;
  }
  return level;
}

/**
 * Award XP and coins, update level and streak
 */
export async function awardXP(
  userId: string,
  xp: number,
  coins: number = 0,
  options?: { isRecording?: boolean; isReview?: boolean },
) {
  const progress = await getOrCreateProgress(userId);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];
  const lastActiveStr = progress.lastActiveDate
    ? new Date(progress.lastActiveDate).toISOString().split('T')[0]
    : null;

  let streakDelta = 0;
  let newStreak = progress.currentStreak;

  if (lastActiveStr !== todayStr) {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    if (lastActiveStr === yesterdayStr) {
      // Continuing streak
      streakDelta = 1;
      newStreak = progress.currentStreak + 1;
    } else if (lastActiveStr && lastActiveStr < yesterdayStr) {
      // Streak broken — check for freeze
      if (progress.streakFreezes > 0) {
        streakDelta = 1;
        newStreak = progress.currentStreak + 1;
        await prisma.userProgress.update({
          where: { userId },
          data: { streakFreezes: { decrement: 1 } },
        });
      } else {
        newStreak = 1; // Reset
      }
    } else if (!lastActiveStr) {
      newStreak = 1; // First activity
    }
  }

  const newTotalXP = progress.xp + xp;
  const newLevel = calculateLevel(newTotalXP);
  const longestStreak = Math.max(progress.longestStreak, newStreak);

  // Check weekly XP reset (resets every Sunday)
  const resetDate = new Date(progress.weeklyXPResetAt);
  const now = new Date();
  const daysSinceReset = (now.getTime() - resetDate.getTime()) / (1000 * 60 * 60 * 24);
  let weeklyXP = progress.weeklyXP + xp;
  let weeklyXPResetAt = progress.weeklyXPResetAt;

  if (daysSinceReset >= 7) {
    weeklyXP = xp;
    weeklyXPResetAt = now;
  }

  const updateData: any = {
    xp: newTotalXP,
    level: newLevel,
    coins: progress.coins + coins,
    currentStreak: newStreak,
    longestStreak,
    lastActiveDate: today,
    weeklyXP,
    weeklyXPResetAt,
  };

  if (options?.isRecording) {
    updateData.totalRecordings = { increment: 1 };
  }
  if (options?.isReview) {
    updateData.totalReviewsGiven = { increment: 1 };
  }

  const updated = await prisma.userProgress.update({
    where: { userId },
    data: updateData,
  });

  // Check streak milestones
  if (newStreak === 7 && progress.currentStreak < 7) {
    await awardXP(userId, XP_REWARDS.STREAK_7_DAY, COIN_REWARDS.STREAK_7_DAY);
    await checkAndUnlockAchievement(userId, '7_day_streak');
  }
  if (newStreak === 30 && progress.currentStreak < 30) {
    await awardXP(userId, XP_REWARDS.STREAK_30_DAY, COIN_REWARDS.STREAK_30_DAY);
    await checkAndUnlockAchievement(userId, '30_day_streak');
  }

  return updated;
}

/**
 * Update user's AI skill averages
 */
export async function updateSkillAverages(
  userId: string,
  fluencyWPM: number,
  vocabDiversity: number,
  pronScore: number,
) {
  const progress = await getOrCreateProgress(userId);

  // Running average
  const n = progress.totalRecordings || 1;
  const newFluency = progress.fluencyWPMAvg
    ? (progress.fluencyWPMAvg * (n - 1) + fluencyWPM) / n
    : fluencyWPM;
  const newVocab = progress.vocabDiversityAvg
    ? (progress.vocabDiversityAvg * (n - 1) + vocabDiversity) / n
    : vocabDiversity;
  const newPron = progress.pronScoreAvg
    ? (progress.pronScoreAvg * (n - 1) + pronScore) / n
    : pronScore;

  await prisma.userProgress.update({
    where: { userId },
    data: {
      fluencyWPMAvg: Math.round(newFluency * 10) / 10,
      vocabDiversityAvg: Math.round(newVocab * 10) / 10,
      pronScoreAvg: Math.round(newPron * 10) / 10,
    },
  });
}

// ─── Achievements ────────────────────────────────────────────────

export async function checkAndUnlockAchievement(userId: string, achievementKey: string) {
  const achievement = await prisma.achievement.findUnique({ where: { key: achievementKey } });
  if (!achievement) return null;

  const existing = await prisma.userAchievement.findUnique({
    where: { userId_achievementId: { userId, achievementId: achievement.id } },
  });
  if (existing) return null;

  const unlocked = await prisma.userAchievement.create({
    data: { userId, achievementId: achievement.id },
    include: { achievement: true },
  });

  // Award achievement rewards
  if (achievement.xpReward > 0 || achievement.coinReward > 0) {
    await prisma.userProgress.update({
      where: { userId },
      data: {
        xp: { increment: achievement.xpReward },
        coins: { increment: achievement.coinReward },
      },
    });
  }

  return unlocked;
}

/**
 * Check all achievement conditions for a user
 */
export async function checkAllAchievements(userId: string) {
  const progress = await getOrCreateProgress(userId);
  const unlocked: string[] = [];

  // Recording milestones
  if (progress.totalRecordings >= 1) {
    const r = await checkAndUnlockAchievement(userId, 'first_recording');
    if (r) unlocked.push(r.achievement.key);
  }
  if (progress.totalRecordings >= 10) {
    const r = await checkAndUnlockAchievement(userId, '10_recordings');
    if (r) unlocked.push(r.achievement.key);
  }
  if (progress.totalRecordings >= 50) {
    const r = await checkAndUnlockAchievement(userId, '50_recordings');
    if (r) unlocked.push(r.achievement.key);
  }
  if (progress.totalRecordings >= 100) {
    const r = await checkAndUnlockAchievement(userId, '100_recordings');
    if (r) unlocked.push(r.achievement.key);
  }

  // Review milestones
  if (progress.totalReviewsGiven >= 10) {
    const r = await checkAndUnlockAchievement(userId, 'helpful_reviewer');
    if (r) unlocked.push(r.achievement.key);
  }
  if (progress.totalReviewsGiven >= 50) {
    const r = await checkAndUnlockAchievement(userId, '50_reviews');
    if (r) unlocked.push(r.achievement.key);
  }
  if (progress.totalReviewsGiven >= 100) {
    const r = await checkAndUnlockAchievement(userId, '100_reviews');
    if (r) unlocked.push(r.achievement.key);
  }

  // Streak milestones
  if (progress.currentStreak >= 7) {
    const r = await checkAndUnlockAchievement(userId, '7_day_streak');
    if (r) unlocked.push(r.achievement.key);
  }
  if (progress.currentStreak >= 30) {
    const r = await checkAndUnlockAchievement(userId, '30_day_streak');
    if (r) unlocked.push(r.achievement.key);
  }

  // Level milestones
  if (progress.level >= 5) {
    const r = await checkAndUnlockAchievement(userId, 'level_5');
    if (r) unlocked.push(r.achievement.key);
  }
  if (progress.level >= 10) {
    const r = await checkAndUnlockAchievement(userId, 'level_10');
    if (r) unlocked.push(r.achievement.key);
  }

  return unlocked;
}

/**
 * Get weekly leaderboard
 */
export async function getWeeklyLeaderboard(limit: number = 20) {
  return prisma.userProgress.findMany({
    where: { weeklyXP: { gt: 0 } },
    orderBy: { weeklyXP: 'desc' },
    take: limit,
    include: {
      user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
    },
  });
}

/**
 * Get all-time leaderboard
 */
export async function getAllTimeLeaderboard(limit: number = 20) {
  return prisma.userProgress.findMany({
    where: { xp: { gt: 0 } },
    orderBy: { xp: 'desc' },
    take: limit,
    include: {
      user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
    },
  });
}

/**
 * Get streak leaderboard
 */
export async function getStreakLeaderboard(limit: number = 20) {
  return prisma.userProgress.findMany({
    where: { currentStreak: { gt: 0 } },
    orderBy: { currentStreak: 'desc' },
    take: limit,
    include: {
      user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
    },
  });
}

/**
 * Buy a streak freeze with coins
 */
export async function buyStreakFreeze(userId: string): Promise<{ success: boolean; message: string }> {
  const FREEZE_COST = 50;
  const progress = await getOrCreateProgress(userId);

  if (progress.coins < FREEZE_COST) {
    return { success: false, message: `Not enough coins. Need ${FREEZE_COST}, have ${progress.coins}` };
  }

  await prisma.userProgress.update({
    where: { userId },
    data: {
      coins: { decrement: FREEZE_COST },
      streakFreezes: { increment: 1 },
    },
  });

  return { success: true, message: 'Streak freeze purchased!' };
}

/**
 * Reset weekly XP for all users (called by cron)
 */
export async function resetWeeklyXP() {
  await prisma.userProgress.updateMany({
    data: { weeklyXP: 0, weeklyXPResetAt: new Date() },
  });
}
