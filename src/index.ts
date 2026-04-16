import './env';
import cors from 'cors';
import express from 'express';
import fs from 'fs';
import http from 'http';
import https from 'https';

import { authLimiter, defaultLimiter } from './middleware/rateLimiter';
import analyticsRoutes from './routes/analytics';
import adsRoutes from './routes/ads';
import aiFeedbackRoutes from './routes/aiFeedback';
import authRoutes from './routes/auth';
import challengesRoutes from './routes/challenges';
import communityRoutes from './routes/community';
import coursesRoutes from './routes/courses';
import groupChatRoutes from './routes/groupChat';
import groupsRoutes from './routes/groups';
import progressRoutes from './routes/progress';
import reviewsRoutes from './routes/reviews';
import speakingRoutes from './routes/speaking';
import teacherVerificationRoutes from './routes/teacherVerification';
import testsRoutes from './routes/tests';
import usersRoutes from './routes/users';
import { ensureBucket } from './services/minio';
import { initChatSocket } from './services/chatSocket';
import { initCronJobs } from './services/cron';
import { seedAchievements } from './services/seedAchievements';
import './workers/audio.worker';

// BigInt JSON serialization support
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_HOSTNAME = process.env.PUBLIC_HOSTNAME || 'localhost';
const SSL_KEY_FILE = process.env.SSL_KEY_FILE;
const SSL_CERT_FILE = process.env.SSL_CERT_FILE;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Origin not allowed by CORS'));
    },
  })
);
app.use(express.json());
app.use(defaultLimiter);

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/tests', testsRoutes);
app.use('/api/teacher-verification', teacherVerificationRoutes);
app.use('/api/speaking', speakingRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/group-chat', groupChatRoutes);
app.use('/api/community', communityRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/ads', adsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/challenges', challengesRoutes);
app.use('/api/courses', coursesRoutes);
app.use('/api/ai-feedback', aiFeedbackRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const useHttps = Boolean(SSL_KEY_FILE && SSL_CERT_FILE);

const server = useHttps
  ? https.createServer(
      {
        key: fs.readFileSync(SSL_KEY_FILE!),
        cert: fs.readFileSync(SSL_CERT_FILE!),
      },
      app
    )
  : http.createServer(app);

async function start() {
  try {
    await ensureBucket();
    console.log('MinIO bucket ready');
  } catch (err) {
    console.warn('MinIO not available — file uploads will fail:', (err as Error).message);
  }

  initChatSocket(server);
  console.log('Socket.IO chat server ready at /ws/chat');

  // Seed achievements and start cron jobs
  try {
    await seedAchievements();
  } catch (err) {
    console.warn('Achievement seeding failed:', (err as Error).message);
  }
  initCronJobs();

  server.listen(Number(PORT), HOST, () => {
    const protocol = useHttps ? 'https' : 'http';
    console.log(`Server running at ${protocol}://${PUBLIC_HOSTNAME}:${PORT}`);
  });
}

start();
