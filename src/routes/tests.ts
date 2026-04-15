import { Request, Response, Router } from 'express';
import { AuthenticatedRequest, authenticateRequest } from '../middleware/auth';
import prisma from '../prisma';

const router = Router();

router.use(authenticateRequest);

// ─── TESTS CRUD ─────────────────────────────────────────────

// GET /api/tests — list all tests with questions
router.get('/', async (_req: Request, res: Response) => {
  try {
    const tests = await prisma.test.findMany({
      orderBy: { id: 'asc' },
      include: {
        questions: {
          orderBy: { id: 'asc' },
        },
      },
    });
    res.json(tests);
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
    const { title, description } = req.body;
    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    const test = await prisma.test.create({
      data: { title, description },
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
    const { title, description } = req.body;
    const test = await prisma.test.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
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
router.post('/:testId/questions', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can create questions' });
      return;
    }
    const testId = parseInt(req.params.testId as string);
    const { qText, part, image, audioUrl, speakingTimer, prepTimer } = req.body;
    if (!qText || !part) {
      res.status(400).json({ error: 'qText and part are required' });
      return;
    }
    const question = await prisma.question.create({
      data: {
        testId,
        qText,
        part,
        image,
        audioUrl,
        ...(speakingTimer !== undefined && { speakingTimer }),
        ...(prepTimer !== undefined && { prepTimer }),
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
router.put('/questions/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.role !== 'teacher' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only teachers/admins can update questions' });
      return;
    }
    const id = parseInt(req.params.id as string);
    const { qText, part, image, audioUrl, speakingTimer, prepTimer } = req.body;
    const question = await prisma.question.update({
      where: { id },
      data: {
        ...(qText !== undefined && { qText }),
        ...(part !== undefined && { part }),
        ...(image !== undefined && { image }),
        ...(audioUrl !== undefined && { audioUrl }),
        ...(speakingTimer !== undefined && { speakingTimer }),
        ...(prepTimer !== undefined && { prepTimer }),
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

export default router;
