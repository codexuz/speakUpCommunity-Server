import { Request, Response, Router } from 'express';
import {
  AuthenticatedRequest,
  authenticateRequest,
  requireRole,
} from '../middleware/auth';
import prisma from '../prisma';

const router = Router();

router.use(authenticateRequest);

// ─── Public Endpoints ───────────────────────────────────────────

/**
 * GET /api/speaking-library
 * List all parts with their topics
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const parts = await prisma.speakingPart.findMany({
      orderBy: { part: 'asc' },
      include: {
        topics: {
          orderBy: { createdAt: 'desc' },
          include: {
            _count: { select: { questions: true } }
          }
        }
      }
    });
    res.json(parts);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/speaking-library/parts/:id
 * Get a specific part with topics
 */
router.get('/parts/:id', async (req: Request, res: Response) => {
  try {
    const part = await prisma.speakingPart.findUnique({
      where: { id: parseInt(req.params.id as string) },
      include: {
        topics: {
          orderBy: { createdAt: 'desc' },
          include: {
            _count: { select: { questions: true } }
          }
        }
      }
    });
    if (!part) return res.status(404).json({ error: 'Part not found' });
    res.json(part);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/speaking-library/topics/:id
 * Get a specific topic with its questions
 */
router.get('/topics/:id', async (req: Request, res: Response) => {
  try {
    const topic = await prisma.speakingTopic.findUnique({
      where: { id: parseInt(req.params.id as string) },
      include: {
        questions: {
          orderBy: { createdAt: 'asc' },
          include: {
            _count: {
              select: {
                vocabulary: true,
                ideas: true,
                sampleAnswers: true
              }
            }
          }
        }
      }
    });
    if (!topic) return res.status(404).json({ error: 'Topic not found' });
    res.json(topic);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/speaking-library/questions/:id
 * Get a specific question with all related content (vocab, ideas, answers)
 */
router.get('/questions/:id', async (req: Request, res: Response) => {
  try {
    const question = await prisma.speakingQuestion.findUnique({
      where: { id: parseInt(req.params.id as string) },
      include: {
        vocabulary: true,
        ideas: true,
        sampleAnswers: true,
        topic: {
          select: {
            id: true,
            title: true,
            part: {
              select: { id: true, part: true }
            }
          }
        }
      }
    });
    if (!question) return res.status(404).json({ error: 'Question not found' });
    res.json(question);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Admin Endpoints (Management) ───────────────────────────────

// --- Parts ---
router.post('/admin/parts', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { part, title } = req.body;
    const newPart = await prisma.speakingPart.create({
      data: { part: parseInt(part), title }
    });
    res.status(201).json(newPart);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/admin/parts/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { part, title } = req.body;
    const updated = await prisma.speakingPart.update({
      where: { id: parseInt(req.params.id as string) },
      data: {
        ...(part !== undefined && { part: parseInt(part) }),
        ...(title !== undefined && { title })
      }
    });
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/admin/parts/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    await prisma.speakingPart.delete({ where: { id: parseInt(req.params.id as string) } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Topics ---
router.post('/admin/topics', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { partId, title, imageUrl } = req.body;
    const topic = await prisma.speakingTopic.create({
      data: { partId: parseInt(partId), title, imageUrl }
    });
    res.status(201).json(topic);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/admin/topics/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { partId, title, imageUrl } = req.body;
    const updated = await prisma.speakingTopic.update({
      where: { id: parseInt(req.params.id as string) },
      data: {
        ...(partId !== undefined && { partId: parseInt(partId) }),
        ...(title !== undefined && { title }),
        ...(imageUrl !== undefined && { imageUrl })
      }
    });
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/admin/topics/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    await prisma.speakingTopic.delete({ where: { id: parseInt(req.params.id as string) } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Questions ---
router.post('/admin/questions', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { topicId, text, audioUrl } = req.body;
    const question = await prisma.speakingQuestion.create({
      data: { topicId: parseInt(topicId), text, audioUrl }
    });
    res.status(201).json(question);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/admin/questions/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { topicId, text, audioUrl } = req.body;
    const updated = await prisma.speakingQuestion.update({
      where: { id: parseInt(req.params.id as string) },
      data: {
        ...(topicId !== undefined && { topicId: parseInt(topicId) }),
        ...(text !== undefined && { text }),
        ...(audioUrl !== undefined && { audioUrl })
      }
    });
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/admin/questions/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    await prisma.speakingQuestion.delete({ where: { id: parseInt(req.params.id as string) } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Vocabulary ---
router.post('/admin/vocabulary', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { questionId, word, definition, example } = req.body;
    const vocab = await prisma.speakingVocabulary.create({
      data: { questionId: parseInt(questionId), word, definition, example }
    });
    res.status(201).json(vocab);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/admin/vocabulary/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { word, definition, example } = req.body;
    const updated = await prisma.speakingVocabulary.update({
      where: { id: parseInt(req.params.id as string) },
      data: {
        ...(word !== undefined && { word }),
        ...(definition !== undefined && { definition }),
        ...(example !== undefined && { example })
      }
    });
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/admin/vocabulary/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    await prisma.speakingVocabulary.delete({ where: { id: parseInt(req.params.id as string) } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Ideas ---
router.post('/admin/ideas', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { questionId, text } = req.body;
    const idea = await prisma.speakingIdea.create({
      data: { questionId: parseInt(questionId), text }
    });
    res.status(201).json(idea);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/admin/ideas/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { text } = req.body;
    const updated = await prisma.speakingIdea.update({
      where: { id: parseInt(req.params.id as string) },
      data: { text }
    });
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/admin/ideas/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    await prisma.speakingIdea.delete({ where: { id: parseInt(req.params.id as string) } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Sample Answers ---
router.post('/admin/sample-answers', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { questionId, text, audioUrl, cefrLevel } = req.body;
    const answer = await prisma.speakingSampleAnswer.create({
      data: { questionId: parseInt(questionId), text, audioUrl, cefrLevel }
    });
    res.status(201).json(answer);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/admin/sample-answers/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { text, audioUrl, cefrLevel } = req.body;
    const updated = await prisma.speakingSampleAnswer.update({
      where: { id: parseInt(req.params.id as string) },
      data: {
        ...(text !== undefined && { text }),
        ...(audioUrl !== undefined && { audioUrl }),
        ...(cefrLevel !== undefined && { cefrLevel })
      }
    });
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/admin/sample-answers/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    await prisma.speakingSampleAnswer.delete({ where: { id: parseInt(req.params.id as string) } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
