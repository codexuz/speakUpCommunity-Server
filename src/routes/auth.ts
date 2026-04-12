import { Request, Response, Router } from 'express';
import {
  AuthenticatedRequest,
  authenticateRequest,
  blacklistToken,
  createSession,
  getUserSessions,
  hashPassword,
  isPasswordHash,
  revokeAllSessions,
  revokeSession,
  signAuthToken,
  verifyPassword,
} from '../middleware/auth';
import prisma from '../prisma';

const router = Router();

function serializeUser(user: {
  id: string;
  username: string;
  fullName: string;
  role: string;
  avatarUrl: string | null;
  gender: string | null;
  region: string | null;
}) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    avatarUrl: user.avatarUrl,
    gender: user.gender,
    region: user.region,
  };
}

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const passwordMatches = isPasswordHash(user.password)
      ? await verifyPassword(password, user.password)
      : user.password === password;

    if (!passwordMatches) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    if (!isPasswordHash(user.password)) {
      await prisma.user.update({
        where: { id: user.id },
        data: { password: await hashPassword(password) },
      });
    }

    const device = req.headers['user-agent'] || 'unknown';
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const sessionId = await createSession(user.id, device, ip);

    const token = signAuthToken({
      userId: user.id,
      role: user.role,
      username: user.username,
      sessionId,
    });

    res.json({
      token,
      user: serializeUser(user),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, fullName, password, gender, region, avatarUrl } = req.body;
    if (!username || !fullName || !password) {
      res.status(400).json({ error: 'Username, fullName, and password are required' });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      res.status(409).json({ error: 'Username already taken' });
      return;
    }

    const user = await prisma.user.create({
      data: {
        username,
        fullName,
        password: await hashPassword(password),
        role: 'student',
        gender,
        region,
        avatarUrl,
      },
    });

    const device = req.headers['user-agent'] || 'unknown';
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const sessionId = await createSession(user.id, device, ip);

    const token = signAuthToken({
      userId: user.id,
      role: user.role,
      username: user.username,
      sessionId,
    });

    res.status(201).json({
      token,
      user: serializeUser(user),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const token = req.headers.authorization!.slice('Bearer '.length).trim();
    await blacklistToken(token);
    if (auth.sessionId) {
      await revokeSession(auth.userId, auth.sessionId);
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/auth/sessions – list active sessions for current user
router.get('/sessions', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const sessions = await getUserSessions(auth.userId);
    res.json({
      sessions: sessions.map((s) => ({
        ...s,
        current: s.sessionId === auth.sessionId,
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/auth/sessions – revoke all sessions (logout everywhere)
router.delete('/sessions', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const count = await revokeAllSessions(auth.userId);
    res.json({ revoked: count });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/auth/sessions/:sessionId – revoke a specific session
router.delete('/sessions/:sessionId', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const sessionId = req.params.sessionId as string;
    const revoked = await revokeSession(auth.userId, sessionId);
    if (!revoked) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/auth/push-token
router.put('/push-token', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const { pushToken } = req.body;
    if (!pushToken) {
      res.status(400).json({ error: 'pushToken is required' });
      return;
    }

    await prisma.user.update({
      where: { id: auth.userId },
      data: { pushToken },
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
