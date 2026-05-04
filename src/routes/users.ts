import { Request, Response, Router } from 'express';
import {
  AuthenticatedRequest,
  authenticateRequest,
  blacklistToken,
  isPasswordHash,
  requireRole,
  revokeAllSessions,
  verifyPassword,
} from '../middleware/auth';
import prisma from '../prisma';
import { sendPushNotification } from '../notifications';
import { deleteAudio } from '../services/minio';

const router = Router();

router.use(authenticateRequest);

function parsePaging(req: Request) {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
  const skip = (page - 1) * limit;

  return { page, limit, skip };
}

function mapUserSummary(user: {
  id: string;
  username: string;
  fullName: string;
  avatarUrl: string | null;
  role: string;
  verifiedTeacher: boolean;
}) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl,
    role: user.role,
    verifiedTeacher: user.verifiedTeacher,
  };
}

// DELETE /api/users/me  — authenticated user deletes their own account
router.delete('/me', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const { password } = req.body as { password?: string };

    if (!password) {
      res.status(400).json({ error: 'Password is required to delete your account' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { id: true, password: true, avatarUrl: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const passwordMatches = isPasswordHash(user.password)
      ? await verifyPassword(password, user.password)
      : user.password === password;

    if (!passwordMatches) {
      res.status(401).json({ error: 'Incorrect password' });
      return;
    }

    // Revoke all Redis sessions before deletion
    await revokeAllSessions(auth.userId);

    // Blacklist the current token
    const token = (req.headers.authorization as string).slice(7);
    await blacklistToken(token);

    // Delete avatar from object storage if present
    // if (user.avatarUrl) {
    //   try {
    //     const fileName = user.avatarUrl.split('/').pop();
    //     if (fileName) await deleteAudio(fileName);
    //   } catch {
    //     // Non-fatal — proceed with account deletion
    //   }
    // }

    await prisma.user.delete({ where: { id: auth.userId } });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/users/admin/:userId  — admin deletes any account
router.delete('/admin/:userId', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId as string;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, avatarUrl: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Revoke all Redis sessions for the target user
    await revokeAllSessions(userId);

    // Delete avatar from object storage if present
    if (user.avatarUrl) {
      try {
        const fileName = user.avatarUrl.split('/').pop();
        if (fileName) await deleteAudio(fileName);
      } catch {
        // Non-fatal — proceed with account deletion
      }
    }

    await prisma.user.delete({ where: { id: userId } });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/users/:userId/follow
router.post('/:userId/follow', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const userId = req.params.userId as string;

    if (userId === auth.userId) {
      res.status(400).json({ error: 'You cannot follow yourself' });
      return;
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!targetUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const existing = await prisma.userFollow.findUnique({
      where: {
        followerId_followingId: {
          followerId: auth.userId,
          followingId: userId,
        },
      },
    });

    if (existing) {
      res.status(409).json({ error: 'Already following this user' });
      return;
    }

    await prisma.userFollow.create({
      data: {
        followerId: auth.userId,
        followingId: userId,
      },
    });

    res.json({ success: true });

    // Push notification to the followed user
    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { pushToken: true },
    });
    if (target?.pushToken) {
      sendPushNotification(
        target.pushToken,
        'New follower',
        `${auth.username} started following you`,
        { type: 'new-follower', userId: auth.userId },
      ).catch(() => {});
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/users/:userId/follow
router.delete('/:userId/follow', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const userId = req.params.userId as string;

    if (userId === auth.userId) {
      res.status(400).json({ error: 'You cannot unfollow yourself' });
      return;
    }

    const existing = await prisma.userFollow.findUnique({
      where: {
        followerId_followingId: {
          followerId: auth.userId,
          followingId: userId,
        },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Not following this user' });
      return;
    }

    await prisma.userFollow.delete({
      where: {
        followerId_followingId: {
          followerId: auth.userId,
          followingId: userId,
        },
      },
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/users/:userId/followers
router.get('/:userId/followers', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const userId = req.params.userId as string;
    const { page, limit, skip } = parsePaging(req);

    const userExists = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!userExists) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const [total, rows] = await prisma.$transaction([
      prisma.userFollow.count({ where: { followingId: userId } }),
      prisma.userFollow.findMany({
        where: { followingId: userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          follower: {
            select: {
              id: true,
              username: true,
              fullName: true,
              avatarUrl: true,
              role: true,
              verifiedTeacher: true,
            },
          },
        },
      }),
    ]);

    const followerIds = rows.map((r) => r.followerId);
    const myFollowing = followerIds.length
      ? await prisma.userFollow.findMany({
          where: {
            followerId: auth.userId,
            followingId: { in: followerIds },
          },
          select: { followingId: true },
        })
      : [];

    const myFollowingSet = new Set(myFollowing.map((r) => r.followingId));

    res.json({
      data: rows.map((r) => ({
        ...mapUserSummary(r.follower),
        isFollowing: myFollowingSet.has(r.followerId),
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/users/:userId/following
router.get('/:userId/following', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const userId = req.params.userId as string;
    const { page, limit, skip } = parsePaging(req);

    const userExists = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!userExists) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const [total, rows] = await prisma.$transaction([
      prisma.userFollow.count({ where: { followerId: userId } }),
      prisma.userFollow.findMany({
        where: { followerId: userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          following: {
            select: {
              id: true,
              username: true,
              fullName: true,
              avatarUrl: true,
              role: true,
              verifiedTeacher: true,
            },
          },
        },
      }),
    ]);

    const followingIds = rows.map((r) => r.followingId);
    const myFollowing = followingIds.length
      ? await prisma.userFollow.findMany({
          where: {
            followerId: auth.userId,
            followingId: { in: followingIds },
          },
          select: { followingId: true },
        })
      : [];

    const myFollowingSet = new Set(myFollowing.map((r) => r.followingId));

    res.json({
      data: rows.map((r) => ({
        ...mapUserSummary(r.following),
        isFollowing: myFollowingSet.has(r.followingId),
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/users/:userId
router.get('/:userId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const userId = req.params.userId as string;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        fullName: true,
        role: true,
        verifiedTeacher: true,
        avatarUrl: true,
        gender: true,
        region: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const [followersCount, followingCount, meFollowsUser, userFollowsMe] = await prisma.$transaction([
      prisma.userFollow.count({ where: { followingId: userId } }),
      prisma.userFollow.count({ where: { followerId: userId } }),
      prisma.userFollow.findUnique({
        where: {
          followerId_followingId: {
            followerId: auth.userId,
            followingId: userId,
          },
        },
        select: { id: true },
      }),
      prisma.userFollow.findUnique({
        where: {
          followerId_followingId: {
            followerId: userId,
            followingId: auth.userId,
          },
        },
        select: { id: true },
      }),
    ]);

    res.json({
      user,
      stats: {
        followers: followersCount,
        following: followingCount,
      },
      relationship: {
        isMe: auth.userId === userId,
        isFollowing: Boolean(meFollowsUser),
        followsMe: Boolean(userFollowsMe),
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
