/**
 * Workspace-level rate limiter using Redis.
 * Pigeon limit: bucket of 8 sends that refills at 4 per second.
 * Uses a sliding window / token bucket approach in Redis.
 */
import { getRedis } from './redis.js';

interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number; // seconds to wait
}

// Workspace rate limiter: 8 tokens max, refill 4/sec
const BUCKET_MAX = 8;
const REFILL_RATE = 4; // tokens per second

export async function checkRateLimit(workspace: string): Promise<RateLimitResult> {
  const redis = getRedis();
  const key = `rl:pigeon:${workspace}`;
  const now = Date.now();
  
  // Lua script for atomic token bucket
  const script = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local max_tokens = tonumber(ARGV[2])
    local refill_rate = tonumber(ARGV[3])
    
    local data = redis.call('HGETALL', key)
    local tokens = max_tokens
    local last_refill = now
    
    if #data > 0 then
      for i = 1, #data, 2 do
        if data[i] == 'tokens' then tokens = tonumber(data[i+1]) end
        if data[i] == 'last_refill' then last_refill = tonumber(data[i+1]) end
      end
      -- Refill tokens based on elapsed time
      local elapsed = (now - last_refill) / 1000
      tokens = math.min(max_tokens, tokens + elapsed * refill_rate)
      last_refill = now
    end
    
    if tokens >= 1 then
      tokens = tokens - 1
      redis.call('HSET', key, 'tokens', tokens, 'last_refill', last_refill)
      redis.call('EXPIRE', key, 60)
      return {1, 0}
    else
      -- Calculate wait time
      local needed = 1 - tokens
      local wait_ms = math.ceil(needed / refill_rate * 1000)
      redis.call('HSET', key, 'tokens', tokens, 'last_refill', last_refill)
      redis.call('EXPIRE', key, 60)
      return {0, wait_ms}
    end
  `;

  const result = await redis.eval(script, 1, key, now, BUCKET_MAX, REFILL_RATE) as number[];
  
  if (result[0] === 1) {
    return { allowed: true };
  } else {
    const retryAfterMs = result[1];
    return { allowed: false, retryAfter: Math.ceil(retryAfterMs / 1000) };
  }
}

// Set a cooloff period from Pigeon's Retry-After header
export async function setCooloff(workspace: string, retryAfterSeconds: number): Promise<void> {
  const redis = getRedis();
  const key = `rl:pigeon:cooloff:${workspace}`;
  await redis.set(key, '1', 'EX', retryAfterSeconds + 1);
  
  // Also drain tokens to 0 to prevent sends during cooloff
  const tokenKey = `rl:pigeon:${workspace}`;
  await redis.hset(tokenKey, 'tokens', '0', 'last_refill', Date.now());
  await redis.expire(tokenKey, retryAfterSeconds + 10);
}

export async function isCoolingOff(workspace: string): Promise<boolean> {
  const redis = getRedis();
  const key = `rl:pigeon:cooloff:${workspace}`;
  const val = await redis.get(key);
  return val !== null;
}
