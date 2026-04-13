import { RequestStatus } from '@prisma/client';
import { Request, Response, Router } from 'express';
import { AuthenticatedRequest, authenticateRequest } from '../middleware/auth';
import { sendTelegramNotification } from '../notifications';
import prisma from '../prisma';

const router = Router();

router.use(authenticateRequest);

// POST /api/teacher-verification — request teacher role
router.post('/', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const user = await prisma.user.findUnique({ where: { id: auth.userId } });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (user.verifiedTeacher) {
      res.status(400).json({ error: 'Already a verified teacher' });
      return;
    }

    const pending = await prisma.teacherVerification.findFirst({
      where: { userId: auth.userId, status: 'pending' },
    });
    if (pending) {
      res.status(409).json({ error: 'You already have a pending request' });
      return;
    }

    const { reason } = req.body;
    const request = await prisma.teacherVerification.create({
      data: { userId: auth.userId, reason },
    });

    sendTelegramNotification(
      `📩 <b>New Teacher Verification Request</b>\n\n` +
      `<b>User:</b> ${user.fullName} (@${user.username})\n` +
      `<b>Reason:</b> ${reason || 'Not provided'}\n` +
      `<b>ID:</b> ${request.id}`
    ).catch(() => {});

    res.status(201).json(request);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/teacher-verification/me — get my latest verification status
router.get('/me', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const request = await prisma.teacherVerification.findFirst({
      where: { userId: auth.userId },
      orderBy: { createdAt: 'desc' },
    });
    if (!request) {
      res.status(404).json({ error: 'No verification request found' });
      return;
    }
    res.json(request);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/teacher-verification — list all requests (admin only)
router.get('/', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'admin') {
      res.status(403).json({ error: 'Admin only' });
      return;
    }
    const status = req.query.status as RequestStatus | undefined;
    const requests = await prisma.teacherVerification.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
      },
    });
    res.json(requests);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/teacher-verification/:id — approve or reject (admin only)
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'admin') {
      res.status(403).json({ error: 'Admin only' });
      return;
    }

    const id = BigInt(req.params.id as string);
    const { status, reviewNote } = req.body;
    if (status !== 'approved' && status !== 'rejected') {
      res.status(400).json({ error: 'status must be "approved" or "rejected"' });
      return;
    }

    const verification = await prisma.teacherVerification.findUnique({ where: { id } });
    if (!verification) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    if (verification.status !== 'pending') {
      res.status(400).json({ error: 'Request already reviewed' });
      return;
    }

    const updated = await prisma.teacherVerification.update({
      where: { id },
      data: { status, reviewedBy: auth.userId, reviewNote },
    });

    if (status === 'approved') {
      await prisma.user.update({
        where: { id: verification.userId },
        data: { role: 'teacher', verifiedTeacher: true },
      });
    }

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
