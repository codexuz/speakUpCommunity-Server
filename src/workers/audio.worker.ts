import { Job, Worker } from 'bullmq';
import prisma from '../prisma';
import { getAudioBuffer, uploadAudio } from '../services/minio';
import { createRedisConnection } from '../services/redis';

interface AudioProcessJob {
  responseId: string;
  fileName: string;
  userId: string;
}

if (process.env.REDIS_URL) {
  const audioWorker = new Worker<AudioProcessJob>(
    'audio-processing',
    async (job: Job<AudioProcessJob>) => {
      const { responseId, fileName } = job.data;
      console.log(`Processing audio for response ${responseId}: ${fileName}`);

      // Get original audio from MinIO
      const buffer = await getAudioBuffer(fileName);

      // TODO: Integrate ffmpeg or similar for actual audio compression
      // Example: const compressed = await compressWithFfmpeg(buffer);
      // For now, re-upload as "processed" to demonstrate the pipeline
      const processedFileName = fileName.replace(/(\.[^.]+)$/, '_processed$1');
      await uploadAudio(processedFileName, buffer, 'audio/m4a');

      // Update DB: mark as processed, update URL to processed file
      await prisma.response.update({
        where: { id: BigInt(responseId) },
        data: {
          audioProcessed: true,
          remoteUrl: processedFileName,
        },
      });

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
