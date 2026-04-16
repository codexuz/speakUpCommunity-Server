import prisma from '../prisma';

const ACHIEVEMENTS = [
  // Speaking milestones
  { key: 'first_recording', title: 'First Steps', description: 'Submit your first recording', category: 'speaking', xpReward: 50, coinReward: 10 },
  { key: '10_recordings', title: 'Getting Started', description: 'Submit 10 recordings', category: 'speaking', xpReward: 100, coinReward: 25 },
  { key: '50_recordings', title: 'Dedicated Speaker', description: 'Submit 50 recordings', category: 'speaking', xpReward: 300, coinReward: 75 },
  { key: '100_recordings', title: 'Speaking Master', description: 'Submit 100 recordings', category: 'speaking', xpReward: 500, coinReward: 150 },

  // Review milestones
  { key: 'helpful_reviewer', title: 'Helpful Reviewer', description: 'Give 10 reviews to others', category: 'social', xpReward: 100, coinReward: 25 },
  { key: '50_reviews', title: 'Dedicated Reviewer', description: 'Give 50 reviews', category: 'social', xpReward: 300, coinReward: 75 },
  { key: '100_reviews', title: 'Review Master', description: 'Give 100 reviews', category: 'social', xpReward: 500, coinReward: 150 },

  // Streak milestones
  { key: '7_day_streak', title: 'Week Warrior', description: 'Maintain a 7-day streak', category: 'streak', xpReward: 100, coinReward: 20 },
  { key: '30_day_streak', title: 'Streak Master', description: 'Maintain a 30-day streak', category: 'streak', xpReward: 500, coinReward: 100 },

  // Level milestones
  { key: 'level_5', title: 'Rising Star', description: 'Reach level 5', category: 'mastery', xpReward: 150, coinReward: 50 },
  { key: 'level_10', title: 'Fluency Champion', description: 'Reach level 10', category: 'mastery', xpReward: 300, coinReward: 100 },

  // Community milestones
  { key: 'community_star', title: 'Community Star', description: 'Receive 100 likes on your sessions', category: 'social', xpReward: 300, coinReward: 75 },
  { key: 'first_challenge', title: 'Challenge Accepted', description: 'Complete your first daily challenge', category: 'speaking', xpReward: 50, coinReward: 10 },
  { key: 'course_completer', title: 'Course Completer', description: 'Complete an entire course', category: 'mastery', xpReward: 500, coinReward: 150 },
];

export async function seedAchievements() {
  console.log('Seeding achievements...');
  let created = 0;

  for (const achievement of ACHIEVEMENTS) {
    const existing = await prisma.achievement.findUnique({ where: { key: achievement.key } });
    if (!existing) {
      await prisma.achievement.create({ data: achievement });
      created++;
    }
  }

  console.log(`Achievements seeded: ${created} new, ${ACHIEVEMENTS.length - created} already existed`);
}
