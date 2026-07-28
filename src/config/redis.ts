import { Redis } from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const redisClient = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redisClient.on('connect', () => console.log('Connected to Redis'));
redisClient.on('error', (err: Error) => console.error('Redis error:', err.message));
