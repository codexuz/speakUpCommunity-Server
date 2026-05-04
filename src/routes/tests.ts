import { ExamType } from '@prisma/client';
import { Request, Response, Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest, authenticateRequest } from '../middleware/auth';
import prisma from '../prisma';
import { uploadFile } from '../services/minio';

const router = Router();

// GET /api/tests/export/cefr — download all CEFR tests with questions as JSON (Public)
router.get('/export/cefr', async (req: Request, res: Response) => {
  try {
    const { isPublished } = req.query;
    const where: any = { testType: 'cefr' };

    if (isPublished !== undefined) {
      where.isPublished = isPublished === 'true';
    }

    const tests = await prisma.test.findMany({
      where,
      orderBy: { id: 'asc' },
      include: {
        questions: {
          orderBy: { id: 'asc' },
          include: {
            sampleAnswers: {
              orderBy: [{ level: 'asc' }, { version: 'asc' }],
            },
          },
        },
      },
    });

    res.setHeader('Content-Disposition', 'attachment; filename=cefr_tests.json');
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(tests, null, 2));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.use(authenticateRequest);

const questionImageUpload = multer({
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

// ─── TESTS CRUD ─────────────────────────────────────────────

// GET /api/tests — list all tests with questions (paginated)
router.get('/', async (req: Request, res: Response) => {
  try {
    const { testType } = req.query;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 10));
    const skip = (page - 1) * limit;

    const auth = (req as AuthenticatedRequest).auth;
    const isAdminOrTeacher = auth?.role === 'admin' || auth?.role === 'teacher';

    const where: any = {};
    if (testType && Object.values(ExamType).includes(testType as ExamType)) {
      where.testType = testType as ExamType;
    }
    if (!isAdminOrTeacher) {
      where.isPublished = true;
    } else if (req.query.isPublished !== undefined) {
      where.isPublished = req.query.isPublished === 'true';
    }

    const [tests, total] = await Promise.all([
      prisma.test.findMany({
        where,
        orderBy: { id: 'asc' },
        skip,
        take: limit,
        include: {
          questions: {
            orderBy: { id: 'asc' },
          },
        },
      }),
      prisma.test.count({ where }),
    ]);

    res.json({
      data: tests,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


// GET /api/tests/:id — single test with questions
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const test = await prisma.test.findUnique({
      where: { id: parseInt(req.params.id as string) },
      include: { questions: { orderBy: { id: 'asc' } } },
    });
    if (!test) {
      res.status(404).json({ error: 'Test not found' });
      return;
    }
    res.json(test);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/tests — create a test
router.post('/', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can create tests' });
      return;
    }
    const { title, description, testType, isPublished } = req.body;
    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    const test = await prisma.test.create({
      data: {
        title,
        description,
        testType: testType === 'ielts' ? 'ielts' : 'cefr',
        ...(isPublished !== undefined && { isPublished: Boolean(isPublished) }),
      },
      include: { questions: true },
    });
    res.status(201).json(test);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/tests/:id — update a test
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can update tests' });
      return;
    }
    const id = parseInt(req.params.id as string);
    const { title, description, testType, isPublished } = req.body;
    const test = await prisma.test.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(testType !== undefined && { testType: testType === 'ielts' ? 'ielts' as const : 'cefr' as const }),
        ...(isPublished !== undefined && { isPublished: Boolean(isPublished) }),
      },
      include: { questions: { orderBy: { id: 'asc' } } },
    });
    res.json(test);
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Test not found' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/tests/:id — delete a test (cascades questions)
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can delete tests' });
      return;
    }
    const id = parseInt(req.params.id as string);
    await prisma.test.delete({ where: { id } });
    res.json({ message: 'Test deleted' });
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Test not found' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// ─── QUESTIONS CRUD ─────────────────────────────────────────

// GET /api/tests/:testId/questions — list questions for a test
router.get('/:testId/questions', async (req: Request, res: Response) => {
  try {
    const testId = parseInt(req.params.testId as string);
    const questions = await prisma.question.findMany({
      where: { testId },
      orderBy: { id: 'asc' },
    });
    res.json(questions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tests/questions/:id — single question
router.get('/questions/:id', async (req: Request, res: Response) => {
  try {
    const question = await prisma.question.findUnique({
      where: { id: parseInt(req.params.id as string) },
    });
    if (!question) {
      res.status(404).json({ error: 'Question not found' });
      return;
    }
    res.json(question);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/tests/:testId/questions — create a question
router.post('/:testId/questions', questionImageUpload.single('image'), async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can create questions' });
      return;
    }
    const testId = parseInt(req.params.testId as string);
    const body = req.body || {};
    const { qText, part, audioUrl, speakingTimer, prepTimer } = body;
    if (!qText || !part) {
      res.status(400).json({ error: 'qText and part are required' });
      return;
    }

    let imageUrl: string | undefined;
    if (req.file) {
      const ext = req.file.originalname.split('.').pop() || 'jpg';
      const fileName = `questions/images/${uuidv4()}.${ext}`;
      imageUrl = await uploadFile(fileName, req.file.buffer, req.file.mimetype);
    }

    const question = await prisma.question.create({
      data: {
        testId,
        qText,
        part,
        image: imageUrl,
        audioUrl: audioUrl || undefined,
        ...(speakingTimer !== undefined && { speakingTimer: parseInt(speakingTimer) }),
        ...(prepTimer !== undefined && { prepTimer: parseInt(prepTimer) }),
      },
    });
    res.status(201).json(question);
  } catch (error: any) {
    if (error.code === 'P2003') {
      res.status(404).json({ error: 'Test not found' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/tests/questions/:id — update a question
router.put('/questions/:id', questionImageUpload.single('image'), async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can update questions' });
      return;
    }
    const id = parseInt(req.params.id as string);
    const body = req.body || {};
    const { qText, part, audioUrl, speakingTimer, prepTimer } = body;

    let imageUrl: string | undefined;
    if (req.file) {
      const ext = req.file.originalname.split('.').pop() || 'jpg';
      const fileName = `questions/images/${uuidv4()}.${ext}`;
      imageUrl = await uploadFile(fileName, req.file.buffer, req.file.mimetype);
    }

    const question = await prisma.question.update({
      where: { id },
      data: {
        ...(qText !== undefined && { qText }),
        ...(part !== undefined && { part }),
        ...(imageUrl !== undefined && { image: imageUrl }),
        ...(audioUrl !== undefined && { audioUrl: audioUrl || null }),
        ...(speakingTimer !== undefined && { speakingTimer: parseInt(speakingTimer) }),
        ...(prepTimer !== undefined && { prepTimer: parseInt(prepTimer) }),
      },
    });
    res.json(question);
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Question not found' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/tests/questions/:id — delete a question
router.delete('/questions/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can delete questions' });
      return;
    }
    const id = parseInt(req.params.id as string);
    await prisma.question.delete({ where: { id } });
    res.json({ message: 'Question deleted' });
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Question not found' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// ─── SAMPLE ANSWERS CRUD ────────────────────────────────────

// GET /api/tests/questions/:questionId/sample-answers — list sample answers for a question
router.get('/questions/:questionId/sample-answers', async (req: Request, res: Response) => {
  try {
    const questionId = parseInt(req.params.questionId as string);
    const { level } = req.query;

    const where: any = { questionId };
    if (level) where.level = level as string;

    const sampleAnswers = await prisma.sampleAnswer.findMany({
      where,
      orderBy: [{ level: 'asc' }, { version: 'asc' }],
    });
    res.json(sampleAnswers);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tests/sample-answers/:id — single sample answer
router.get('/sample-answers/:id', async (req: Request, res: Response) => {
  try {
    const sampleAnswer = await prisma.sampleAnswer.findUnique({
      where: { id: parseInt(req.params.id as string) },
    });
    if (!sampleAnswer) {
      res.status(404).json({ error: 'Sample answer not found' });
      return;
    }
    res.json(sampleAnswer);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/tests/questions/:questionId/sample-answers — create a sample answer
router.post('/questions/:questionId/sample-answers', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can create sample answers' });
      return;
    }
    const questionId = parseInt(req.params.questionId as string);
    const { level, version, answerText, audioUrl } = req.body;
    if (!level || !answerText) {
      res.status(400).json({ error: 'level and answerText are required' });
      return;
    }

    const sampleAnswer = await prisma.sampleAnswer.create({
      data: {
        questionId,
        level,
        answerText,
        ...(version !== undefined && { version: parseInt(version) }),
        ...(audioUrl !== undefined && { audioUrl }),
      },
    });
    res.status(201).json(sampleAnswer);
  } catch (error: any) {
    if (error.code === 'P2003') {
      res.status(404).json({ error: 'Question not found' });
      return;
    }
    if (error.code === 'P2002') {
      res.status(409).json({ error: 'Sample answer for this question/level/version already exists' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/tests/sample-answers/:id — update a sample answer
router.put('/sample-answers/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can update sample answers' });
      return;
    }
    const id = parseInt(req.params.id as string);
    const { level, version, answerText, audioUrl } = req.body;

    const sampleAnswer = await prisma.sampleAnswer.update({
      where: { id },
      data: {
        ...(level !== undefined && { level }),
        ...(version !== undefined && { version: parseInt(version) }),
        ...(answerText !== undefined && { answerText }),
        ...(audioUrl !== undefined && { audioUrl: audioUrl || null }),
      },
    });
    res.json(sampleAnswer);
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Sample answer not found' });
      return;
    }
    if (error.code === 'P2002') {
      res.status(409).json({ error: 'Sample answer for this question/level/version already exists' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/tests/sample-answers/:id — delete a sample answer
router.delete('/sample-answers/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can delete sample answers' });
      return;
    }
    const id = parseInt(req.params.id as string);
    await prisma.sampleAnswer.delete({ where: { id } });
    res.json({ message: 'Sample answer deleted' });
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Sample answer not found' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

export default router;
