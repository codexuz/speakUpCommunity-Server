import { Request, Response, Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest, authenticateRequest, requireRole } from '../middleware/auth';
import prisma from '../prisma';
import { uploadImage } from '../services/minio';

const router = Router();

router.use(authenticateRequest);

const adImageUpload = multer({
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

// GET /api/ads — list active ads (all authenticated users)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const ads = await prisma.ad.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    res.json(ads);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ads/all — list all ads including inactive (admin only)
router.get('/all', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const ads = await prisma.ad.findMany({
      orderBy: { createdAt: 'desc' },
    });

    res.json(ads);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ads/:id — get single ad (admin only)
router.get('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const ad = await prisma.ad.findUnique({
      where: { id: parseInt(req.params.id as string) },
    });
    if (!ad) {
      res.status(404).json({ error: 'Ad not found' });
      return;
    }

    res.json(ad);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/ads — create ad with image upload (admin only)
router.post('/', requireRole('admin'), adImageUpload.single('image'), async (req: Request, res: Response) => {
  try {
    const { title, linkUrl } = req.body;

    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'image file is required' });
      return;
    }

    const ext = file.originalname.split('.').pop() || 'jpg';
    const fileName = `ads/${uuidv4()}.${ext}`;
    const imageUrl = await uploadImage(fileName, file.buffer, file.mimetype);

    const ad = await prisma.ad.create({
      data: {
        title,
        imageUrl,
        linkUrl: linkUrl || null,
      },
    });

    res.status(201).json(ad);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/ads/:id — update ad (admin only)
router.put('/:id', requireRole('admin'), adImageUpload.single('image'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    const existing = await prisma.ad.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'Ad not found' });
      return;
    }

    const { title, linkUrl, isActive } = req.body;
    const data: any = {};

    if (title !== undefined) data.title = title;
    if (linkUrl !== undefined) data.linkUrl = linkUrl || null;
    if (isActive !== undefined) data.isActive = isActive === 'true' || isActive === true;

    if (req.file) {
      const ext = req.file.originalname.split('.').pop() || 'jpg';
      const fileName = `ads/${uuidv4()}.${ext}`;
      data.imageUrl = await uploadImage(fileName, req.file.buffer, req.file.mimetype);
    }

    const ad = await prisma.ad.update({ where: { id }, data });

    res.json(ad);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/ads/:id — delete ad (admin only)
router.delete('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    const existing = await prisma.ad.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'Ad not found' });
      return;
    }

    await prisma.ad.delete({ where: { id } });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
