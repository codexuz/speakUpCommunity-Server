import { Job, Worker } from 'bullmq';
import path from 'path';
import fs from 'fs';
import prisma from '../prisma';
import {
  downloadToTmpFile,
  compressVideoFile,
  uploadCompressedVideo,
  deleteObject,
} from '../services/minio';
import { createRedisConnection } from '../services/redis';
import { sseManager } from '../services/sse';
import { VideoCompressJob } from '../services/queue';

if (process.env.REDIS_URL) {
  const videoWorker = new Worker<VideoCompressJob>(
    'video-compression',
    async (job: Job<VideoCompressJob>) => {
      const { mediaId, userId, rawObjectKey, ext } = job.data;
      const mediaIdBig = BigInt(mediaId);

      console.log(`[video-worker] Starting compression for mediaId=${mediaId}`);

      // Notify client: compression started
      sseManager.sendToUser(userId, 'video:processing', {
        mediaId,
        status: 'processing',
      });

      // 1. Download raw upload from MinIO to a local temp file
      const baseName = `vid_${mediaId}_${Date.now()}`;
      const rawTmpPath = await downloadToTmpFile(rawObjectKey, `${baseName}.${ext}`);

      let outputPath: string | null = null;
      let thumbPath: string | null = null;

      try {
        await job.updateProgress(10);

        // 2. Compress with ffmpeg
        const result = await compressVideoFile(rawTmpPath, baseName);
        outputPath = result.outputPath;
        thumbPath = result.thumbPath;

        await job.updateProgress(70);

        // 3. Upload compressed video + thumbnail to MinIO
        const outKey = `threads/${mediaId}.mp4`;
        const thumbKey = `threads/${mediaId}_thumb.jpg`;

        const { url, thumbnailUrl, durationSecs } = await uploadCompressedVideo(
          outputPath,
          thumbPath,
          outKey,
          thumbKey,
          result.durationSecs,
        );

        await job.updateProgress(90);

        // 4. Update ThreadMedia record in DB
        await prisma.threadMedia.update({
          where: { id: mediaIdBig },
          data: {
            url,
            thumbnailUrl: thumbnailUrl || null,
            durationSecs,
            mimeType: 'video/mp4',
          },
        });

        // 5. Delete the raw temp object from MinIO
        await deleteObject(rawObjectKey);

        await job.updateProgress(100);

        console.log(`[video-worker] Done: mediaId=${mediaId} -> ${url}`);

        // 6. SSE: notify the client that the video is ready
        sseManager.sendToUser(userId, 'video:ready', {
          mediaId,
          url,
          thumbnailUrl: thumbnailUrl || null,
          durationSecs,
        });
      } finally {
        // Clean up local temp files
        for (const p of [rawTmpPath, outputPath, thumbPath]) {
          if (p) {
            try { fs.unlinkSync(p); } catch { /* ignore */ }
          }
        }
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 2, // process up to 2 videos at once
    },
  );

  videoWorker.on('failed', (job, err) => {
    console.error(`[video-worker] Job ${job?.id} failed:`, err.message);
    if (job?.data?.userId) {
      sseManager.sendToUser(job.data.userId, 'video:error', {
        mediaId: job.data.mediaId,
        error: 'Video processing failed. Please try again.',
      });
    }
  });
}
