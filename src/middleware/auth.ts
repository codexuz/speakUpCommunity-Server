import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import { getRedis } from '../services/redis';

const TOKEN_BLACKLIST_PREFIX = 'bl:';
const SESSION_PREFIX = 'sess:';
const USER_SESSIONS_PREFIX = 'usess:';

export interface AuthTokenClaims {
  userId: string;
  role: string;
  username: string;
  sessionId: string;
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  device: string;
  ip: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthTokenClaims;
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is required');
  }
  return secret;
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function isPasswordHash(value: string) {
  return value.startsWith('$2a$') || value.startsWith('$2b$') || value.startsWith('$2y$');
}

export function signAuthToken(payload: Omit<AuthTokenClaims, 'sessionId'> & { sessionId: string }) {
  const expiresIn = (process.env.JWT_EXPIRES_IN || '7d') as SignOptions['expiresIn'];

  return jwt.sign(
    {
      role: payload.role,
      username: payload.username,
    },
    getJwtSecret(),
    {
      expiresIn,
      subject: payload.userId,
      jwtid: payload.sessionId,
    }
  );
}

/* ── Session helpers ──────────────────────────────────────────── */

function getSessionTtlSeconds(): number {
  const raw = process.env.JWT_EXPIRES_IN || '7d';
  const match = raw.match(/^(\d+)(d|h|m|s)?$/);
  if (!match) return 7 * 86400;
  const num = parseInt(match[1]);
  switch (match[2]) {
    case 'd': return num * 86400;
    case 'h': return num * 3600;
    case 'm': return num * 60;
    default: return num;
  }
}

export async function createSession(userId: string, device: string, ip: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const ttl = getSessionTtlSeconds();
  const redis = getRedis();
  const key = `${SESSION_PREFIX}${sessionId}`;

  await redis
    .pipeline()
    .hset(key, { userId, device, ip, createdAt: now, lastActiveAt: now })
    .expire(key, ttl)
    .sadd(`${USER_SESSIONS_PREFIX}${userId}`, sessionId)
    .exec();

  return sessionId;
}

export async function getUserSessions(userId: string): Promise<SessionInfo[]> {
  const redis = getRedis();
  const sessionIds = await redis.smembers(`${USER_SESSIONS_PREFIX}${userId}`);
  const sessions: SessionInfo[] = [];

  for (const sid of sessionIds) {
    const data = await redis.hgetall(`${SESSION_PREFIX}${sid}`);
    if (data && data.userId) {
      sessions.push({ sessionId: sid, ...data } as SessionInfo);
    } else {
      // session expired – clean up the set entry
      await redis.srem(`${USER_SESSIONS_PREFIX}${userId}`, sid);
    }
  }

  return sessions;
}

export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
  const redis = getRedis();
  const deleted = await redis.del(`${SESSION_PREFIX}${sessionId}`);
  await redis.srem(`${USER_SESSIONS_PREFIX}${userId}`, sessionId);
  return deleted > 0;
}

export async function revokeAllSessions(userId: string): Promise<number> {
  const redis = getRedis();
  const sessionIds = await redis.smembers(`${USER_SESSIONS_PREFIX}${userId}`);
  if (sessionIds.length > 0) {
    await redis.del(...sessionIds.map((id) => `${SESSION_PREFIX}${id}`));
  }
  await redis.del(`${USER_SESSIONS_PREFIX}${userId}`);
  return sessionIds.length;
}

/** Add a token to the blacklist until its natural expiry. */
export async function blacklistToken(token: string): Promise<void> {
  try {
    const decoded = jwt.decode(token) as JwtPayload | null;
    if (!decoded?.exp) return;

    const ttl = decoded.exp - Math.floor(Date.now() / 1000);
    if (ttl <= 0) return; // already expired

    await getRedis().set(`${TOKEN_BLACKLIST_PREFIX}${token}`, '1', 'EX', ttl);
  } catch {
    // ignore decode errors – token is already invalid
  }
}

/** Check whether a token has been blacklisted. */
export async function isTokenBlacklisted(token: string): Promise<boolean> {
  const result = await getRedis().get(`${TOKEN_BLACKLIST_PREFIX}${token}`);
  return result !== null;
}

export async function authenticateRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization token is required' });
      return;
    }

    const token = authHeader.slice('Bearer '.length).trim();

    if (await isTokenBlacklisted(token)) {
      res.status(401).json({ error: 'Token has been revoked' });
      return;
    }

    const decoded = jwt.verify(token, getJwtSecret()) as JwtPayload;
    const subject = typeof decoded.sub === 'string' ? decoded.sub : null;
    const sessionId = typeof decoded.jti === 'string' ? decoded.jti : null;

    if (!subject || typeof decoded.role !== 'string' || typeof decoded.username !== 'string') {
      res.status(401).json({ error: 'Invalid authorization token' });
      return;
    }

    // Verify the session is still active
    if (sessionId) {
      const redis = getRedis();
      const exists = await redis.exists(`${SESSION_PREFIX}${sessionId}`);
      if (!exists) {
        res.status(401).json({ error: 'Session has been revoked' });
        return;
      }
      // touch lastActiveAt (fire-and-forget)
      redis.hset(`${SESSION_PREFIX}${sessionId}`, 'lastActiveAt', new Date().toISOString());
    }

    (req as AuthenticatedRequest).auth = {
      userId: subject,
      role: decoded.role,
      username: decoded.username,
      sessionId: sessionId || '',
    };

    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired authorization token' });
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      res.status(401).json({ error: 'Authentication is required' });
      return;
    }

    if (!roles.includes(auth.role)) {
      res.status(403).json({ error: 'You do not have access to this resource' });
      return;
    }

    next();
  };
}