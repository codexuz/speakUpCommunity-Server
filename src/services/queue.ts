import { Queue } from 'bullmq';
import { createRedisConnection } from './redis';

export interface AudioProcessJob {
  responseId: string;
  fileName: string;
  userId: string;
}

let _audioQueue: Queue<AudioProcessJob> | null = null;

function getAudioQueue(): Queue<AudioProcessJob> | null {
  if (!process.env.REDIS_URL) return null;
  if (!_audioQueue) {
    _audioQueue = new Queue<AudioProcessJob>('audio-processing', {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      },
    });
  }
  return _audioQueue;
}

export async function enqueueAudioJob(data: AudioProcessJob): Promise<void> {
  const queue = getAudioQueue();
  if (!queue) return;
  await queue.add('compress', data, { priority: 1 });
}

// ─── Writing Processing Queue ───────────────────────────────────

export interface WritingProcessJob {
  responseId: string;
  essayText: string;
  taskText: string;
  examType: 'ielts' | 'cefr';
  userId: string;
}

let _writingQueue: Queue<WritingProcessJob> | null = null;

function getWritingQueue(): Queue<WritingProcessJob> | null {
  if (!process.env.REDIS_URL) return null;
  if (!_writingQueue) {
    _writingQueue = new Queue<WritingProcessJob>('writing-processing', {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      },
    });
  }
  return _writingQueue;
}

export async function enqueueWritingJob(data: WritingProcessJob): Promise<void> {
  const queue = getWritingQueue();
  if (!queue) return;
  await queue.add('assess', data, { priority: 1 });
}
