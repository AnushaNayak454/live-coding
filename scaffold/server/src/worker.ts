/**
 * Outbound message job worker.
 * Uses MongoDB as a durable queue. Redis for distributed locking.
 * Recovers abandoned jobs every 60 seconds.
 */
import { getDb } from './db.js';
import { getRedis } from './redis.js';
import { config } from './config.js';
import { publishWsEvent } from './wsEvents.js';
import { checkRateLimit, setCooloff, isCoolingOff } from './rateLimiter.js';

const LOCK_TTL_MS = 60_000; // 60 seconds lock TTL
const RETRY_DELAYS = [2000, 5000, 15000, 30000]; // retry delays in ms
const WORKER_INTERVAL_MS = 1000;

export interface OutboundJob {
  clientRef: string;
  workspace: string;
  contact: string;
  text: string;
  status: 'pending' | 'sending' | 'sent' | 'delivered' | 'failed';
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil?: Date;
  lockedBy?: string;
  createdAt: Date;
  updatedAt: Date;
  pigeonMessageId?: string;
}

// Worker identity for locking
const WORKER_ID = `w_${process.pid}_${Math.random().toString(36).slice(2)}`;

/**
 * Create a new outbound job. Idempotent: same clientRef returns existing job.
 */
export async function createOutboundJob(
  workspace: string,
  contact: string,
  text: string,
  clientRef: string
): Promise<OutboundJob> {
  const db = await getDb();
  const now = new Date();

  const job: OutboundJob = {
    clientRef,
    workspace,
    contact,
    text,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.collection<OutboundJob>('outboundJobs').insertOne(job as any);
    return job;
  } catch (err: any) {
    if (err.code === 11000) {
      // Already exists - return existing
      const existing = await db.collection<OutboundJob>('outboundJobs').findOne({ clientRef });
      return existing!;
    }
    throw err;
  }
}

/**
 * Update message status from a Pigeon status webhook.
 * Implements status ordering: only advance status, never revert.
 */
export async function updateMessageStatus(
  workspace: string,
  clientRef: string,
  pigeonMessageId: string,
  newStatus: string
): Promise<void> {
  const db = await getDb();
  
  const statusOrder: Record<string, number> = {
    pending: 0,
    sending: 1,
    queued: 1,
    sent: 2,
    delivered: 3,
    failed: 3,
  };

  const newOrder = statusOrder[newStatus] ?? 0;
  
  // Only update if new status is "higher" than current
  // Use MongoDB query to prevent regression
  const validCurrentStatuses = Object.entries(statusOrder)
    .filter(([, order]) => order <= newOrder)
    .map(([s]) => s);

  await db.collection('outboundJobs').updateOne(
    {
      workspace,
      clientRef,
      status: { $in: validCurrentStatuses },
    },
    {
      $set: {
        status: newStatus,
        pigeonMessageId,
        updatedAt: new Date(),
      },
    }
  );

  // Publish WebSocket event for status change
  await publishWsEvent({
    type: 'message.status',
    workspace,
    contact: (await db.collection('outboundJobs').findOne({ clientRef }))?.contact ?? '',
    client_ref: clientRef,
    status: newStatus,
  }).catch(() => {/* non-critical */});
}

/**
 * Process one pending job. Uses Redis locking to prevent duplicate processing.
 */
async function processOneJob(): Promise<boolean> {
  const db = await getDb();
  const now = new Date();

  // Find a job that's pending/sending and not locked
  const job = await db.collection<OutboundJob>('outboundJobs').findOneAndUpdate(
    {
      status: { $in: ['pending', 'sending'] },
      nextAttemptAt: { $lte: now },
      $or: [
        { lockedUntil: { $exists: false } },
        { lockedUntil: { $lte: now } },
      ] as any,
    },
    {
      $set: {
        status: 'sending',
        lockedBy: WORKER_ID,
        lockedUntil: new Date(Date.now() + LOCK_TTL_MS),
        updatedAt: now,
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after' }
  );

  if (!job) return false;

  try {
    await sendJobToProvider(job);
    return true;
  } catch (err) {
    // Will be retried
    return true;
  }
}

async function sendJobToProvider(job: OutboundJob): Promise<void> {
  const db = await getDb();
  
  // Check rate limit
  if (await isCoolingOff(job.workspace)) {
    // Re-queue for later
    await db.collection('outboundJobs').updateOne(
      { clientRef: job.clientRef, lockedBy: WORKER_ID },
      {
        $set: {
          status: 'pending',
          lockedBy: null,
          lockedUntil: null,
          nextAttemptAt: new Date(Date.now() + 2000),
          updatedAt: new Date(),
        },
      }
    );
    return;
  }

  const rl = await checkRateLimit(job.workspace);
  if (!rl.allowed) {
    const delay = (rl.retryAfter ?? 1) * 1000;
    await setCooloff(job.workspace, rl.retryAfter ?? 1);
    await db.collection('outboundJobs').updateOne(
      { clientRef: job.clientRef, lockedBy: WORKER_ID },
      {
        $set: {
          status: 'pending',
          lockedBy: null,
          lockedUntil: null,
          nextAttemptAt: new Date(Date.now() + delay),
          updatedAt: new Date(),
        },
      }
    );
    return;
  }

  const apiKey = config.pigeon.apiKeys[job.workspace];
  if (!apiKey) {
    await db.collection('outboundJobs').updateOne(
      { clientRef: job.clientRef },
      { $set: { status: 'failed', lockedBy: null, lockedUntil: null, updatedAt: new Date() } }
    );
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    let res: Response;
    try {
      res = await fetch(`${config.pigeon.url}/v1/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': job.clientRef,
        },
        body: JSON.stringify({
          to: job.contact,
          text: job.text,
          client_ref: job.clientRef,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 200) {
      const data = await res.json() as { id: string; status: string };
      await db.collection('outboundJobs').updateOne(
        { clientRef: job.clientRef, lockedBy: WORKER_ID },
        {
          $set: {
            status: 'sent',
            pigeonMessageId: data.id,
            lockedBy: null,
            lockedUntil: null,
            updatedAt: new Date(),
          },
        }
      );
    } else if (res.status === 429) {
      // Rate limited by provider
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
      await setCooloff(job.workspace, retryAfter);
      const delay = (retryAfter + 1) * 1000;
      await db.collection('outboundJobs').updateOne(
        { clientRef: job.clientRef, lockedBy: WORKER_ID },
        {
          $set: {
            status: 'pending',
            lockedBy: null,
            lockedUntil: null,
            nextAttemptAt: new Date(Date.now() + delay),
            updatedAt: new Date(),
          },
        }
      );
    } else if (res.status === 503) {
      // Temporary failure - retry with backoff
      const attempt = Math.min(job.attempts - 1, RETRY_DELAYS.length - 1);
      const delay = RETRY_DELAYS[attempt] ?? 30000;
      await db.collection('outboundJobs').updateOne(
        { clientRef: job.clientRef, lockedBy: WORKER_ID },
        {
          $set: {
            status: 'pending',
            lockedBy: null,
            lockedUntil: null,
            nextAttemptAt: new Date(Date.now() + delay),
            updatedAt: new Date(),
          },
        }
      );
    } else {
      // Permanent failure
      await db.collection('outboundJobs').updateOne(
        { clientRef: job.clientRef, lockedBy: WORKER_ID },
        {
          $set: {
            status: 'failed',
            lockedBy: null,
            lockedUntil: null,
            updatedAt: new Date(),
          },
        }
      );
    }
  } catch (err: any) {
    // Network timeout or abort - retry
    const attempt = Math.min(job.attempts - 1, RETRY_DELAYS.length - 1);
    const delay = RETRY_DELAYS[attempt] ?? 30000;
    await db.collection('outboundJobs').updateOne(
      { clientRef: job.clientRef },
      {
        $set: {
          status: 'pending',
          lockedBy: null,
          lockedUntil: null,
          nextAttemptAt: new Date(Date.now() + delay),
          updatedAt: new Date(),
        },
      }
    ).catch(() => {/* best effort */});
  }
}

/**
 * Recover abandoned/locked jobs from crashed workers.
 */
export async function recoverAbandonedJobs(): Promise<void> {
  const db = await getDb();
  const now = new Date();
  
  await db.collection('outboundJobs').updateMany(
    {
      status: 'sending',
      lockedUntil: { $lte: now },
    },
    {
      $set: {
        status: 'pending',
        lockedBy: null,
        lockedUntil: null,
        nextAttemptAt: new Date(),
        updatedAt: now,
      },
    }
  );
}

let workerRunning = false;

/**
 * Start the background worker loop.
 */
export function startWorker(): void {
  if (workerRunning) return;
  workerRunning = true;
  
  // Recover abandoned jobs every 60 seconds
  const recoveryInterval = setInterval(async () => {
    try {
      await recoverAbandonedJobs();
    } catch (err) {
      console.error('Recovery error:', err);
    }
  }, 60_000);
  
  recoveryInterval.unref();

  // Process jobs continuously
  async function loop() {
    try {
      const processed = await processOneJob();
      // If we processed something, check again immediately; else wait
      setTimeout(loop, processed ? 0 : WORKER_INTERVAL_MS);
    } catch (err) {
      console.error('Worker loop error:', err);
      setTimeout(loop, WORKER_INTERVAL_MS);
    }
  }
  
  setTimeout(loop, 100); // slight delay on startup
}
