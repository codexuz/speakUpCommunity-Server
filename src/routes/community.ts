import { Request, Response, Router } from 'express';
import { AuthenticatedRequest, authenticateRequest } from '../middleware/auth';
import prisma from '../prisma';

const router = Router();

router.use(authenticateRequest);

const INCLUDE_SPEAKING = {
  student: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
  question: { select: { qText: true, part: true } },
};

// GET /api/community/feed — community feed with strategy + pagination
router.get('/feed', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const strategy = (req.query.strategy as string) || 'latest';
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const baseWhere = { visibility: 'community' as const };
    let responses: any[];
    let total: number;

    switch (strategy) {
      case 'trending': {
        // Trending: most engagement in last 7 days
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const trendingWhere = { ...baseWhere, createdAt: { gte: weekAgo } };
        total = await prisma.response.count({ where: trendingWhere });
        responses = await prisma.response.findMany({
          where: trendingWhere,
          orderBy: [
            { likes: 'desc' },
            { commentsCount: 'desc' },
            { createdAt: 'desc' },
          ],
          skip: offset,
          take: limit,
          include: INCLUDE_SPEAKING,
        });
        break;
      }

      case 'top': {
        // Top: highest average score, all time
        total = await prisma.response.count({ where: baseWhere });
        responses = await prisma.response.findMany({
          where: baseWhere,
          orderBy: [
            { scoreAvg: { sort: 'desc', nulls: 'last' } },
            { likes: 'desc' },
          ],
          skip: offset,
          take: limit,
          include: INCLUDE_SPEAKING,
        });
        break;
      }

      default: {
        // Latest
        total = await prisma.response.count({ where: baseWhere });
        responses = await prisma.response.findMany({
          where: baseWhere,
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
          include: INCLUDE_SPEAKING,
        });
        break;
      }
    }

    // Check which ones the current user has liked
    const responseIds = responses.map((r: any) => r.id);
    const userLikes = await prisma.like.findMany({
      where: { responseId: { in: responseIds }, userId: auth.userId },
      select: { responseId: true },
    });
    const likedSet = new Set(userLikes.map((l) => l.responseId.toString()));

    const data = responses.map((r: any) => ({
      ...r,
      id: r.id.toString(),
      isLiked: likedSet.has(r.id.toString()),
    }));

    res.json({
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      strategy,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
