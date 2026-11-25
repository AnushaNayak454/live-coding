/**
 * Webhook HMAC-SHA256 verification for Pigeon.
 * Verifies: t=<unix seconds>,v1=<hex>
 * Signature is HMAC-SHA256 of "<t>.<rawBody>" with the webhook secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const MAX_AGE_SECONDS = 5 * 60; // 5 minutes

export function verifyPigeonSignature(secret: string, rawBody: Buffer, sigHeader: string): void {
  if (!sigHeader) throw { code: 401, message: 'Missing signature header' };

  const parts: Record<string, string> = {};
  for (const part of sigHeader.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) parts[part.slice(0, eq)] = part.slice(eq + 1);
  }

  const t = parts['t'];
  const v1 = parts['v1'];

  if (!t || !v1) throw { code: 401, message: 'Malformed signature header' };

  // Validate timestamp
  const ts = parseInt(t, 10);
  if (isNaN(ts)) throw { code: 401, message: 'Invalid timestamp' };

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_AGE_SECONDS) {
    throw { code: 401, message: 'Signature expired' };
  }

  // Compute expected signature
  const payload = `${t}.${rawBody.toString()}`;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');

  // Timing-safe comparison
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.alloc(expectedBuf.length);
  Buffer.from(v1, 'utf8').copy(actualBuf);

  let valid = false;
  try {
    valid = timingSafeEqual(expectedBuf, actualBuf) && v1.length === expected.length;
  } catch {
    valid = false;
  }

  if (!valid) throw { code: 401, message: 'Invalid signature' };
}

// Express middleware that reads raw body and attaches it
export function rawBodyMiddleware(req: Request, res: Response, next: NextFunction) {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    (req as any).rawBody = Buffer.concat(chunks);
    next();
  });
  req.on('error', next);
}
