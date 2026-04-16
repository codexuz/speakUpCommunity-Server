import { Job, Worker } from 'bullmq';
import prisma from '../prisma';
import { getAudioBuffer, uploadAudio } from '../services/minio';
import { createRedisConnection } from '../services/redis';
import { generateAIFeedback } from '../services/aiFeedback';
import { awardXP, updateSkillAverages, checkAllAchievements, XP_REWARDS } from '../services/gamification';

interface AudioProcessJob {
  responseId: string;
  fileName: string;
  userId: string;
}

if (process.env.REDIS_URL) {
  const audioWorker = new Worker<AudioProcessJob>(
    'audio-processing',
    async (job: Job<AudioProcessJob>) => {
      const { responseId, fileName, userId } = job.data;
      console.log(`Processing audio for response ${responseId}: ${fileName}`);

      // Get original audio from MinIO
      const buffer = await getAudioBuffer(fileName);

      // TODO: Integrate ffmpeg or similar for actual audio compression
      // Example: const compressed = await compressWithFfmpeg(buffer);
      // For now, re-upload as "processed" to demonstrate the pipeline
      const processedFileName = fileName.replace(/(\.[^.]+)$/, '_processed$1');
      const processedUrl = await uploadAudio(processedFileName, buffer, 'audio/m4a');

      // Update DB: mark as processed, update URL to processed file
      await prisma.response.update({
        where: { id: BigInt(responseId) },
        data: {
          audioProcessed: true,
          remoteUrl: processedUrl,
        },
      });

      // ─── AI Feedback Pipeline ─────────────────────────────────
      if (process.env.OPENAI_API_KEY && process.env.DEEPGRAM_API_KEY) {
        try {
          // Get question text for context
          const response = await prisma.response.findUnique({
            where: { id: BigInt(responseId) },
            include: { question: { select: { qText: true } } },
          });

          const questionText = response?.question?.qText || 'General speaking practice';

          await generateAIFeedback(
            BigInt(responseId),
            buffer,
            'audio/m4a',
            questionText,
          );

          console.log(`AI feedback generated for response ${responseId}`);

          // ─── Gamification: Award XP for recording ──────────────
          await awardXP(userId, XP_REWARDS.SUBMIT_RECORDING, 0, { isRecording: true });

          // Check if AI score > 60 for bonus XP
          const feedback = await prisma.aIFeedback.findUnique({
            where: { responseId: BigInt(responseId) },
          });

          if (feedback) {
            if (feedback.overallScore > 60) {
              await awardXP(userId, XP_REWARDS.AI_SCORE_ABOVE_60, 0);
            }

            // Update skill averages
            await updateSkillAverages(
              userId,
              feedback.fluencyWPM,
              feedback.vocabDiversity,
              feedback.pronScore,
            );
          }

          // Check achievements
          await checkAllAchievements(userId);
        } catch (aiError) {
          console.error(`AI feedback failed for response ${responseId}:`, (aiError as Error).message);
          // Don't fail the entire job — audio processing succeeded
        }
      } else {
        // No AI keys — still award basic XP for recording
        await awardXP(userId, XP_REWARDS.SUBMIT_RECORDING, 0, { isRecording: true }).catch(() => {});
      }

      console.log(`Audio processing complete for response ${responseId}`);
    },
    {
      connection: createRedisConnection(),
      concurrency: 2,
    },
  );

  audioWorker.on('completed', (job) => {
    console.log(`Audio job ${job.id} completed`);
  });

  audioWorker.on('failed', (job, err) => {
    console.error(`Audio job ${job?.id} failed:`, err.message);
  });

  console.log('Audio processing worker started');
}
