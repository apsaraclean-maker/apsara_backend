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
import cron from 'node-cron';
import { redisClient } from './config/redis.js';
import { seedDatabase } from './config/seed.js';
import { purgeExpiredSoftDeletes } from './config/purge.js';
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
import geocodeRoutes from './routes/geocode.js';
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
    }
    catch (err) {
        console.error('MongoDB connection error:', err);
    }
    // ─── Uploads dir ────────────────────────────────────────────────────────────
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir))
        fs.mkdirSync(uploadsDir, { recursive: true });
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '10mb' }));
    app.use(cookieParser());
    // nosniff: uploaded order images are validated by extension+mimetype, not real content
    // sniffing, so this stops a browser from re-interpreting a served file as something other
    // than its declared type.
    app.use('/uploads', express.static(uploadsDir, { setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff') }));
    // ─── CORS ───────────────────────────────────────────────────────────────────
    app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && ALLOWED_ORIGINS.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS')
            return res.sendStatus(200);
        next();
    });
    // ─── Session (Redis, falling back to express-session's in-memory store if
    // Redis is unreachable — e.g. this sandbox, which has no Redis instance at all.
    // Without this, every request touching req.session throws MaxRetriesPerRequestError
    // once ioredis exhausts its retries, which surfaces as the frontend's AuthGuard
    // silently bouncing back to "/" right after a successful login (500 on /auth/me,
    // treated the same as 401). Fine for single-instance local dev; NOT safe for a
    // real multi-instance production deployment, where Redis must actually be up.
    // ────────────────────────────────────────────────────────────────────────────
    const sessionSecret = process.env.SESSION_SECRET;
    if (!sessionSecret)
        throw new Error('SESSION_SECRET environment variable must be set');
    const redisReady = await Promise.race([
        redisClient.ping().then(() => true).catch(() => false),
        new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    if (!redisReady) {
        console.warn('[session] Redis unreachable — using in-memory session store instead (dev/local fallback only).');
    }
    app.use(session({
        // connect-redis must stay on v8.x: v9 dropped its ioredis compatibility
        // shim and issues node-redis-only `SET key val {expiration:{...}}`, which
        // ioredis stringifies into a bogus argument → "ReplyError: ERR syntax error"
        // on every session write (i.e. every login).
        store: redisReady ? new RedisStore({ client: redisClient }) : undefined,
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
    }));
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
    app.use('/api/geocode', geocodeRoutes);
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
    // ─── Housekeeping ───────────────────────────────────────────────────────────
    // Daily at 3am — hard-deletes soft-deleted orders/services/staff/branches past the
    // 3-month retention window (PRD requirement, Phase 8).
    cron.schedule('0 3 * * *', () => {
        purgeExpiredSoftDeletes().catch((err) => console.error('[purge] failed:', err));
    });
    // ─── Start ──────────────────────────────────────────────────────────────────
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
startServer();
