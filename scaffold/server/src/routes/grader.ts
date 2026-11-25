/**
 * Grader endpoints: reset, snapshot, reply, claim.
 * Protected by x-grader-token header.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db.js';
import { getRedis } from '../redis.js';
import { config } from '../config.js';
import { createOutboundJob } from '../worker.js';
import { publishWsEvent } from '../wsEvents.js';

const router = Router();

// Auth middleware
function graderAuth(req: Request, res: Response, next: any) {
  const token = req.headers['x-grader-token'];
  if (token !== config.graderToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(graderAuth);

/**
 * POST /__grader/reset
 * Delete all application data.
 */
router.post('/reset', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    await Promise.all([
      db.collection('conversations').deleteMany({}),
      db.collection('messages').deleteMany({}),
      db.collection('processedEvents').deleteMany({}),
      db.collection('outboundJobs').deleteMany({}),
      db.collection('wsEvents').deleteMany({}),
    ]);

    // Reset Redis sequence counters and rate limiters
    const redis = getRedis();
    const keys = await redis.keys('seq:*');
    const rlKeys = await redis.keys('rl:pigeon:*');
    if (keys.length > 0) await redis.del(...keys);
    if (rlKeys.length > 0) await redis.del(...rlKeys);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Reset error:', err);
    return res.status(500).json({ error: 'Reset failed' });
  }
});

/**
 * GET /__grader/snapshot
 * Returns current state of conversations and outbound messages.
 */
router.get('/snapshot', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();

    const conversations = await db.collection('conversations').find({}).toArray();
    const messages = await db.collection('messages').find({}).sort({ occurredAt: 1 }).toArray();
    const outboundJobs = await db.collection('outboundJobs').find({}).toArray();

    // Build snapshot structure
    const workspaces: Record<string, any> = {};

    for (const conv of conversations) {
      if (!workspaces[conv.workspace]) {
        workspaces[conv.workspace] = { contacts: {}, outbound: {} };
      }
      workspaces[conv.workspace].contacts[conv.contact] = {
        inbound: [],
        assignee: conv.assignee ?? null,
      };
    }

    // Fill inbound messages per contact (chronological by occurredAt)
    for (const msg of messages) {
      if (msg.direction !== 'inbound') continue;
      if (!workspaces[msg.workspace]) {
        workspaces[msg.workspace] = { contacts: {}, outbound: {} };
      }
      if (!workspaces[msg.workspace].contacts[msg.contact]) {
        workspaces[msg.workspace].contacts[msg.contact] = { inbound: [], assignee: null };
      }
      workspaces[msg.workspace].contacts[msg.contact].inbound.push(msg.messageId);
    }

    // Fill outbound statuses
    for (const job of outboundJobs) {
      if (!workspaces[job.workspace]) {
        workspaces[job.workspace] = { contacts: {}, outbound: {} };
      }
      workspaces[job.workspace].outbound[job.clientRef] = job.status;
    }

    return res.status(200).json({ workspaces });
  } catch (err) {
    console.error('Snapshot error:', err);
    return res.status(500).json({ error: 'Snapshot failed' });
  }
});

/**
 * POST /__grader/reply
 * { workspace, contact, text, client_ref }
 * Send a reply as if an agent typed it.
 */
router.post('/reply', async (req: Request, res: Response) => {
  const { workspace, contact, text, client_ref } = req.body;

  if (!workspace || !contact || !text || !client_ref) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Validate workspace exists
  if (!config.pigeon.apiKeys[workspace]) {
    return res.status(400).json({ error: 'Unknown workspace' });
  }

  try {
    const db = await getDb();

    // Ensure conversation exists (create if needed)
    await db.collection('conversations').updateOne(
      { workspace, contact },
      {
        $setOnInsert: {
          workspace,
          contact,
          status: 'open',
          assignee: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    // Create durable outbound job (idempotent by client_ref)
    await createOutboundJob(workspace, contact, text, client_ref);

    return res.status(202).json({ ok: true, client_ref });
  } catch (err) {
    console.error('Reply error:', err);
    return res.status(500).json({ error: 'Failed to queue reply' });
  }
});

/**
 * POST /__grader/claim
 * { workspace, contact, agent }
 * Claim a conversation atomically.
 */
router.post('/claim', async (req: Request, res: Response) => {
  const { workspace, contact, agent } = req.body;

  if (!workspace || !contact || !agent) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!config.pigeon.apiKeys[workspace]) {
    return res.status(400).json({ error: 'Unknown workspace' });
  }

  try {
    const db = await getDb();

    // Ensure conversation exists
    await db.collection('conversations').updateOne(
      { workspace, contact },
      {
        $setOnInsert: {
          workspace,
          contact,
          status: 'open',
          assignee: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    // Atomic claim: set assignee only if unassigned OR already this agent
    const result = await db.collection('conversations').findOneAndUpdate(
      {
        workspace,
        contact,
        $or: [
          { assignee: null },
          { assignee: agent },
        ],
      },
      {
        $set: { assignee: agent, updatedAt: new Date() },
      },
      { returnDocument: 'after' }
    );

    if (result) {
      // Publish assignment event
      await publishWsEvent({
        type: 'conversation.assigned',
        workspace,
        contact,
        assignee: agent,
      }).catch(() => {});

      return res.status(200).json({ ok: true, assignee: agent });
    } else {
      // Someone else holds the conversation
      const conv = await db.collection('conversations').findOne({ workspace, contact });
      return res.status(409).json({
        error: 'Conversation already claimed',
        assignee: conv?.assignee,
      });
    }
  } catch (err) {
    console.error('Claim error:', err);
    return res.status(500).json({ error: 'Claim failed' });
  }
});

export default router;
