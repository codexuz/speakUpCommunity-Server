import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { getRedis } from '../services/redis';

export function createRateLimiter(options?: {
  windowMs?: number;
  max?: number;
  prefix?: string;
}) {
  const { windowMs = 60_000, max = 60, prefix = 'rl:' } = options || {};

  const store = process.env.REDIS_URL
    ? new RedisStore({
        sendCommand: async (...args: string[]) =>
          getRedis().call(args[0], ...args.slice(1)) as any,
        prefix,
      })
    : undefined; // Falls back to in-memory store

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    message: { error: 'Too many requests, please try again later' },
  });
}

export const defaultLimiter = createRateLimiter();

export const authLimiter = createRateLimiter({
  windowMs: 15 * 60_000, // 15 minutes
  max: 20,
  prefix: 'rl:auth:',
});

export const uploadLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 10,
  prefix: 'rl:upload:',
});
