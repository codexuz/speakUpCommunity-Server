import { Request, Response, Router } from 'express';
import { authenticateRequest, requireRole } from '../middleware/auth';
import prisma from '../prisma';

const router = Router();

router.use(authenticateRequest);
router.use(requireRole('teacher'));

// GET /api/analytics/overview — high-level stats
router.get('/overview', async (_req: Request, res: Response) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalSubmissions, totalReviews, totalStudents, avgScore, todaySubmissions, todayReviews] =
      await Promise.all([
        prisma.response.count(),
        prisma.review.count(),
        prisma.user.count({ where: { role: 'student' } }),
        prisma.review.aggregate({ _avg: { score: true } }),
        prisma.response.count({ where: { createdAt: { gte: today } } }),
        prisma.review.count({ where: { createdAt: { gte: today } } }),
      ]);

    res.json({
      totalSubmissions,
      totalReviews,
      totalStudents,
      avgScore: avgScore._avg.score,
      todaySubmissions,
      todayReviews,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/analytics/submissions — submissions per day
router.get('/submissions', async (req: Request, res: Response) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days as string) || 30));
    const since = new Date();
    since.setDate(since.getDate() - days);

    const data: any[] = await prisma.$queryRaw`
      SELECT DATE(created_at) as date, COUNT(*)::int as count
      FROM responses
      WHERE created_at >= ${since}
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `;

    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/analytics/scores — average review scores over time
router.get('/scores', async (req: Request, res: Response) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days as string) || 30));
    const since = new Date();
    since.setDate(since.getDate() - days);

    const data: any[] = await prisma.$queryRaw`
      SELECT DATE(rv.created_at) as date,
             AVG(rv.score)::float as avg_score,
             COUNT(rv.id)::int as review_count
      FROM reviews rv
      WHERE rv.created_at >= ${since}
      GROUP BY DATE(rv.created_at)
      ORDER BY date ASC
    `;

    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/analytics/teacher-activity — teacher review activity
router.get('/teacher-activity', async (req: Request, res: Response) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days as string) || 30));
    const since = new Date();
    since.setDate(since.getDate() - days);

    const data: any[] = await prisma.$queryRaw`
      SELECT u.id, u."fullName" as name, u."avatarUrl" as avatar_url,
             COUNT(rv.id)::int as reviews_given,
             AVG(rv.score)::float as avg_score_given
      FROM users u
      JOIN reviews rv ON rv.reviewer_id = u.id
      WHERE rv.created_at >= ${since}
      GROUP BY u.id, u."fullName", u."avatarUrl"
      ORDER BY reviews_given DESC
    `;

    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
