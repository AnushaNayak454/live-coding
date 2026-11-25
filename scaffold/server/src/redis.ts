import { Redis } from 'ioredis';
import { config } from './config.js';

let redisInstance: Redis | undefined;

export function getRedis(): Redis {
  if (!redisInstance) {
    redisInstance = new Redis(config.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    redisInstance.on('error', (err) => {
      console.error('Redis error:', err.message);
    });
  }
  return redisInstance;
}

// A separate subscriber connection (can't issue commands while subscribed)
let subInstance: Redis | undefined;

export function getSubRedis(): Redis {
  if (!subInstance) {
    subInstance = new Redis(config.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
    });
    subInstance.on('error', (err) => {
      console.error('Redis sub error:', err.message);
    });
  }
  return subInstance;
}
