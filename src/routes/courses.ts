import { Request, Response, Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import {
  AuthenticatedRequest,
  authenticateRequest,
  requireRole,
} from '../middleware/auth';
import prisma from '../prisma';
import { awardXP } from '../services/gamification';
import { uploadFile } from '../services/minio';

const router = Router();

const courseImageUpload = multer({
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

router.use(authenticateRequest);

// ─── Public: Browse courses ─────────────────────────────────────

// GET /api/courses — list published courses
router.get('/', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const level = req.query.level as string;

    const where: any = { isPublished: true };
    if (level) where.level = level;

    const courses = await prisma.course.findMany({
      where,
      orderBy: { order: 'asc' },
      include: {
        units: {
          orderBy: { order: 'asc' },
          include: {
            _count: { select: { lessons: true } },
          },
        },
      },
    });

    // Get user's progress per course
    const lessonIds = courses.flatMap((c) =>
      c.units.flatMap((u) => [] as string[]), // we need lesson IDs
    );

    // Get all lesson IDs for these courses
    const allLessons = await prisma.lesson.findMany({
      where: { unit: { course: { isPublished: true, ...(level ? { level } : {}) } } },
      select: { id: true, unitId: true },
    });

    const userProgress = await prisma.userLessonProgress.findMany({
      where: { userId: auth.userId, lessonId: { in: allLessons.map((l) => l.id) } },
      select: { lessonId: true, completed: true },
    });
    const completedSet = new Set(userProgress.filter((p) => p.completed).map((p) => p.lessonId));

    // Build lesson count per unit
    const lessonsPerUnit = new Map<string, string[]>();
    for (const lesson of allLessons) {
      const arr = lessonsPerUnit.get(lesson.unitId) || [];
      arr.push(lesson.id);
      lessonsPerUnit.set(lesson.unitId, arr);
    }

    const data = courses.map((course) => {
      let totalLessons = 0;
      let completedLessons = 0;

      for (const unit of course.units) {
        const unitLessons = lessonsPerUnit.get(unit.id) || [];
        totalLessons += unitLessons.length;
        completedLessons += unitLessons.filter((id) => completedSet.has(id)).length;
      }

      return {
        ...course,
        totalLessons,
        completedLessons,
        progressPercent: totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0,
      };
    });

    res.json({ data });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/courses/:id — course detail with units and lessons
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;

    const course = await prisma.course.findUnique({
      where: { id: req.params.id as string },
      include: {
        units: {
          orderBy: { order: 'asc' },
          include: {
            lessons: {
              orderBy: { order: 'asc' },
              select: { id: true, title: true, order: true, xpReward: true },
            },
          },
        },
      },
    });

    if (!course) {
      res.status(404).json({ error: 'Course not found' });
      return;
    }

    // Get user's lesson progress
    const lessonIds = course.units.flatMap((u) => u.lessons.map((l) => l.id));
    const userProgress = await prisma.userLessonProgress.findMany({
      where: { userId: auth.userId, lessonId: { in: lessonIds } },
    });
    const progressMap = new Map(userProgress.map((p) => [p.lessonId, p]));

    const units = course.units.map((unit) => ({
      ...unit,
      lessons: unit.lessons.map((lesson) => {
        const progress = progressMap.get(lesson.id);
        return {
          ...lesson,
          completed: progress?.completed || false,
          score: progress?.score || null,
          xpEarned: progress?.xpEarned || 0,
        };
      }),
    }));

    res.json({ ...course, units });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/courses/lessons/:lessonId — lesson with exercises
router.get('/lessons/:lessonId', async (req: Request, res: Response) => {
  try {
    const lesson = await prisma.lesson.findUnique({
      where: { id: req.params.lessonId as string },
      include: {
        exercises: { orderBy: { order: 'asc' } },
        unit: {
          include: { course: { select: { id: true, title: true, level: true } } },
        },
      },
    });

    if (!lesson) {
      res.status(404).json({ error: 'Lesson not found' });
      return;
    }

    res.json(lesson);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/courses/lessons/:lessonId/complete — mark lesson as completed
router.post('/lessons/:lessonId/complete', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const { score } = req.body; // 0-100 optional score from exercise results

    const lesson = await prisma.lesson.findUnique({
      where: { id: req.params.lessonId as string },
      select: { id: true, xpReward: true },
    });
    if (!lesson) {
      res.status(404).json({ error: 'Lesson not found' });
      return;
    }

    // Check if already completed
    const existing = await prisma.userLessonProgress.findUnique({
      where: { userId_lessonId: { userId: auth.userId, lessonId: lesson.id } },
    });

    if (existing?.completed) {
      res.json({ message: 'Already completed', xpEarned: 0 });
      return;
    }

    const progress = await prisma.userLessonProgress.upsert({
      where: { userId_lessonId: { userId: auth.userId, lessonId: lesson.id } },
      create: {
        userId: auth.userId,
        lessonId: lesson.id,
        completed: true,
        score: score ?? null,
        xpEarned: lesson.xpReward,
        completedAt: new Date(),
      },
      update: {
        completed: true,
        score: score ?? undefined,
        xpEarned: lesson.xpReward,
        completedAt: new Date(),
      },
    });

    // Award XP
    await awardXP(auth.userId, lesson.xpReward, 0);

    res.json({
      progress,
      xpEarned: lesson.xpReward,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Admin: manage courses ──────────────────────────────────────

// POST /api/courses/admin/create — create course
router.post('/admin/create', requireRole('admin'), courseImageUpload.single('image'), async (req: Request, res: Response) => {
  try {
    const { title, description, level, imageUrl, order, isPublished } = req.body;
    if (!title || !description || !level) {
      res.status(400).json({ error: 'title, description, level are required' });
      return;
    }

    let resolvedImageUrl = imageUrl || null;
    if (req.file) {
      const ext = req.file.originalname.split('.').pop() || 'jpg';
      const fileName = `courses/images/${uuidv4()}.${ext}`;
      resolvedImageUrl = await uploadFile(fileName, req.file.buffer, req.file.mimetype);
    }

    const course = await prisma.course.create({
      data: {
        title,
        description,
        level,
        imageUrl: resolvedImageUrl,
        order: order ? parseInt(order) : 0,
        ...(isPublished !== undefined && { isPublished: isPublished === true || isPublished === 'true' }),
      },
    });
    res.status(201).json(course);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/courses/admin/:id — update course
router.put('/admin/:id', requireRole('admin'), courseImageUpload.single('image'), async (req: Request, res: Response) => {
  try {
    const { title, description, level, imageUrl, isPublished, order } = req.body;

    let resolvedImageUrl: string | undefined;
    if (req.file) {
      const ext = req.file.originalname.split('.').pop() || 'jpg';
      const fileName = `courses/images/${uuidv4()}.${ext}`;
      resolvedImageUrl = await uploadFile(fileName, req.file.buffer, req.file.mimetype);
    } else if (imageUrl !== undefined) {
      resolvedImageUrl = imageUrl;
    }

    const course = await prisma.course.update({
      where: { id: req.params.id as string },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(level !== undefined && { level }),
        ...(resolvedImageUrl !== undefined && { imageUrl: resolvedImageUrl }),
        ...(isPublished !== undefined && { isPublished: isPublished === true || isPublished === 'true' }),
        ...(order !== undefined && { order: typeof order === 'string' ? parseInt(order) : order }),
      },
    });
    res.json(course);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/courses/admin/:id — delete course
router.delete('/admin/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    await prisma.course.delete({ where: { id: req.params.id as string } });
    res.json({ message: 'Course deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/courses/admin/units — create unit
router.post('/admin/units', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { courseId, title, order } = req.body;
    if (!courseId || !title) {
      res.status(400).json({ error: 'courseId and title are required' });
      return;
    }
    const unit = await prisma.courseUnit.create({
      data: { courseId, title, order: order ?? 0 },
    });
    res.status(201).json(unit);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/courses/admin/units/:id — update unit
router.put('/admin/units/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { title, order } = req.body;
    const unit = await prisma.courseUnit.update({
      where: { id: req.params.id as string },
      data: { ...(title !== undefined && { title }), ...(order !== undefined && { order }) },
    });
    res.json(unit);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/courses/admin/units/:id — delete unit
router.delete('/admin/units/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    await prisma.courseUnit.delete({ where: { id: req.params.id as string } });
    res.json({ message: 'Unit deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/courses/admin/lessons — create lesson
router.post('/admin/lessons', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { unitId, title, order, xpReward } = req.body;
    if (!unitId || !title) {
      res.status(400).json({ error: 'unitId and title are required' });
      return;
    }
    const lesson = await prisma.lesson.create({
      data: { unitId, title, order: order ?? 0, xpReward: xpReward ?? 10 },
    });
    res.status(201).json(lesson);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/courses/admin/lessons/:id — update lesson
router.put('/admin/lessons/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { title, order, xpReward } = req.body;
    const lesson = await prisma.lesson.update({
      where: { id: req.params.id as string },
      data: {
        ...(title !== undefined && { title }),
        ...(order !== undefined && { order }),
        ...(xpReward !== undefined && { xpReward }),
      },
    });
    res.json(lesson);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/courses/admin/lessons/:id — delete lesson
router.delete('/admin/lessons/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    await prisma.lesson.delete({ where: { id: req.params.id as string } });
    res.json({ message: 'Lesson deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/courses/admin/exercises — create exercise
router.post('/admin/exercises', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { lessonId, type, order, prompt, correctAnswer, options, audioUrl, imageUrl, hints } = req.body;
    if (!lessonId || !type || !prompt) {
      res.status(400).json({ error: 'lessonId, type, prompt are required' });
      return;
    }
    const exercise = await prisma.exercise.create({
      data: {
        lessonId,
        type,
        order: order ?? 0,
        prompt,
        correctAnswer: correctAnswer || null,
        options: options || null,
        audioUrl: audioUrl || null,
        imageUrl: imageUrl || null,
        hints: hints || null,
      },
    });
    res.status(201).json(exercise);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/courses/admin/exercises/:id — update exercise
router.put('/admin/exercises/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { type, order, prompt, correctAnswer, options, audioUrl, imageUrl, hints } = req.body;
    const exercise = await prisma.exercise.update({
      where: { id: req.params.id as string },
      data: {
        ...(type !== undefined && { type }),
        ...(order !== undefined && { order }),
        ...(prompt !== undefined && { prompt }),
        ...(correctAnswer !== undefined && { correctAnswer }),
        ...(options !== undefined && { options }),
        ...(audioUrl !== undefined && { audioUrl }),
        ...(imageUrl !== undefined && { imageUrl }),
        ...(hints !== undefined && { hints }),
      },
    });
    res.json(exercise);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/courses/admin/exercises/:id — delete exercise
router.delete('/admin/exercises/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    await prisma.exercise.delete({ where: { id: req.params.id as string } });
    res.json({ message: 'Exercise deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
