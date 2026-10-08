import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

dotenv.config();

import { validateSecrets } from './config/secrets.js';

// Fail closed before anything else: weak/missing JWT secrets must not boot.
try {
  validateSecrets();
} catch (err) {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
}

import { pool } from './db/pool.js';
import authRoutes from './routes/auth.js';
import courseRoutes from './routes/courses.js';
import assessmentRoutes from './routes/assessments.js';
import meetingRoutes from './routes/meetings.js';
import eventRoutes from './routes/events.js';
import userRoutes from './routes/users.js';
import adminRoutes from './routes/admin.js';
import dataRoutes from './routes/data.js';
import notificationRoutes from './routes/notifications.js';
import { startCalendarReminderScheduler } from './services/calendarNotifications.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Trust the proxy so rate-limit and req.ip see the real client address behind Railway/Vercel.
app.set('trust proxy', 1);

// helmet with a CSP relaxed just enough for the compiled SPA (inline styles + same-origin scripts/images).
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", "'unsafe-inline'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'", 'https:'],
        'frame-ancestors': ["'none'"],
        'object-src': ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
  })
);

// CORS allowlist from env (comma-separated). Fail closed in production: an unset
// CORS_ORIGIN must NOT silently become "allow every origin" once deployed.
const corsAllowlist = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && corsAllowlist.length === 0) {
  console.error('FATAL: CORS_ORIGIN must be set in production (comma-separated allowlist). Refusing to start with a permissive CORS policy.');
  process.exit(1);
}
if (!isProduction && corsAllowlist.length === 0) {
  console.warn('[CORS] CORS_ORIGIN unset — running in permissive dev mode. Do NOT deploy without setting it.');
}
console.log(`[CORS] mode=${corsAllowlist.length === 0 ? 'permissive (dev)' : 'allowlist'} origins=${corsAllowlist.length ? corsAllowlist.join(',') : '(any)'} NODE_ENV=${process.env.NODE_ENV || '(unset)'}`);

// The SPA is served same-origin by this process, so same-origin requests must
// always pass even when they aren't in CORS_ORIGIN. The `cors` package's origin
// callback never sees `req`, so we implement CORS directly to distinguish
// same-origin from cross-origin and to control middleware ordering.
function hostOf(value) {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // No Origin header → same-origin navigation, curl, health probes: allow.
  if (!origin) return next();

  const sameOrigin = hostOf(origin) === hostOf(`${req.protocol}://${req.headers.host}`);
  const allowed =
    sameOrigin ||
    corsAllowlist.length === 0 || // dev only; production exits above if empty
    corsAllowlist.includes(origin);

  if (!allowed) {
    return res.status(403).json({ error: { code: 'CORS_NOT_ALLOWED', message: 'Origin not allowed.' } });
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }
  next();
});

app.use(compression());
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate limiters. Keyed on IP + email (when present) so one attacker can't spray many accounts.
const authKey = (req) => `${req.ip}:${(req.body?.email || '').toLowerCase()}`;
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: authKey,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in 15 minutes.' } }
});
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: authKey,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many reset requests. Try again later.' } }
});
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'AI endpoints are busy. Please slow down.' } }
});
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(generalLimiter);

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health checks
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', server: 'healthy', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', server: 'healthy', database: 'unreachable', error: err.message });
  }
});

// Helper to mount routers at a prefix
function mountRouters(prefix = '') {
  app.use(`${prefix}/auth/login`, authLimiter);
  app.use(`${prefix}/auth/register`, authLimiter);
  app.use(`${prefix}/auth/forgot-password`, forgotLimiter);
  app.use(`${prefix}/auth/reset-password`, forgotLimiter);
  app.use(`${prefix}/auth`, authRoutes);
  app.use(`${prefix}/courses`, courseRoutes);
  app.use(prefix, assessmentRoutes);
  app.use(prefix, meetingRoutes);
  app.use(prefix, eventRoutes);
  app.use(`${prefix}/users`, userRoutes);
  app.use(prefix, adminRoutes);
  app.use(`${prefix}/ai`, aiLimiter);
  app.use(prefix, dataRoutes);
  app.use(prefix, notificationRoutes);
}

// Mount under /v1 (primary for frontend), /api, and root
mountRouters('/v1');
mountRouters('/api');
startCalendarReminderScheduler();

// Direct /login and /register shortcuts if frontend hits them directly
app.post('/login', authLimiter, (req, res, next) => {
  req.url = '/login';
  authRoutes(req, res, next);
});
app.post('/register', authLimiter, (req, res, next) => {
  req.url = '/register';
  authRoutes(req, res, next);
});

// Serve frontend static build if available
const webRoot = path.resolve(__dirname, '../apps/web');
if (fs.existsSync(path.join(webRoot, 'index.html'))) {
  console.log(`Serving frontend static build from ${webRoot}`);
  // Hashed assets (e.g. index-BOtlBGmE.js) — cache for 1 year since the hash changes on rebuild
  app.use('/assets', express.static(path.join(webRoot, 'assets'), { maxAge: '365d', immutable: true }));
  // Fonts — also long-cache
  app.use('/fonts', express.static(path.join(webRoot, 'fonts'), { maxAge: '365d', immutable: true }));
  // Everything else (index.html, favicon, logo) — no-cache so updates are picked up immediately
  app.use(express.static(webRoot, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));

  // Client-side SPA routing fallback
  app.get(/^(?!\/v1\/|\/api\/|\/health).*/, (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.sendFile(path.join(webRoot, 'index.html'));
  });
}

// 404 & Error handlers
app.use(notFound);
app.use(errorHandler);

// Fail-fast DB verification before starting server
async function startServer() {
  if (!process.env.DATABASE_URL) {
    console.error('FATAL: DATABASE_URL environment variable is unset.');
    process.exit(1);
  }

  try {
    console.log('Connecting to PostgreSQL database...');
    const client = await pool.connect();
    const res = await client.query('SELECT current_database(), version()');
    console.log(`Connected to PostgreSQL: database "${res.rows[0].current_database}"`);
    client.release();
  } catch (err) {
    console.error('FATAL: Unable to reach PostgreSQL database at DATABASE_URL:', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`===============================================`);
    console.log(`REAL_i Backend Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/v1/health`);
    console.log(`Frontend URL: http://localhost:${PORT}`);
    console.log(`===============================================`);
  });
}

startServer();

export default app;
