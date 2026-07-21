import 'dotenv/config';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { redisClient } from './config/redis.js';
import { seedDatabase } from './config/seed.js';

import authRoutes from './routes/auth.js';
import branchRoutes from './routes/branches.js';
import businessRoutes from './routes/business.js';
import dashboardRoutes from './routes/dashboard.js';
import orderRoutes from './routes/orders.js';
import reportRoutes from './routes/reports.js';
import serviceRoutes from './routes/services.js';
import staffRoutes from './routes/staff.js';
import adminRoutes from './routes/admin.js';
import analyticsRoutes from './routes/analytics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALLOWED_ORIGINS = [
  'https://funny-llama-333beb.netlify.app',
  'http://localhost:3000',
  'http://localhost:3002',
  'https://apsaraclean.com',
  'https://apsara-web.vercel.app',
];

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 4000;
  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/apsaraclean';

  // ─── MongoDB ────────────────────────────────────────────────────────────────
  try {
    await mongoose.connect(MONGODB_URI, { family: 4 });
    console.log('Connected to MongoDB');
    await seedDatabase();
  } catch (err) {
    console.error('MongoDB connection error:', err);
  }

  // ─── Uploads dir ────────────────────────────────────────────────────────────
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/uploads', express.static(uploadsDir));

  // ─── CORS ───────────────────────────────────────────────────────────────────
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // ─── Session (Redis) ────────────────────────────────────────────────────────
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) throw new Error('SESSION_SECRET environment variable must be set');

  app.use(
    session({
      store: new RedisStore({ client: redisClient as any }),
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: '/',
      },
    })
  );

  // ─── Routes ─────────────────────────────────────────────────────────────────
  app.use('/api/auth', authRoutes);
  app.use('/api/branches', branchRoutes);
  app.use('/api/business', businessRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/services', serviceRoutes);
  app.use('/api/staff', staffRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/analytics', analyticsRoutes);

  // Master data
  app.get('/api/master/articles', async (_req, res) => {
    const { Article } = await import('./models.js');
    const articles = await Article.find().sort({ name: 1 });
    res.json(articles);
  });
  app.get('/api/master/washing-methods', async (_req, res) => {
    const { WashingMethod } = await import('./models.js');
    const methods = await WashingMethod.find().sort({ name: 1 });
    res.json(methods);
  });

  // Health check
  app.get('/check-status', (_req, res) => res.json({ message: 'Ok' }));

  // ─── Start ──────────────────────────────────────────────────────────────────
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

startServer();
