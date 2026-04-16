import { Request, Response, Router } from 'express';
import { AuthenticatedRequest, authenticateRequest } from '../middleware/auth';
import prisma from '../prisma';

const router = Router();

router.use(authenticateRequest);

function getCefrLevel(score: number): string {
  if (score <= 37) return 'A2';
  if (score <= 50) return 'B1';
  if (score <= 64) return 'B2';
  return 'C1';
}

const INCLUDE_SESSION = {
  user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
  test: { select: { id: true, title: true, description: true } },
  _count: { select: { responses: true, reviews: true, comments: true } },
};

// GET /api/community/feed — community feed with strategy + pagination (session-based)
router.get('/feed', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const strategy = (req.query.strategy as string) || 'latest';
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const baseWhere = { visibility: 'community' as const };
    let sessions: any[];
    let total: number;

    switch (strategy) {
      case 'trending': {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const trendingWhere = { ...baseWhere, createdAt: { gte: weekAgo } };
        total = await prisma.testSession.count({ where: trendingWhere });
        sessions = await prisma.testSession.findMany({
          where: trendingWhere,
          orderBy: [
            { likes: 'desc' },
            { commentsCount: 'desc' },
            { createdAt: 'desc' },
          ],
          skip: offset,
          take: limit,
          include: INCLUDE_SESSION,
        });
        break;
      }

      case 'top': {
        total = await prisma.testSession.count({ where: baseWhere });
        sessions = await prisma.testSession.findMany({
          where: baseWhere,
          orderBy: [
            { scoreAvg: { sort: 'desc', nulls: 'last' } },
            { likes: 'desc' },
          ],
          skip: offset,
          take: limit,
          include: INCLUDE_SESSION,
        });
        break;
      }

      default: {
        total = await prisma.testSession.count({ where: baseWhere });
        sessions = await prisma.testSession.findMany({
          where: baseWhere,
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
          include: INCLUDE_SESSION,
        });
        break;
      }
    }

    // Check which sessions the current user has liked
    const sessionIds = sessions.map((s: any) => s.id);
    const userLikes = await prisma.like.findMany({
      where: { sessionId: { in: sessionIds }, userId: auth.userId },
      select: { sessionId: true },
    });
    const likedSet = new Set(userLikes.map((l: any) => l.sessionId.toString()));

    const data = sessions.map((s: any) => ({
      ...s,
      id: s.id.toString(),
      isLiked: likedSet.has(s.id.toString()),
      cefrLevel: s.scoreAvg != null ? getCefrLevel(Math.round(s.scoreAvg)) : null,
      // Anonymize user info if session is anonymous
      user: s.isAnonymous
        ? { id: null, fullName: 'Anonymous Speaker', username: 'anonymous', avatarUrl: null }
        : s.user,
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
