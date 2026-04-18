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

const lectureMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB for video/audio
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
              select: { id: true, title: true, type: true, order: true, xpReward: true },
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
        lectures: {
          orderBy: { order: 'asc' },
          include: { attachments: { orderBy: { order: 'asc' } } },
        },
        exercises: {
          orderBy: { order: 'asc' },
          include: {
            options: { orderBy: { order: 'asc' } },
            matchPairs: { orderBy: { order: 'asc' } },
            wordBankItems: { orderBy: { correctPosition: 'asc' } },
            conversationLines: { orderBy: { order: 'asc' } },
          },
        },
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

// GET /api/courses/admin/all — list all courses (published & unpublished)
router.get('/admin/all', requireRole('admin'), async (_req: Request, res: Response) => {
  try {
    const courses = await prisma.course.findMany({
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

    res.json({ data: courses });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

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
    const { unitId, title, type, order, xpReward } = req.body;
    if (!unitId || !title) {
      res.status(400).json({ error: 'unitId and title are required' });
      return;
    }
    const lesson = await prisma.lesson.create({
      data: { unitId, title, type: type ?? 'practice', order: order ?? 0, xpReward: xpReward ?? 10 },
    });
    res.status(201).json(lesson);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/courses/admin/lessons/:id — update lesson
router.put('/admin/lessons/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { title, type, order, xpReward } = req.body;
    const lesson = await prisma.lesson.update({
      where: { id: req.params.id as string },
      data: {
        ...(title !== undefined && { title }),
        ...(type !== undefined && { type }),
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

// ─── Admin: manage lectures ─────────────────────────────────────

// POST /api/courses/admin/lectures — create lecture (with optional media upload)
router.post(
  '/admin/lectures',
  requireRole('admin'),
  lectureMediaUpload.fields([
    { name: 'media', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
    { name: 'attachments', maxCount: 10 },
  ]),
  async (req: Request, res: Response) => {
    try {
      const { lessonId, contentType, title, order, textBody, mediaUrl, thumbnailUrl, durationSec } = req.body;
      if (!lessonId || !contentType || !title) {
        res.status(400).json({ error: 'lessonId, contentType, title are required' });
        return;
      }

      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

      // Upload media file if provided
      let resolvedMediaUrl = mediaUrl || null;
      if (files?.media?.[0]) {
        const f = files.media[0];
        const ext = f.originalname.split('.').pop() || 'bin';
        const fileName = `courses/lectures/${uuidv4()}.${ext}`;
        resolvedMediaUrl = await uploadFile(fileName, f.buffer, f.mimetype);
      }

      // Upload thumbnail if provided
      let resolvedThumbnailUrl = thumbnailUrl || null;
      if (files?.thumbnail?.[0]) {
        const f = files.thumbnail[0];
        const ext = f.originalname.split('.').pop() || 'jpg';
        const fileName = `courses/lectures/thumbs/${uuidv4()}.${ext}`;
        resolvedThumbnailUrl = await uploadFile(fileName, f.buffer, f.mimetype);
      }

      // Upload attachment files
      const attachmentData: { url: string; fileName: string; fileSize: number; mimeType: string; order: number }[] = [];
      if (files?.attachments) {
        for (let i = 0; i < files.attachments.length; i++) {
          const f = files.attachments[i];
          const ext = f.originalname.split('.').pop() || 'bin';
          const storageName = `courses/lectures/files/${uuidv4()}.${ext}`;
          const url = await uploadFile(storageName, f.buffer, f.mimetype);
          attachmentData.push({
            url,
            fileName: f.originalname,
            fileSize: f.size,
            mimeType: f.mimetype,
            order: i,
          });
        }
      }

      const lecture = await prisma.lecture.create({
        data: {
          lessonId,
          contentType,
          title,
          order: order ? parseInt(order) : 0,
          textBody: textBody || null,
          mediaUrl: resolvedMediaUrl,
          thumbnailUrl: resolvedThumbnailUrl,
          durationSec: durationSec ? parseInt(durationSec) : null,
          ...(attachmentData.length && {
            attachments: { createMany: { data: attachmentData } },
          }),
        },
        include: { attachments: { orderBy: { order: 'asc' } } },
      });

      res.status(201).json(lecture);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },
);

// PUT /api/courses/admin/lectures/:id — update lecture
router.put(
  '/admin/lectures/:id',
  requireRole('admin'),
  lectureMediaUpload.fields([
    { name: 'media', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
    { name: 'attachments', maxCount: 10 },
  ]),
  async (req: Request, res: Response) => {
    try {
      const { contentType, title, order, textBody, mediaUrl, thumbnailUrl, durationSec } = req.body;
      const lectureId = req.params.id as string;
      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

      let resolvedMediaUrl: string | undefined;
      if (files?.media?.[0]) {
        const f = files.media[0];
        const ext = f.originalname.split('.').pop() || 'bin';
        const fileName = `courses/lectures/${uuidv4()}.${ext}`;
        resolvedMediaUrl = await uploadFile(fileName, f.buffer, f.mimetype);
      } else if (mediaUrl !== undefined) {
        resolvedMediaUrl = mediaUrl;
      }

      let resolvedThumbnailUrl: string | undefined;
      if (files?.thumbnail?.[0]) {
        const f = files.thumbnail[0];
        const ext = f.originalname.split('.').pop() || 'jpg';
        const fileName = `courses/lectures/thumbs/${uuidv4()}.${ext}`;
        resolvedThumbnailUrl = await uploadFile(fileName, f.buffer, f.mimetype);
      } else if (thumbnailUrl !== undefined) {
        resolvedThumbnailUrl = thumbnailUrl;
      }

      // Replace attachments if new ones uploaded
      if (files?.attachments?.length) {
        await prisma.lectureAttachment.deleteMany({ where: { lectureId } });
        const attachmentData = [];
        for (let i = 0; i < files.attachments.length; i++) {
          const f = files.attachments[i];
          const ext = f.originalname.split('.').pop() || 'bin';
          const storageName = `courses/lectures/files/${uuidv4()}.${ext}`;
          const url = await uploadFile(storageName, f.buffer, f.mimetype);
          attachmentData.push({
            lectureId,
            url,
            fileName: f.originalname,
            fileSize: f.size,
            mimeType: f.mimetype,
            order: i,
          });
        }
        await prisma.lectureAttachment.createMany({ data: attachmentData });
      }

      const lecture = await prisma.lecture.update({
        where: { id: lectureId },
        data: {
          ...(contentType !== undefined && { contentType }),
          ...(title !== undefined && { title }),
          ...(order !== undefined && { order: typeof order === 'string' ? parseInt(order) : order }),
          ...(textBody !== undefined && { textBody }),
          ...(resolvedMediaUrl !== undefined && { mediaUrl: resolvedMediaUrl }),
          ...(resolvedThumbnailUrl !== undefined && { thumbnailUrl: resolvedThumbnailUrl }),
          ...(durationSec !== undefined && { durationSec: durationSec ? parseInt(durationSec) : null }),
        },
        include: { attachments: { orderBy: { order: 'asc' } } },
      });

      res.json(lecture);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },
);

// DELETE /api/courses/admin/lectures/:id — delete lecture
router.delete('/admin/lectures/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    await prisma.lecture.delete({ where: { id: req.params.id as string } });
    res.json({ message: 'Lecture deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/courses/admin/lectures/:id/attachments — add attachments to existing lecture
router.post(
  '/admin/lectures/:id/attachments',
  requireRole('admin'),
  lectureMediaUpload.array('files', 10),
  async (req: Request, res: Response) => {
    try {
      const lectureId = req.params.id as string;
      const files = req.files as Express.Multer.File[];
      if (!files?.length) {
        res.status(400).json({ error: 'No files provided' });
        return;
      }

      const existing = await prisma.lectureAttachment.count({ where: { lectureId } });

      const attachmentData = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const ext = f.originalname.split('.').pop() || 'bin';
        const storageName = `courses/lectures/files/${uuidv4()}.${ext}`;
        const url = await uploadFile(storageName, f.buffer, f.mimetype);
        attachmentData.push({
          lectureId,
          url,
          fileName: f.originalname,
          fileSize: f.size,
          mimeType: f.mimetype,
          order: existing + i,
        });
      }

      await prisma.lectureAttachment.createMany({ data: attachmentData });

      const attachments = await prisma.lectureAttachment.findMany({
        where: { lectureId },
        orderBy: { order: 'asc' },
      });

      res.status(201).json(attachments);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },
);

// DELETE /api/courses/admin/lecture-attachments/:id — delete single attachment
router.delete('/admin/lecture-attachments/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    await prisma.lectureAttachment.delete({ where: { id: req.params.id as string } });
    res.json({ message: 'Attachment deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Student: lecture progress ──────────────────────────────────

// POST /api/courses/lectures/:lectureId/progress — update lecture progress
router.post('/lectures/:lectureId/progress', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const lectureId = req.params.lectureId as string;
    const { progressPct } = req.body; // 0-100

    const lecture = await prisma.lecture.findUnique({ where: { id: lectureId } });
    if (!lecture) {
      res.status(404).json({ error: 'Lecture not found' });
      return;
    }

    const pct = Math.min(100, Math.max(0, parseInt(progressPct) || 0));
    const completed = pct >= 100;

    const progress = await prisma.userLectureProgress.upsert({
      where: { userId_lectureId: { userId: auth.userId, lectureId } },
      create: {
        userId: auth.userId,
        lectureId,
        progressPct: pct,
        completed,
        completedAt: completed ? new Date() : null,
      },
      update: {
        progressPct: pct,
        completed,
        completedAt: completed ? new Date() : undefined,
      },
    });

    res.json(progress);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/courses/lectures/:lectureId — get single lecture with attachments
router.get('/lectures/:lectureId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;

    const lecture = await prisma.lecture.findUnique({
      where: { id: req.params.lectureId as string },
      include: {
        attachments: { orderBy: { order: 'asc' } },
        lesson: {
          select: { id: true, title: true, unit: { select: { course: { select: { id: true, title: true } } } } },
        },
      },
    });

    if (!lecture) {
      res.status(404).json({ error: 'Lecture not found' });
      return;
    }

    // Attach user progress
    const progress = await prisma.userLectureProgress.findUnique({
      where: { userId_lectureId: { userId: auth.userId, lectureId: lecture.id } },
    });

    res.json({ ...lecture, userProgress: progress || null });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/courses/admin/exercises — create exercise
router.post('/admin/exercises', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const {
      lessonId, type, order, prompt, promptAudio, correctAnswer,
      sentenceTemplate, targetText, audioUrl, imageUrl, hints,
      explanation, difficulty, xpReward,
      options, matchPairs, wordBankItems, conversationLines,
    } = req.body;
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
        promptAudio: promptAudio || null,
        correctAnswer: correctAnswer || null,
        sentenceTemplate: sentenceTemplate || null,
        targetText: targetText || null,
        audioUrl: audioUrl || null,
        imageUrl: imageUrl || null,
        hints: hints || null,
        explanation: explanation || null,
        difficulty: difficulty ?? 1,
        xpReward: xpReward ?? 10,
        ...(options?.length && {
          options: { createMany: { data: options } },
        }),
        ...(matchPairs?.length && {
          matchPairs: { createMany: { data: matchPairs } },
        }),
        ...(wordBankItems?.length && {
          wordBankItems: { createMany: { data: wordBankItems } },
        }),
        ...(conversationLines?.length && {
          conversationLines: { createMany: { data: conversationLines } },
        }),
      },
      include: {
        options: { orderBy: { order: 'asc' } },
        matchPairs: { orderBy: { order: 'asc' } },
        wordBankItems: { orderBy: { correctPosition: 'asc' } },
        conversationLines: { orderBy: { order: 'asc' } },
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
    const {
      type, order, prompt, promptAudio, correctAnswer,
      sentenceTemplate, targetText, audioUrl, imageUrl, hints,
      explanation, difficulty, xpReward,
      options, matchPairs, wordBankItems, conversationLines,
    } = req.body;

    // Replace child records if provided
    const exerciseId = req.params.id as string;
    await prisma.$transaction(async (tx) => {
      if (options !== undefined) {
        await tx.exerciseOption.deleteMany({ where: { exerciseId } });
        if (options?.length) {
          await tx.exerciseOption.createMany({
            data: options.map((o: any) => ({ ...o, exerciseId })),
          });
        }
      }
      if (matchPairs !== undefined) {
        await tx.exerciseMatchPair.deleteMany({ where: { exerciseId } });
        if (matchPairs?.length) {
          await tx.exerciseMatchPair.createMany({
            data: matchPairs.map((p: any) => ({ ...p, exerciseId })),
          });
        }
      }
      if (wordBankItems !== undefined) {
        await tx.exerciseWordBankItem.deleteMany({ where: { exerciseId } });
        if (wordBankItems?.length) {
          await tx.exerciseWordBankItem.createMany({
            data: wordBankItems.map((w: any) => ({ ...w, exerciseId })),
          });
        }
      }
      if (conversationLines !== undefined) {
        await tx.exerciseConversationLine.deleteMany({ where: { exerciseId } });
        if (conversationLines?.length) {
          await tx.exerciseConversationLine.createMany({
            data: conversationLines.map((c: any) => ({ ...c, exerciseId })),
          });
        }
      }
    });

    const exercise = await prisma.exercise.update({
      where: { id: exerciseId },
      data: {
        ...(type !== undefined && { type }),
        ...(order !== undefined && { order }),
        ...(prompt !== undefined && { prompt }),
        ...(promptAudio !== undefined && { promptAudio }),
        ...(correctAnswer !== undefined && { correctAnswer }),
        ...(sentenceTemplate !== undefined && { sentenceTemplate }),
        ...(targetText !== undefined && { targetText }),
        ...(audioUrl !== undefined && { audioUrl }),
        ...(imageUrl !== undefined && { imageUrl }),
        ...(hints !== undefined && { hints }),
        ...(explanation !== undefined && { explanation }),
        ...(difficulty !== undefined && { difficulty }),
        ...(xpReward !== undefined && { xpReward }),
      },
      include: {
        options: { orderBy: { order: 'asc' } },
        matchPairs: { orderBy: { order: 'asc' } },
        wordBankItems: { orderBy: { correctPosition: 'asc' } },
        conversationLines: { orderBy: { order: 'asc' } },
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

// ─── Exercise Player ────────────────────────────────────────────

// POST /api/courses/lessons/:lessonId/start — start exercise session
router.post('/lessons/:lessonId/start', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const lessonId = req.params.lessonId as string;

    const lesson = await prisma.lesson.findUnique({ where: { id: lessonId } });
    if (!lesson) {
      res.status(404).json({ error: 'Lesson not found' });
      return;
    }

    const session = await prisma.exerciseSession.create({
      data: { userId: auth.userId, lessonId },
    });

    const exercises = await prisma.exercise.findMany({
      where: { lessonId },
      orderBy: { order: 'asc' },
      include: {
        options: { orderBy: { order: 'asc' } },
        matchPairs: { orderBy: { order: 'asc' } },
        wordBankItems: { orderBy: { correctPosition: 'asc' } },
        conversationLines: { orderBy: { order: 'asc' } },
      },
    });

    res.status(201).json({ session, exercises });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/courses/sessions/:sessionId/attempt — submit an exercise attempt
router.post('/sessions/:sessionId/attempt', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const { exerciseId, userAnswer, isCorrect, timeTakenMs } = req.body;

    if (!exerciseId || userAnswer === undefined || isCorrect === undefined) {
      res.status(400).json({ error: 'exerciseId, userAnswer, isCorrect are required' });
      return;
    }

    const session = await prisma.exerciseSession.findUnique({
      where: { id: req.params.sessionId as string },
    });
    if (!session || session.userId !== auth.userId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.completed) {
      res.status(400).json({ error: 'Session already completed' });
      return;
    }

    const exercise = await prisma.exercise.findUnique({ where: { id: exerciseId } });
    if (!exercise) {
      res.status(404).json({ error: 'Exercise not found' });
      return;
    }

    const xpEarned = isCorrect ? exercise.xpReward : 0;
    const newCombo = isCorrect ? session.combo + 1 : 0;
    const newHearts = isCorrect ? session.hearts : Math.max(0, session.hearts - 1);

    const [attempt] = await prisma.$transaction([
      prisma.exerciseAttempt.create({
        data: {
          sessionId: session.id,
          exerciseId,
          userAnswer,
          isCorrect,
          xpEarned,
          timeTakenMs: timeTakenMs || null,
        },
      }),
      prisma.exerciseSession.update({
        where: { id: session.id },
        data: {
          combo: newCombo,
          maxCombo: Math.max(session.maxCombo, newCombo),
          totalXp: session.totalXp + xpEarned,
          correctCount: session.correctCount + (isCorrect ? 1 : 0),
          wrongCount: session.wrongCount + (isCorrect ? 0 : 1),
          hearts: newHearts,
        },
      }),
    ]);

    res.status(201).json({
      attempt,
      session: {
        hearts: newHearts,
        combo: newCombo,
        maxCombo: Math.max(session.maxCombo, newCombo),
        totalXp: session.totalXp + xpEarned,
        correctCount: session.correctCount + (isCorrect ? 1 : 0),
        wrongCount: session.wrongCount + (isCorrect ? 0 : 1),
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/courses/sessions/:sessionId/complete — complete exercise session
router.post('/sessions/:sessionId/complete', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;

    const session = await prisma.exerciseSession.findUnique({
      where: { id: req.params.sessionId as string },
    });
    if (!session || session.userId !== auth.userId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const updated = await prisma.exerciseSession.update({
      where: { id: session.id },
      data: { completed: true, completedAt: new Date() },
      include: { attempts: true },
    });

    // Award XP to user progress
    if (updated.totalXp > 0) {
      await awardXP(auth.userId, updated.totalXp);
    }

    // Mark lesson progress
    await prisma.userLessonProgress.upsert({
      where: { userId_lessonId: { userId: auth.userId, lessonId: session.lessonId } },
      create: {
        userId: auth.userId,
        lessonId: session.lessonId,
        completed: true,
        score: updated.correctCount / Math.max(1, updated.correctCount + updated.wrongCount),
        xpEarned: updated.totalXp,
        completedAt: new Date(),
      },
      update: {
        completed: true,
        score: updated.correctCount / Math.max(1, updated.correctCount + updated.wrongCount),
        xpEarned: updated.totalXp,
        completedAt: new Date(),
      },
    });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/courses/sessions/:sessionId — get session with attempts
router.get('/sessions/:sessionId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;

    const session = await prisma.exerciseSession.findUnique({
      where: { id: req.params.sessionId as string },
      include: { attempts: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session || session.userId !== auth.userId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.json(session);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
