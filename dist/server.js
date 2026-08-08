import 'dotenv/config';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { rejectQueryOperators } from './middleware/sanitize.js';
import { redisClient } from './config/redis.js';
import { setAuthCacheEnabled } from './utils/authCache.js';
import { seedDatabase } from './config/seed.js';
import { purgeExpiredSoftDeletes } from './config/purge.js';
import { sweepOverdueOrders } from './config/delaySweep.js';
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
// Origin match is exact, so the apex and www hosts each need their own entry —
// the admin portal is served from www.apsaraclean.com/admin-portal.
const ALLOWED_ORIGINS = [
    'https://funny-llama-333beb.netlify.app',
    'http://localhost:3000',
    'http://localhost:3002',
    'https://apsaraclean.com',
    'https://www.apsaraclean.com',
    'https://apsara-web.vercel.app',
];
async function startServer() {
    const app = express();
    const PORT = process.env.PORT || 4000;
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/apsaraclean';
    // ─── MongoDB ────────────────────────────────────────────────────────────────
    try {
        await mongoose.connect(MONGODB_URI, {
            family: 4,
            // Wire compression between the app and the database. Order lists and report rows are
            // large, repetitive JSON — exactly what zstd collapses — and this is pure win whenever
            // the database isn't on the same host. Drivers negotiate down to no compression if the
            // server doesn't support it, so it's safe against any deployment target.
            compressors: ['zstd', 'zlib'],
            // Fail a request rather than queue it indefinitely when the primary is unreachable.
            serverSelectionTimeoutMS: 10000,
            maxPoolSize: 50,
            // Index builds are a deploy-time operation, not a per-boot one. Mongoose otherwise
            // re-issues createIndex for every index in the schema on every start, which on a large
            // collection is slow and competes with live traffic. Run `npm run sync-indexes` after
            // deploying a schema change instead — see scripts/syncIndexes.ts.
            autoIndex: process.env.NODE_ENV !== 'production',
        });
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
    // ─── Security headers ───────────────────────────────────────────────────────
    // Mounted before anything else so every response carries them, including errors.
    //
    // crossOriginResourcePolicy is the one setting that must be changed from helmet's
    // default: it ships as 'same-origin', which would immediately stop the frontend from
    // loading order images, since the web app and this API are on different origins by
    // design. CORS (below) is what actually governs who may call this API — CORP would only
    // break the image tags.
    //
    // HSTS is production-only: it instructs browsers to refuse plain HTTP for this host,
    // which is correct behind the TLS terminator and merely confusing on a local http server.
    app.use(helmet({
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        frameguard: { action: 'deny' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
        hsts: process.env.NODE_ENV === 'production'
            ? { maxAge: 15552000, includeSubDomains: true }
            : false,
    }));
    // Mounted ahead of the routes so every JSON response is compressed on the way out. Order
    // lists, report rows and the dashboard payloads are large, highly repetitive JSON that
    // typically shrinks by ~85% — on the mobile connections this app is actually used over,
    // that's the single largest contributor to perceived response time.
    app.use(compression());
    app.use(express.json({ limit: '10mb' }));
    app.use(cookieParser());
    // Runs after the body parser (so req.body is populated) and before any route, so no
    // handler can be reached with an operator-shaped field name in its payload.
    app.use(rejectQueryOperators);
    // nosniff: uploaded order images are validated by extension+mimetype, not real content
    // sniffing, so this stops a browser from re-interpreting a served file as something other
    // than its declared type.
    //
    // Uploads are immutable once written — the filename carries a timestamp and a random
    // suffix (see the multer config in routes/orders.ts), so a given URL always names the same
    // bytes and can never be updated in place. Without a cache directive the browser
    // revalidated every order image on every render of every card; `immutable` means it stops
    // asking entirely for a year.
    app.use('/uploads', express.static(uploadsDir, {
        maxAge: '1y',
        immutable: true,
        setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
    }));
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
    // The auth-context cache shares this verdict rather than discovering it per request. With
    // no Redis it turns itself off entirely, so sessionVerification reads straight from Mongo
    // instead of issuing commands that can only fail.
    setAuthCacheEnabled(redisReady);
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
    // Master data (articles / washing methods) lives on the services router as
    // /api/services/master/*. It was duplicated here too, byte-identical but outside
    // sessionVerification, so the same reference data was readable without logging in.
    // Health check
    app.get('/check-status', (_req, res) => res.json({ message: 'Ok' }));
    // ─── Housekeeping ───────────────────────────────────────────────────────────
    // Daily at 3am — hard-deletes soft-deleted orders/services/staff/branches past the
    // 3-month retention window (PRD requirement, Phase 8).
    cron.schedule('0 3 * * *', () => {
        purgeExpiredSoftDeletes().catch((err) => console.error('[purge] failed:', err));
    });
    // Every few minutes — flips is_delayed on open orders that have crossed their due date.
    //
    // This is the one delay transition no request can catch, because it isn't caused by a
    // request: an order simply sits there and the deadline passes. Every other transition
    // (completing, cancelling, editing the due date) recomputes the flag inline on the write.
    // Running at :00, :10, :20 … keeps the Dashboard's delayed count within ten minutes of the
    // truth, which is well inside what the number is used for; the query it runs is a narrow
    // indexed match, so the cost of the tick is negligible when nothing has expired.
    cron.schedule('*/10 * * * *', () => {
        sweepOverdueOrders().catch((err) => console.error('[delaySweep] failed:', err));
    });
    // ─── Start ──────────────────────────────────────────────────────────────────
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
startServer();
