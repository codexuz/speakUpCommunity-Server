import { Job, Worker } from 'bullmq';
import prisma from '../prisma';
import { sendPushNotification } from '../notifications';
import { createRedisConnection } from '../services/redis';
import { sseManager } from '../services/sse';
import { generateWritingAIFeedback } from '../services/writingAiFeedback';
import { awardXP, checkAllAchievements, XP_REWARDS } from '../services/gamification';
import { WritingProcessJob } from '../services/queue';

if (process.env.REDIS_URL) {
  const writingWorker = new Worker<WritingProcessJob>(
    'writing-processing',
    async (job: Job<WritingProcessJob>) => {
      const { responseId, essayText, taskText, examType, userId } = job.data;
      console.log(`Processing writing for response ${responseId}`);

      // ─── AI Feedback Pipeline ─────────────────────────────────
      if (process.env.OPENAI_API_KEY) {
        try {
          await generateWritingAIFeedback(
            BigInt(responseId),
            essayText,
            taskText,
            examType,
          );

          console.log(`Writing AI feedback generated for response ${responseId}`);

          // Notify user that AI feedback is ready
          const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { pushToken: true },
          });
          if (user?.pushToken) {
            await sendPushNotification(
              user.pushToken,
              'Writing baholandi ✍️',
              'AI sizning inshoingizni tekshirdi. Natijalarni ko\'ring!',
              { type: 'writing-ai-feedback', responseId },
            );
          }
          sseManager.sendToUser(userId, 'writing-ai-feedback', {
            responseId,
            message: 'AI feedback is ready',
          });

          // Award XP for writing submission
          await awardXP(userId, XP_REWARDS.SUBMIT_WRITING, 0);

          // Increment totalWritings
          await prisma.userProgress.updateMany({
            where: { userId },
            data: { totalWritings: { increment: 1 } },
          });

          // Check achievements
          await checkAllAchievements(userId);
        } catch (aiError) {
          console.error(
            `Writing AI feedback failed for response ${responseId}:`,
            (aiError as Error).message,
          );
          throw aiError; // Re-throw to trigger BullMQ retry
        }
      } else {
        // No OpenAI key — still award basic XP
        await awardXP(userId, XP_REWARDS.SUBMIT_WRITING, 0).catch(() => {});
        await prisma.userProgress
          .updateMany({
            where: { userId },
            data: { totalWritings: { increment: 1 } },
          })
          .catch(() => {});
        await checkAllAchievements(userId).catch(() => {});
      }

      console.log(`Writing processing complete for response ${responseId}`);
    },
    {
      connection: createRedisConnection(),
      concurrency: 3,
    },
  );

  writingWorker.on('completed', (job) => {
    console.log(`Writing job ${job.id} completed`);
  });

  writingWorker.on('failed', (job, err) => {
    console.error(`Writing job ${job?.id} failed:`, err.message);
  });

  console.log('Writing processing worker started');
}
