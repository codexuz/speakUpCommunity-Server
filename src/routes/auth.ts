import { Request, Response, Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
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
import { uploadImage } from '../services/minio';
import { sendPasswordResetCode, verifyResetCode } from '../services/telegramBot';

const router = Router();

function serializeUser(user: {
  id: string;
  username: string;
  phone: string | null;
  fullName: string;
  role: string;
  verifiedTeacher: boolean;
  avatarUrl: string | null;
  gender: string | null;
  region: string | null;
}) {
  return {
    id: user.id,
    username: user.username,
    phone: user.phone,
    fullName: user.fullName,
    role: user.role,
    verifiedTeacher: user.verifiedTeacher,
    avatarUrl: user.avatarUrl,
    gender: user.gender,
    region: user.region,
  };
}

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { login, password } = req.body;
    if (!login || !password) {
      res.status(400).json({ error: 'Username/phone and password are required' });
      return;
    }

    let user = await prisma.user.findUnique({ where: { username: login } });
    if (!user) {
      user = await prisma.user.findUnique({ where: { phone: login } });
    }
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
    const { username, phone, fullName, password, gender, region, avatarUrl, role } = req.body;
    if (!username || !fullName || !password) {
      res.status(400).json({ error: 'Username, fullName, and password are required' });
      return;
    }

    const validRoles = ['student', 'teacher'];
    const userRole = validRoles.includes(role) ? role : 'student';

    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { username },
          ...(phone ? [{ phone }] : []),
        ],
      },
    });
    if (existing) {
      const field = existing.username === username ? 'Username' : 'Phone';
      res.status(409).json({ error: `${field} already taken` });
      return;
    }

    const user = await prisma.user.create({
      data: {
        username,
        phone: phone || null,
        fullName,
        password: await hashPassword(password),
        role: userRole,
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

// PUT /api/auth/profile — update current user's profile
router.put('/profile', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const { fullName, gender, region, phone } = req.body;

    if (phone !== undefined && phone !== null) {
      const phoneTaken = await prisma.user.findFirst({
        where: { phone, id: { not: auth.userId } },
      });
      if (phoneTaken) {
        res.status(409).json({ error: 'Phone already taken' });
        return;
      }
    }

    const user = await prisma.user.update({
      where: { id: auth.userId },
      data: {
        ...(fullName !== undefined && { fullName }),
        ...(gender !== undefined && { gender }),
        ...(region !== undefined && { region }),
        ...(phone !== undefined && { phone: phone || null }),
      },
    });

    res.json(serializeUser(user));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/auth/avatar — upload/update current user's avatar
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

router.put('/avatar', authenticateRequest, avatarUpload.single('avatar'), async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'avatar file is required' });
      return;
    }

    const ext = file.originalname.split('.').pop() || 'jpg';
    const fileName = `avatars/users/${auth.userId}-${uuidv4()}.${ext}`;
    const avatarUrl = await uploadImage(fileName, file.buffer, file.mimetype);

    const user = await prisma.user.update({
      where: { id: auth.userId },
      data: { avatarUrl },
    });

    res.json(serializeUser(user));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/auth/telegram-link — get Telegram deep link for account linking
router.get('/telegram-link', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const botUsername = process.env.TELEGRAM_BOT_USERNAME;
    if (!botUsername) {
      res.status(503).json({ error: 'Telegram bot is not configured' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: auth.userId } });
    const linked = Boolean(user?.telegramChatId);
    const deepLink = `https://t.me/${botUsername}?start=${encodeURIComponent(auth.username)}`;

    res.json({ deepLink, linked });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/password-reset/request — request a 6-digit reset code via Telegram
router.post('/password-reset/request', async (req: Request, res: Response) => {
  try {
    const { login } = req.body;
    if (!login) {
      res.status(400).json({ error: 'Username or phone is required' });
      return;
    }

    let user = await prisma.user.findUnique({ where: { username: login } });
    if (!user) {
      user = await prisma.user.findUnique({ where: { phone: login } });
    }
    if (!user || !user.telegramChatId) {
      // Return generic message to avoid user enumeration
      res.json({ message: 'If the account exists and Telegram is linked, a code has been sent.' });
      return;
    }

    await sendPasswordResetCode(user.id);
    res.json({ message: 'If the account exists and Telegram is linked, a code has been sent.' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/password-reset/confirm — verify code and set new password
router.post('/password-reset/confirm', async (req: Request, res: Response) => {
  try {
    const { login, code, newPassword } = req.body;
    if (!login || !code || !newPassword) {
      res.status(400).json({ error: 'login, code, and newPassword are required' });
      return;
    }

    if (newPassword.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    let user = await prisma.user.findUnique({ where: { username: login } });
    if (!user) {
      user = await prisma.user.findUnique({ where: { phone: login } });
    }
    if (!user) {
      res.status(400).json({ error: 'Invalid code or account' });
      return;
    }

    const valid = await verifyResetCode(user.id, code);
    if (!valid) {
      res.status(400).json({ error: 'Invalid or expired code' });
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { password: await hashPassword(newPassword) },
    });

    res.json({ message: 'Password reset successful' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
