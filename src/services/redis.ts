import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let sharedRedis: Redis | null = null;

/** Shared Redis connection for general use (caching, rate limiting) */
export function getRedis(): Redis {
  if (!sharedRedis) {
    sharedRedis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: null, // Required by BullMQ
    });
    sharedRedis.on('error', (err) => console.error('Redis error:', err));
  }
  return sharedRedis;
}

/** Creates a new dedicated Redis connection (for BullMQ Queue/Worker) */
export function createRedisConnection(): Redis {
  return new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
  });
}

export async function closeRedis(): Promise<void> {
  if (sharedRedis) {
    await sharedRedis.quit();
    sharedRedis = null;
  }
}
