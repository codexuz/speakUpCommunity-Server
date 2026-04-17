import { Request, Response, Router } from 'express';
import multer from 'multer';
import {
  AuthenticatedRequest,
  authenticateRequest,
} from '../middleware/auth';
import { uploadLimiter } from '../middleware/rateLimiter';
import { transcribeAudio } from '../services/aiFeedback';

const router = Router();

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  },
});

router.use(authenticateRequest);

// POST /api/speech/transcribe — transcribe uploaded audio
router.post(
  '/transcribe',
  uploadLimiter,
  audioUpload.single('audio'),
  async (req: Request, res: Response) => {
    try {
      const auth = (req as AuthenticatedRequest).auth!;

      if (!req.file) {
        res.status(400).json({ error: 'Audio file is required' });
        return;
      }

      if (!process.env.DEEPGRAM_API_KEY) {
        res.status(503).json({ error: 'Speech recognition service is not configured' });
        return;
      }

      const { transcript, words, duration } = await transcribeAudio(
        req.file.buffer,
        req.file.mimetype,
      );

      res.json({
        transcript,
        words,
        duration,
        wordCount: words.length,
      });
    } catch (error: any) {
      console.error('Transcription error:', error.message);
      res.status(500).json({ error: 'Failed to transcribe audio' });
    }
  },
);

// POST /api/speech/pronunciation-check — transcribe and compare against a reference text
router.post(
  '/pronunciation-check',
  uploadLimiter,
  audioUpload.single('audio'),
  async (req: Request, res: Response) => {
    try {
      const auth = (req as AuthenticatedRequest).auth!;
      const { referenceText } = req.body || {};

      if (!req.file) {
        res.status(400).json({ error: 'Audio file is required' });
        return;
      }

      if (!referenceText || typeof referenceText !== 'string') {
        res.status(400).json({ error: 'referenceText is required' });
        return;
      }

      if (!process.env.DEEPGRAM_API_KEY) {
        res.status(503).json({ error: 'Speech recognition service is not configured' });
        return;
      }

      const { transcript, words, duration } = await transcribeAudio(
        req.file.buffer,
        req.file.mimetype,
      );

      // Normalize texts for comparison
      const normalize = (t: string) =>
        t.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);

      const refWords = normalize(referenceText);
      const spokenWords = normalize(transcript);

      // Word-level matching
      const matched: { word: string; spoken: string | null; correct: boolean }[] = [];
      let correctCount = 0;

      for (let i = 0; i < refWords.length; i++) {
        const expected = refWords[i];
        const spoken = spokenWords[i] || null;
        const correct = spoken === expected;
        if (correct) correctCount++;
        matched.push({ word: expected, spoken, correct });
      }

      const accuracy = refWords.length > 0
        ? Math.round((correctCount / refWords.length) * 100)
        : 0;

      // Per-word confidence from Deepgram
      const avgConfidence = words.length > 0
        ? Math.round((words.reduce((sum, w) => sum + w.confidence, 0) / words.length) * 100)
        : 0;

      res.json({
        transcript,
        referenceText,
        accuracy,
        avgConfidence,
        duration,
        wordCount: words.length,
        details: matched,
      });
    } catch (error: any) {
      console.error('Pronunciation check error:', error.message);
      res.status(500).json({ error: 'Failed to check pronunciation' });
    }
  },
);

export default router;
