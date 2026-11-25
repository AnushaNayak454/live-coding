/**
 * Webhook route for Pigeon events.
 * POST /webhooks/pigeon
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { verifyPigeonSignature } from '../webhookVerify.js';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { publishWsEvent } from '../wsEvents.js';
import { updateMessageStatus } from '../worker.js';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const rawBody: Buffer = (req as any).rawBody ?? Buffer.from('');
  const sigHeader = req.headers['x-pigeon-signature'] as string ?? '';

  // 1. Verify signature
  try {
    verifyPigeonSignature(config.pigeon.webhookSecret, rawBody, sigHeader);
  } catch (err: any) {
    return res.status(err.code ?? 401).json({ error: err.message });
  }

  // 2. Parse body (signature was valid, so return 400 for parse errors)
  let event: any;
  try {
    event = JSON.parse(rawBody.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const eventId = event.id ?? req.headers['x-pigeon-event-id'] as string;
  const db = await getDb();

  // 3. Deduplication: check if we already processed this event
  if (eventId) {
    try {
      await db.collection('processedEvents').insertOne({
        eventId,
        createdAt: new Date(),
      });
    } catch (err: any) {
      if (err.code === 11000) {
        // Already processed - return success (idempotent)
        return res.status(200).json({ ok: true, duplicate: true });
      }
      throw err;
    }
  }

  const { type, workspace, occurred_at, data } = event;

  // 4. Unknown event type - return 2xx per spec
  if (!type) return res.status(200).json({ ok: true });

  // 5. Unknown workspace - return 2xx per spec
  if (workspace && !config.pigeon.apiKeys[workspace]) {
    return res.status(200).json({ ok: true, ignored: 'unknown workspace' });
  }

  try {
    if (type === 'message.inbound') {
      await handleInbound(db, workspace, occurred_at, data);
    } else if (type === 'message.status') {
      await handleStatus(db, workspace, occurred_at, data);
    }
    // Any other event type: return 2xx and ignore
  } catch (err) {
    console.error('Webhook handler error:', err);
    // Remove from processedEvents so it can be retried
    if (eventId) {
      await db.collection('processedEvents').deleteOne({ eventId }).catch(() => {});
    }
    return res.status(500).json({ error: 'Internal error' });
  }

  return res.status(200).json({ ok: true });
});

async function handleInbound(db: any, workspace: string, occurred_at: string, data: any) {
  const { message_id, from, text } = data;
  if (!message_id || !from) return;

  const occurredAt = new Date(occurred_at);

  // Upsert conversation - only create if not exists, don't touch updatedAt here
  await db.collection('conversations').updateOne(
    { workspace, contact: from },
    {
      $setOnInsert: {
        workspace,
        contact: from,
        status: 'open',
        assignee: null,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
    },
    { upsert: true }
  );

  // Insert message (unique by message_id)
  try {
    await db.collection('messages').insertOne({
      messageId: message_id,
      workspace,
      contact: from,
      direction: 'inbound',
      text,
      occurredAt,
      createdAt: new Date(),
    });
  } catch (err: any) {
    if (err.code !== 11000) throw err;
    // Duplicate message - already stored, that's fine
    return;
  }

  // Update conversation's updatedAt only if this message is newer
  // This handles out-of-order delivery: we keep the latest timestamp
  await db.collection('conversations').updateOne(
    { workspace, contact: from, updatedAt: { $lt: occurredAt } },
    { $set: { updatedAt: occurredAt } }
  );

  // Publish real-time event
  await publishWsEvent({
    type: 'message.inbound',
    workspace,
    contact: from,
    message_id,
  });
}

async function handleStatus(db: any, workspace: string, occurred_at: string, data: any) {
  const { message_id, client_ref, status } = data;

  if (!client_ref || !status) return;

  // Check if we know this client_ref (ignore unknown)
  const job = await db.collection('outboundJobs').findOne({ clientRef: client_ref });
  if (!job) return; // Unknown outbound message - ignore per spec

  await updateMessageStatus(workspace, client_ref, message_id, status);
}

export default router;
