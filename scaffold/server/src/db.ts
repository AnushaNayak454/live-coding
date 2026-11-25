import { MongoClient, type Db, type Collection } from 'mongodb';
import { config } from './config.js';

let client: MongoClient | undefined;
let db: Db | undefined;

export async function getDb(): Promise<Db> {
  if (!client) {
    client = new MongoClient(config.mongoUrl);
    await client.connect();
    db = client.db();
    await ensureIndexes(db);
  }
  return db!;
}

export async function ensureIndexes(db: Db): Promise<void> {
  // Conversations: one per workspace+contact
  await db.collection('conversations').createIndexes([
    { key: { workspace: 1, contact: 1 }, unique: true },
    { key: { workspace: 1, updatedAt: -1 } },
  ]);

  // Messages: message_id is globally unique from Pigeon
  await db.collection('messages').createIndexes([
    { key: { workspace: 1, contact: 1, occurredAt: 1 } },
    { key: { messageId: 1 }, unique: true },
  ]);

  // Processed events: prevent duplicate webhook processing
  await db.collection('processedEvents').createIndexes([
    { key: { eventId: 1 }, unique: true },
    { key: { createdAt: 1 }, expireAfterSeconds: 3600 }, // TTL 1 hour
  ]);

  // Outbound jobs: durable outbound message queue
  await db.collection('outboundJobs').createIndexes([
    { key: { clientRef: 1 }, unique: true },
    { key: { status: 1, nextAttemptAt: 1 } },
    { key: { workspace: 1, status: 1 } },
  ]);

  // Real-time events for replay
  await db.collection('wsEvents').createIndexes([
    { key: { workspace: 1, seq: 1 }, unique: true },
    { key: { workspace: 1 } },
    { key: { createdAt: 1 }, expireAfterSeconds: 86400 }, // TTL 24h
  ]);
}
