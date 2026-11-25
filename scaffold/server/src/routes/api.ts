/**
 * API routes for conversations, messages, replies.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { createOutboundJob } from '../worker.js';
import { publishWsEvent } from '../wsEvents.js';

const router = Router();

// Auth middleware: require session
function requireAuth(req: Request, res: Response, next: any) {
  const user = (req as any).session?.user;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Check workspace membership
function checkWorkspace(user: any, workspaceId: string): boolean {
  return user.workspaces.some((w: any) => w.id === workspaceId);
}

/**
 * GET /api/me
 */
router.get('/me', (req: Request, res: Response) => {
  const user = (req as any).session?.user;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  return res.json({ sub: user.sub, email: user.email, name: user.name, workspaces: user.workspaces });
});

/**
 * GET /api/conversations?workspace=<id>&page=<n>&limit=<n>
 */
router.get('/conversations', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).session.user;
  const workspace = req.query.workspace as string;

  if (!workspace) return res.status(400).json({ error: 'workspace required' });
  if (!checkWorkspace(user, workspace)) return res.status(403).json({ error: 'Forbidden' });

  const page = Math.max(1, parseInt(req.query.page as string ?? '1', 10));
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string ?? '20', 10)));
  const skip = (page - 1) * limit;

  try {
    const db = await getDb();
    const total = await db.collection('conversations').countDocuments({ workspace });
    const conversations = await db.collection('conversations')
      .find({ workspace })
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    // Get latest message preview for each conversation
    const result = await Promise.all(conversations.map(async (conv) => {
      const latestMsg = await db.collection('messages').findOne(
        { workspace, contact: conv.contact },
        { sort: { occurredAt: -1 } }
      );
      return {
        id: conv._id,
        contact: conv.contact,
        status: conv.status,
        assignee: conv.assignee,
        updatedAt: conv.updatedAt,
        createdAt: conv.createdAt,
        latestMessage: latestMsg ? {
          text: latestMsg.text,
          direction: latestMsg.direction,
          occurredAt: latestMsg.occurredAt,
        } : null,
      };
    }));

    return res.json({ conversations: result, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Conversations error:', err);
    return res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

/**
 * GET /api/conversations/:contact/messages?workspace=<id>
 */
router.get('/conversations/:contact/messages', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).session.user;
  const workspace = req.query.workspace as string;
  const contact = decodeURIComponent(req.params.contact);

  if (!workspace) return res.status(400).json({ error: 'workspace required' });
  if (!checkWorkspace(user, workspace)) return res.status(403).json({ error: 'Forbidden' });

  try {
    const db = await getDb();
    const messages = await db.collection('messages')
      .find({ workspace, contact })
      .sort({ occurredAt: 1 })
      .toArray();

    const outboundJobs = await db.collection('outboundJobs')
      .find({ workspace, contact })
      .toArray();

    // Merge inbound messages and outbound jobs into a timeline
    const jobMap = new Map(outboundJobs.map(j => [j.clientRef, j]));

    const timeline = messages.map(msg => ({
      messageId: msg.messageId,
      direction: msg.direction,
      text: msg.text,
      occurredAt: msg.occurredAt,
      status: msg.direction === 'outbound' ? (jobMap.get(msg.clientRef)?.status ?? 'sent') : undefined,
      clientRef: msg.clientRef,
    }));

    // Also add outbound jobs not yet in messages (pending/sending)
    for (const job of outboundJobs) {
      if (!messages.some(m => m.clientRef === job.clientRef)) {
        timeline.push({
          messageId: job.pigeonMessageId ?? job.clientRef,
          direction: 'outbound',
          text: job.text,
          occurredAt: job.createdAt,
          status: job.status,
          clientRef: job.clientRef,
        });
      }
    }

    timeline.sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());

    const conv = await db.collection('conversations').findOne({ workspace, contact });
    return res.json({ messages: timeline, conversation: conv });
  } catch (err) {
    console.error('Messages error:', err);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

/**
 * POST /api/conversations/:contact/reply
 * { workspace, text }
 */
router.post('/conversations/:contact/reply', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).session.user;
  const { workspace, text } = req.body;
  const contact = decodeURIComponent(req.params.contact);

  if (!workspace || !text) return res.status(400).json({ error: 'workspace and text required' });
  if (!checkWorkspace(user, workspace)) return res.status(403).json({ error: 'Forbidden' });

  try {
    const db = await getDb();
    const clientRef = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // Ensure conversation exists
    await db.collection('conversations').updateOne(
      { workspace, contact },
      { $setOnInsert: { workspace, contact, status: 'open', assignee: null, createdAt: new Date(), updatedAt: new Date() } },
      { upsert: true }
    );

    await createOutboundJob(workspace, contact, text, clientRef);

    return res.status(202).json({ ok: true, client_ref: clientRef });
  } catch (err) {
    console.error('Reply error:', err);
    return res.status(500).json({ error: 'Failed to send reply' });
  }
});

/**
 * POST /api/conversations/:contact/claim
 * { workspace }
 */
router.post('/conversations/:contact/claim', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).session.user;
  const { workspace } = req.body;
  const contact = decodeURIComponent(req.params.contact);

  if (!workspace) return res.status(400).json({ error: 'workspace required' });
  if (!checkWorkspace(user, workspace)) return res.status(403).json({ error: 'Forbidden' });

  try {
    const db = await getDb();

    // Ensure conversation exists
    await db.collection('conversations').updateOne(
      { workspace, contact },
      { $setOnInsert: { workspace, contact, status: 'open', assignee: null, createdAt: new Date(), updatedAt: new Date() } },
      { upsert: true }
    );

    const result = await db.collection('conversations').findOneAndUpdate(
      {
        workspace,
        contact,
        $or: [{ assignee: null }, { assignee: user.sub }],
      },
      { $set: { assignee: user.sub, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );

    if (result) {
      await publishWsEvent({
        type: 'conversation.assigned',
        workspace,
        contact,
        assignee: user.sub,
      }).catch(() => {});
      return res.json({ ok: true, assignee: user.sub });
    } else {
      const conv = await db.collection('conversations').findOne({ workspace, contact });
      return res.status(409).json({ error: 'Already claimed', assignee: conv?.assignee });
    }
  } catch (err) {
    console.error('Claim error:', err);
    return res.status(500).json({ error: 'Claim failed' });
  }
});

/**
 * POST /api/conversations/:contact/close
 * POST /api/conversations/:contact/reopen
 */
router.post('/conversations/:contact/close', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).session.user;
  const { workspace } = req.body;
  const contact = decodeURIComponent(req.params.contact);

  if (!workspace) return res.status(400).json({ error: 'workspace required' });
  if (!checkWorkspace(user, workspace)) return res.status(403).json({ error: 'Forbidden' });

  try {
    const db = await getDb();
    await db.collection('conversations').updateOne(
      { workspace, contact },
      { $set: { status: 'closed', updatedAt: new Date() } }
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to close' });
  }
});

router.post('/conversations/:contact/reopen', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).session.user;
  const { workspace } = req.body;
  const contact = decodeURIComponent(req.params.contact);

  if (!workspace) return res.status(400).json({ error: 'workspace required' });
  if (!checkWorkspace(user, workspace)) return res.status(403).json({ error: 'Forbidden' });

  try {
    const db = await getDb();
    await db.collection('conversations').updateOne(
      { workspace, contact },
      { $set: { status: 'open', updatedAt: new Date() } }
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reopen' });
  }
});

export default router;
