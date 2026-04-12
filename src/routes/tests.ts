import { Request, Response, Router } from 'express';
import { authenticateRequest } from '../middleware/auth';
import prisma from '../prisma';

const router = Router();

router.use(authenticateRequest);

// GET /api/tests — list tests with question count
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

export default router;
