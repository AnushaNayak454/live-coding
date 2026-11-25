import express from 'express';
import { createServer } from 'node:http';
import session from 'express-session';
import { config } from './config.js';
import { getDb } from './db.js';
import { getRedis } from './redis.js';
import { rawBodyMiddleware } from './webhookVerify.js';
import { startWorker, recoverAbandonedJobs } from './worker.js';
import { setupWebSocket } from './websocket.js';
import webhookRouter from './routes/webhooks.js';
import graderRouter from './routes/grader.js';
import authRouter from './routes/auth.js';
import apiRouter from './routes/api.js';

const app = express();

// CORS for frontend
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === config.webOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-grader-token');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Session middleware using Redis for shared storage
// Custom Redis-backed session store (ioredis)
class RedisSessionStore extends session.Store {
  private prefix = 'sess:';

  get(sid: string, cb: (err: any, session?: session.SessionData | null) => void) {
    getRedis().get(this.prefix + sid).then((val) => {
      cb(null, val ? JSON.parse(val) : null);
    }).catch(cb);
  }

  set(sid: string, sessionData: session.SessionData, cb?: (err?: any) => void) {
    const maxAge = (sessionData.cookie as any)?.maxAge ?? 86400 * 1000;
    const ttl = Math.ceil(maxAge / 1000);
    getRedis().set(this.prefix + sid, JSON.stringify(sessionData), 'EX', ttl)
      .then(() => cb && cb())
      .catch((err) => cb && cb(err));
  }

  destroy(sid: string, cb?: (err?: any) => void) {
    getRedis().del(this.prefix + sid)
      .then(() => cb && cb())
      .catch((err) => cb && cb(err));
  }
}

const sessionMiddleware = session({
  store: new RedisSessionStore(),
  secret: config.oidc.clientSecret,
  resave: false,
  saveUninitialized: false,
  name: 'sb_session',
  cookie: {
    httpOnly: true,
    secure: false, // set true in production with HTTPS
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
});

app.use(sessionMiddleware);

// Webhook route needs raw body for signature verification
app.use('/webhooks/pigeon', rawBodyMiddleware, webhookRouter);

// JSON body parser for other routes
app.use(express.json());

// Grader endpoints
app.use('/__grader', graderRouter);

// Auth routes
app.use('/auth', authRouter);

// API routes
app.use('/api', apiRouter);

// Health endpoint - only return 200 when truly ready
let isReady = false;
app.get('/healthz', (_req, res) => {
  if (isReady) return res.json({ ok: true });
  return res.status(503).json({ ok: false, message: 'Starting up...' });
});

// Plain HTTP server so we can attach WebSockets
const server = createServer(app);

// Initialize WebSocket with session support
setupWebSocket(server, sessionMiddleware);

// Startup sequence
async function start() {
  try {
    // Connect to MongoDB and create indexes
    console.log('Connecting to MongoDB...');
    await getDb();
    console.log('MongoDB connected');

    // Connect to Redis
    console.log('Connecting to Redis...');
    const redis = getRedis();
    await redis.ping();
    console.log('Redis connected');

    // Recover any abandoned jobs from previous crash
    await recoverAbandonedJobs();
    console.log('Recovered abandoned jobs');

    // Start background worker
    startWorker();
    console.log('Worker started');

    // Mark server as ready
    isReady = true;

    server.listen(config.port, () => {
      console.log(`Switchboard server on http://localhost:${config.port}`);
    });
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
}

start();
