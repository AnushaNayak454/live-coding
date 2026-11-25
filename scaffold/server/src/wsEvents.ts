/**
 * WebSocket event storage and pub/sub.
 * Each workspace has a monotonically increasing seq counter.
 * Events are stored in MongoDB for replay, and published to Redis for cross-instance delivery.
 */
import { getDb } from './db.js';
import { getRedis } from './redis.js';

export interface WsEvent {
  seq: number;
  type: string;
  workspace: string;
  contact?: string;
  message_id?: string;
  client_ref?: string;
  status?: string;
  assignee?: string;
  [key: string]: unknown;
}

// Get next seq for workspace atomically using Redis INCR
export async function getNextSeq(workspace: string): Promise<number> {
  const redis = getRedis();
  return redis.incr(`seq:${workspace}`);
}

// Store event in MongoDB and publish to Redis channel atomically
export async function publishWsEvent(event: Omit<WsEvent, 'seq'>): Promise<WsEvent> {
  const workspace = event.workspace as string;
  const redis = getRedis();

  const script = `
    local seq = redis.call('INCR', KEYS[1])
    local data = cjson.decode(ARGV[1])
    data['seq'] = seq
    local payload = cjson.encode(data)
    redis.call('PUBLISH', KEYS[2], payload)
    return {seq, payload}
  `;

  const [seq, payload] = (await redis.eval(
    script,
    2,
    `seq:${workspace}`,
    `ws:${workspace}`,
    JSON.stringify(event)
  )) as [number, string];

  const full: WsEvent = JSON.parse(payload);

  const db = await getDb();
  try {
    await db.collection('wsEvents').insertOne({
      ...full,
      createdAt: new Date(),
    });
  } catch (err: any) {
    if (err.code === 11000) {
      console.warn('Duplicate wsEvent seq, skipping:', seq);
    } else {
      throw err;
    }
  }

  return full;
}

// Get all events after a given seq for replay
export async function getEventsAfter(workspace: string, afterSeq: number): Promise<WsEvent[]> {
  const db = await getDb();
  const events = await db.collection('wsEvents')
    .find({ workspace, seq: { $gt: afterSeq } })
    .sort({ seq: 1 })
    .toArray();
  return events.map((doc) => {
    const { _id, createdAt, ...e } = doc as any;
    return e as WsEvent;
  });
}
