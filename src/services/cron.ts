import cron from 'node-cron';
import prisma from '../prisma';
import { resetWeeklyXP } from '../services/gamification';

/**
 * Initialize all scheduled cron jobs
 */
export function initCronJobs() {
  // Reset weekly XP every Sunday at midnight UTC
  cron.schedule('0 0 * * 0', async () => {
    console.log('[CRON] Resetting weekly XP...');
    try {
      await resetWeeklyXP();
      console.log('[CRON] Weekly XP reset complete');
    } catch (err) {
      console.error('[CRON] Weekly XP reset failed:', err);
    }
  });

  // Check broken streaks daily at 1 AM UTC
  // Users who were active yesterday but not today get their streak preserved (or broken)
  cron.schedule('0 1 * * *', async () => {
    console.log('[CRON] Checking streaks...');
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);

      const twoDaysAgo = new Date();
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      twoDaysAgo.setHours(0, 0, 0, 0);

      // Find users whose last active date is 2+ days ago (streak broken)
      // Users with streak freezes get one used
      const brokenStreaks = await prisma.userProgress.findMany({
        where: {
          currentStreak: { gt: 0 },
          lastActiveDate: { lt: yesterday },
        },
      });

      for (const progress of brokenStreaks) {
        if (progress.streakFreezes > 0) {
          // Use a streak freeze
          await prisma.userProgress.update({
            where: { id: progress.id },
            data: { streakFreezes: { decrement: 1 } },
          });
        } else {
          // Break the streak
          await prisma.userProgress.update({
            where: { id: progress.id },
            data: { currentStreak: 0 },
          });
        }
      }

      console.log(`[CRON] Streak check complete. Processed ${brokenStreaks.length} users`);
    } catch (err) {
      console.error('[CRON] Streak check failed:', err);
    }
  });

  // Auto-create daily challenges at midnight UTC (if none exist for today)
  cron.schedule('0 0 * * *', async () => {
    console.log('[CRON] Checking daily challenge...');
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      const existingDaily = await prisma.challenge.findFirst({
        where: {
          type: 'daily',
          startsAt: { gte: todayStart },
          endsAt: { lte: new Date(todayEnd.getTime() + 24 * 60 * 60 * 1000) },
        },
      });

      if (!existingDaily) {
        // Pick a random prompt from a pool
        const prompts = DAILY_PROMPTS;
        const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24));
        const prompt = prompts[dayOfYear % prompts.length];

        await prisma.challenge.create({
          data: {
            title: prompt.title,
            description: prompt.description,
            type: 'daily',
            difficulty: prompt.difficulty,
            promptText: prompt.promptText,
            startsAt: todayStart,
            endsAt: new Date(todayStart.getTime() + 24 * 60 * 60 * 1000),
            xpReward: 50,
            coinReward: 5,
          },
        });
        console.log(`[CRON] Created daily challenge: "${prompt.title}"`);
      }
    } catch (err) {
      console.error('[CRON] Daily challenge creation failed:', err);
    }
  });

  // Auto-create weekly challenge every Monday at midnight UTC
  cron.schedule('0 0 * * 1', async () => {
    console.log('[CRON] Checking weekly challenge...');
    try {
      const mondayStart = new Date();
      mondayStart.setHours(0, 0, 0, 0);
      const sundayEnd = new Date(mondayStart.getTime() + 7 * 24 * 60 * 60 * 1000);

      const existingWeekly = await prisma.challenge.findFirst({
        where: {
          type: 'weekly',
          startsAt: { gte: mondayStart },
        },
      });

      if (!existingWeekly) {
        const prompts = WEEKLY_PROMPTS;
        const weekOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 1).getTime()) / (7 * 24 * 60 * 60 * 1000));
        const prompt = prompts[weekOfYear % prompts.length];

        await prisma.challenge.create({
          data: {
            title: prompt.title,
            description: prompt.description,
            type: 'weekly',
            difficulty: prompt.difficulty,
            promptText: prompt.promptText,
            startsAt: mondayStart,
            endsAt: sundayEnd,
            xpReward: 200,
            coinReward: 50,
          },
        });
        console.log(`[CRON] Created weekly challenge: "${prompt.title}"`);
      }
    } catch (err) {
      console.error('[CRON] Weekly challenge creation failed:', err);
    }
  });

  console.log('Cron jobs initialized');
}

// ─── Challenge Prompt Pools ─────────────────────────────────────

const DAILY_PROMPTS = [
  { title: 'Morning Routine', difficulty: 'beginner', description: 'Describe your typical morning', promptText: 'Describe your morning routine in 30 seconds. What do you do first? What do you eat for breakfast?' },
  { title: 'Favorite Place', difficulty: 'beginner', description: 'Talk about a place you love', promptText: 'Describe your favorite place to visit. Why do you like it? How does it make you feel?' },
  { title: 'Weekend Plans', difficulty: 'beginner', description: 'Share your weekend plans', promptText: 'What are your plans for this weekend? Or describe what you did last weekend.' },
  { title: 'Best Friend', difficulty: 'beginner', description: 'Talk about your best friend', promptText: 'Describe your best friend. How did you meet? What do you enjoy doing together?' },
  { title: 'Dream Job', difficulty: 'intermediate', description: 'Talk about your dream career', promptText: 'What is your dream job and why? What skills would you need? How would you prepare for it?' },
  { title: 'Cooking Challenge', difficulty: 'intermediate', description: 'Explain a recipe', promptText: 'Explain how to cook your favorite dish, step by step. What ingredients do you need?' },
  { title: 'Travel Story', difficulty: 'intermediate', description: 'Share a travel experience', promptText: 'Tell us about a memorable trip you have taken. What happened? What did you learn?' },
  { title: 'Movie Review', difficulty: 'intermediate', description: 'Review a movie', promptText: 'Review a movie you watched recently. What was it about? Would you recommend it and why?' },
  { title: 'Future Prediction', difficulty: 'advanced', description: 'Predict the future', promptText: 'How do you think the world will change in the next 20 years? Talk about technology, education, or daily life.' },
  { title: 'Cultural Difference', difficulty: 'advanced', description: 'Discuss culture', promptText: 'Describe an interesting cultural difference you have noticed or experienced. How did it affect you?' },
  { title: 'Life Lesson', difficulty: 'intermediate', description: 'Share a life lesson', promptText: 'What is the most important life lesson you have learned? Tell the story behind it.' },
  { title: 'If I Could...', difficulty: 'beginner', description: 'Hypothetical scenario', promptText: 'If you could have any superpower, what would it be and why? How would you use it?' },
  { title: 'My Hobby', difficulty: 'beginner', description: 'Describe a hobby', promptText: 'Talk about a hobby or activity you enjoy. When did you start? Why do you like it?' },
  { title: 'News Story', difficulty: 'advanced', description: 'Discuss current events', promptText: 'Summarize a recent news story in your own words. What do you think about it?' },
  { title: 'Childhood Memory', difficulty: 'intermediate', description: 'Share a memory', promptText: 'Describe your favorite childhood memory. Where were you? Who was with you? Why is it special?' },
  { title: 'Advice Column', difficulty: 'intermediate', description: 'Give advice', promptText: 'A friend is nervous about starting a new job. What advice would you give them?' },
  { title: 'Describe Your City', difficulty: 'beginner', description: 'Talk about where you live', promptText: 'Describe the city or town where you live. What do you like about it? What would you change?' },
  { title: 'Technology Opinion', difficulty: 'advanced', description: 'Discuss technology', promptText: 'Do you think smartphones have made our lives better or worse? Explain your opinion with examples.' },
  { title: 'Health & Fitness', difficulty: 'intermediate', description: 'Talk about health habits', promptText: 'What do you do to stay healthy? Describe your exercise routine or eating habits.' },
  { title: 'Favorite Season', difficulty: 'beginner', description: 'Talk about a season', promptText: 'What is your favorite season and why? Describe what you enjoy doing during that time.' },
  { title: 'Problem Solving', difficulty: 'advanced', description: 'Solve a problem', promptText: 'Describe a problem you faced recently. How did you solve it? What would you do differently?' },
  { title: 'Music & Me', difficulty: 'beginner', description: 'Talk about music', promptText: 'What kind of music do you listen to? Who is your favorite artist? Why do you like their music?' },
  { title: 'Pet Story', difficulty: 'beginner', description: 'Talk about pets', promptText: 'Do you have a pet? If yes, describe them. If not, what pet would you like to have and why?' },
  { title: 'Book Recommendation', difficulty: 'intermediate', description: 'Recommend a book', promptText: 'Recommend a book you have read. What is it about? Why should others read it?' },
  { title: 'Dream Vacation', difficulty: 'intermediate', description: 'Plan a dream trip', promptText: 'If you could travel anywhere in the world, where would you go? What would you do there?' },
  { title: 'Learning English', difficulty: 'beginner', description: 'Reflect on learning', promptText: 'Why are you learning English? What has been the hardest part? What helps you the most?' },
  { title: 'Environmental Issue', difficulty: 'advanced', description: 'Discuss environment', promptText: 'What is one environmental problem you care about? What can individuals do to help?' },
  { title: 'A Funny Story', difficulty: 'intermediate', description: 'Tell something funny', promptText: 'Tell us a funny story that happened to you or someone you know. What made it funny?' },
  { title: 'My Role Model', difficulty: 'intermediate', description: 'Describe someone you admire', promptText: 'Who is someone you admire and why? What have you learned from them?' },
  { title: 'Compare & Contrast', difficulty: 'advanced', description: 'Compare two things', promptText: 'Compare living in a big city versus a small town. What are the advantages and disadvantages of each?' },
  { title: 'Daily Gratitude', difficulty: 'beginner', description: 'Express gratitude', promptText: 'What are three things you are grateful for today? Explain why each one is important to you.' },
];

const WEEKLY_PROMPTS = [
  { title: 'Online vs Offline Learning', difficulty: 'advanced', description: 'Weekly debate challenge', promptText: 'Debate: Is online learning better than traditional classroom learning? Give arguments for your position with examples and evidence.' },
  { title: 'Social Media Impact', difficulty: 'advanced', description: 'Weekly debate challenge', promptText: 'Should children under 13 be allowed to use social media? Present your argument with reasons and examples.' },
  { title: 'AI in Education', difficulty: 'advanced', description: 'Weekly debate challenge', promptText: 'Will artificial intelligence replace human teachers? Share your opinion and support it with examples.' },
  { title: 'Remote Work Future', difficulty: 'advanced', description: 'Weekly discussion', promptText: 'Do you think most people will work from home in the future? Discuss the pros and cons with specific examples.' },
  { title: 'Universal Basic Income', difficulty: 'advanced', description: 'Weekly debate challenge', promptText: 'Should governments provide a universal basic income to all citizens? Present arguments for or against with evidence.' },
  { title: 'Space Exploration', difficulty: 'advanced', description: 'Weekly discussion', promptText: 'Should we spend more money on space exploration or solving problems on Earth? Explain your position.' },
  { title: 'Cultural Preservation', difficulty: 'advanced', description: 'Weekly discussion', promptText: 'How can we preserve traditional cultures in a rapidly globalizing world? Share your ideas with examples.' },
  { title: 'Storytelling Challenge', difficulty: 'intermediate', description: 'Weekly creative challenge', promptText: 'Tell a 2-minute story about a character who discovers something unexpected. Be creative and use vivid descriptions.' },
];
