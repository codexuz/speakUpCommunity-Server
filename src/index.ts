import './env';
import cors from 'cors';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
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
import notificationsRoutes from './routes/notifications';
import progressRoutes from './routes/progress';
import reviewsRoutes from './routes/reviews';
import speakingRoutes from './routes/speaking';
import speechRoutes from './routes/speech';
import teacherVerificationRoutes from './routes/teacherVerification';
import testsRoutes from './routes/tests';
import usersRoutes from './routes/users';
import writingRoutes from './routes/writing';
import { ensureBucket } from './services/minio';
import { initChatSocket } from './services/chatSocket';
import { initCronJobs } from './services/cron';
import { seedAchievements } from './services/seedAchievements';
import { createWebhookHandler, getTelegramBot } from './services/telegramBot';
import './workers/audio.worker';
import './workers/writing.worker';

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

// ── Well-known / Universal Links ────────────────────────────────
// Must be registered BEFORE express.static so dotfile paths are not blocked.
// Apple requires Content-Type: application/json and HTTPS with no redirects.
const wellKnownDir = path.join(__dirname, '..', 'public', '.well-known');

app.get('/.well-known/apple-app-site-association', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(path.join(wellKnownDir, 'apple-app-site-association'));
});

app.get('/.well-known/assetlinks.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(path.join(wellKnownDir, 'assetlinks.json'));
});

// Serve remaining public assets (images, etc.)
// dotfiles: 'allow' is required so that express.static doesn't 404 on .well-known paths.
app.use(express.static(path.join(__dirname, '..', 'public'), { dotfiles: 'allow' }));


// Telegram bot webhook — mounted before the rate limiter so Telegram
// server calls are not throttled and don't consume user quotas.
if (process.env.TELEGRAM_BOT_TOKEN) {
  const webhookPath = `/api/telegram-webhook/${process.env.TELEGRAM_BOT_TOKEN}`;
  app.use(webhookPath, createWebhookHandler());
}

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
app.use('/api/notifications', notificationsRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/challenges', challengesRoutes);
app.use('/api/courses', coursesRoutes);
app.use('/api/ai-feedback', aiFeedbackRoutes);
app.use('/api/writing', writingRoutes);
app.use('/api/speech', speechRoutes);

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

  // Set Telegram bot webhook
  if (process.env.TELEGRAM_BOT_TOKEN) {
    try {
      const webhookUrl = `https://speakup.impulselc.uz/api/telegram-webhook/${process.env.TELEGRAM_BOT_TOKEN}`;
      await getTelegramBot().api.setWebhook(webhookUrl);
      console.log('Telegram bot webhook set to', webhookUrl);
    } catch (err) {
      console.warn('Telegram webhook setup failed:', (err as Error).message);
    }
  }

  server.listen(Number(PORT), HOST, () => {
    const protocol = useHttps ? 'https' : 'http';
    console.log(`Server running at ${protocol}://${PUBLIC_HOSTNAME}:${PORT}`);
  });
}

start();
