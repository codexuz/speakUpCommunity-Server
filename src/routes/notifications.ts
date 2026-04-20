import { Request, Response, Router } from 'express';
import {
  AuthenticatedRequest,
  authenticateRequest,
  requireRole,
} from '../middleware/auth';
import prisma from '../prisma';
import { sendPushToMultiple } from '../notifications';

const router = Router();

router.use(authenticateRequest);

// POST /api/notifications/broadcast — send push notification to all users (admin only)
router.post(
  '/broadcast',
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const { title, body, data } = req.body;

      if (!title || !body) {
        res.status(400).json({ error: 'title and body are required' });
        return;
      }

      if (typeof title !== 'string' || typeof body !== 'string') {
        res.status(400).json({ error: 'title and body must be strings' });
        return;
      }

      if (title.length > 200 || body.length > 1000) {
        res.status(400).json({ error: 'title max 200 chars, body max 1000 chars' });
        return;
      }

      const users = await prisma.user.findMany({
        where: { pushToken: { not: null } },
        select: { pushToken: true },
      });

      const tokens = users
        .map((u) => u.pushToken)
        .filter((t): t is string => t !== null);

      if (tokens.length === 0) {
        res.json({ sent: 0, message: 'No users with push tokens found' });
        return;
      }

      await sendPushToMultiple(tokens, title, body, data);

      const auth = (req as AuthenticatedRequest).auth!;
      console.log(
        `[broadcast] Admin ${auth.username} sent notification to ${tokens.length} users: "${title}"`
      );

      res.json({ sent: tokens.length, message: 'Broadcast notification sent' });
    } catch (error) {
      console.error('Broadcast notification error:', error);
      res.status(500).json({ error: 'Failed to send broadcast notification' });
    }
  }
);

export default router;
