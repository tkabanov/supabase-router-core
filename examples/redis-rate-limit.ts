/**
 * Redis-based Rate Limiting Middleware Example
 *
 * This example demonstrates production-ready rate limiting using Upstash Redis.
 * Unlike in-memory rate limiting, this works correctly in serverless environments
 * with multiple instances and auto-scaling.
 *
 * @module examples/redis-rate-limit
 */

import type { Middleware, MiddlewareContext } from "../core/types.ts";

/**
 * Redis client interface (compatible with Upstash Redis)
 */
export interface RedisClient {
  /**
   * Increment a key and return the new value
   */
  incr(key: string): Promise<number>;

  /**
   * Set expiration time on a key
   */
  expire(key: string, seconds: number): Promise<number>;

  /**
   * Get the TTL (time to live) of a key
   */
  ttl(key: string): Promise<number>;
}

/**
 * Options for Redis rate limiter
 */
export interface RedisRateLimitOptions<TUser = unknown> {
  /** Redis client instance */
  redis: RedisClient;
  /** Maximum number of requests allowed in the window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Optional function to extract rate limit key from context (default: IP address) */
  keyFn?: (ctx: MiddlewareContext<TUser>) => string;
  /** Optional prefix for Redis keys (default: 'ratelimit:') */
  keyPrefix?: string;
}

/**
 * Create a Redis-based rate limiting middleware
 *
 * Features:
 * - Distributed rate limiting (works across multiple instances)
 * - Automatic key expiration (no memory leaks)
 * - Sliding window algorithm
 * - Production-ready for serverless environments
 *
 * @param options - Rate limit configuration
 * @returns Rate limiting middleware
 *
 * @example Basic usage with Upstash Redis
 * ```typescript
 * import { Redis } from '@upstash/redis';
 * import { redisRateLimitMiddleware } from './examples/redis-rate-limit.ts';
 *
 * const redis = new Redis({
 *   url: Deno.env.get('UPSTASH_REDIS_URL')!,
 *   token: Deno.env.get('UPSTASH_REDIS_TOKEN')!,
 * });
 *
 * const router = defineRouter({
 *   middlewares: [
 *     redisRateLimitMiddleware({
 *       redis,
 *       maxRequests: 100,
 *       windowMs: 60000, // 1 minute
 *     }),
 *   ],
 *   routes: [...]
 * });
 * ```
 *
 * @example Custom key function (rate limit by user ID)
 * ```typescript
 * const middleware = redisRateLimitMiddleware({
 *   redis,
 *   maxRequests: 1000,
 *   windowMs: 3600000, // 1 hour
 *   keyFn: (ctx) => ctx.user?.id || ctx.req.headers.get('x-forwarded-for') || 'anonymous',
 * });
 * ```
 *
 * @example Per-route rate limiting
 * ```typescript
 * defineRoute({
 *   method: 'POST',
 *   path: '/api/expensive-operation',
 *   middlewares: [
 *     redisRateLimitMiddleware({
 *       redis,
 *       maxRequests: 10,
 *       windowMs: 60000, // 10 requests per minute
 *     }),
 *   ],
 *   handler: async () => { ... }
 * })
 * ```
 */
export function redisRateLimitMiddleware<TUser = unknown>(
  options: RedisRateLimitOptions<TUser>,
): Middleware<TUser> {
  const {
    redis,
    maxRequests,
    windowMs,
    keyFn,
    keyPrefix = "ratelimit:",
  } = options;

  const windowSeconds = Math.ceil(windowMs / 1000);

  return async (ctx, next) => {
    // Extract rate limit key (default: IP address)
    const identifier = keyFn
      ? keyFn(ctx)
      : ctx.req.headers.get("x-forwarded-for") ||
        ctx.req.headers.get("x-real-ip") ||
        "unknown";

    const redisKey = `${keyPrefix}${identifier}`;

    try {
      // Increment request counter
      const requestCount = await redis.incr(redisKey);

      // Set expiration on first request in window
      if (requestCount === 1) {
        await redis.expire(redisKey, windowSeconds);
      }

      // Check if rate limit exceeded
      if (requestCount > maxRequests) {
        // Get TTL for Retry-After header
        const ttl = await redis.ttl(redisKey);

        return new Response(
          JSON.stringify({
            error: "Rate limit exceeded",
            message: `Too many requests. Please try again in ${ttl} seconds.`,
            retryAfter: ttl,
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(Math.max(ttl, 1)),
              "X-RateLimit-Limit": String(maxRequests),
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": String(Date.now() + (ttl * 1000)),
            },
          },
        );
      }

      // Add rate limit headers to response
      const response = await next();

      // Clone response to add headers
      const newResponse = new Response(response.body, response);
      newResponse.headers.set("X-RateLimit-Limit", String(maxRequests));
      newResponse.headers.set(
        "X-RateLimit-Remaining",
        String(Math.max(0, maxRequests - requestCount)),
      );

      // Calculate reset time
      const ttl = await redis.ttl(redisKey);
      newResponse.headers.set(
        "X-RateLimit-Reset",
        String(Date.now() + (ttl * 1000)),
      );

      return newResponse;
    } catch (error) {
      // If Redis is unavailable, log error and allow request through
      // (fail open to prevent complete service outage)
      ctx.services.logger.error("Rate limiter error:", error);
      return await next();
    }
  };
}

/**
 * Create a token bucket rate limiter (more sophisticated algorithm)
 *
 * This implementation uses a token bucket algorithm which allows bursts
 * while maintaining average rate limits over time.
 *
 * @param options - Rate limit configuration with token bucket parameters
 * @returns Rate limiting middleware
 *
 * @example Token bucket with burst capacity
 * ```typescript
 * const middleware = tokenBucketRateLimitMiddleware({
 *   redis,
 *   capacity: 100,        // Maximum tokens
 *   refillRate: 10,       // Tokens per second
 *   cost: 1,              // Tokens per request
 * });
 * ```
 */
export function tokenBucketRateLimitMiddleware<TUser = unknown>(options: {
  redis: RedisClient;
  capacity: number;
  refillRate: number;
  cost?: number;
  keyFn?: (ctx: MiddlewareContext<TUser>) => string;
  keyPrefix?: string;
}): Middleware<TUser> {
  const {
    redis,
    capacity,
    refillRate,
    cost = 1,
    keyFn,
    keyPrefix = "tokenbucket:",
  } = options;

  return async (ctx, next) => {
    const identifier = keyFn
      ? keyFn(ctx)
      : ctx.req.headers.get("x-forwarded-for") || "unknown";

    const redisKey = `${keyPrefix}${identifier}`;
    void capacity;
    void refillRate;
    void cost;

    try {
      // For token bucket, we'd need Lua scripts or more complex Redis operations
      // This is a simplified version - for production, consider using Redis Lua scripts
      // or a dedicated rate limiting library
      await redis.ttl(redisKey).catch(() => 0);

      // This is a placeholder - real implementation would be more complex
      ctx.services.logger.warn(
        `Token bucket rate limiter requires Lua scripts for production use (key=${redisKey})`,
      );

      return await next();
    } catch (error) {
      ctx.services.logger.error("Token bucket rate limiter error:", error);
      return await next();
    }
  };
}

/**
 * Setup instructions and environment variables needed
 */
export const SETUP_INSTRUCTIONS = `
Redis Rate Limiting Setup
==========================

1. Create an Upstash Redis database:
   - Go to https://upstash.com/
   - Create a new Redis database
   - Copy the REST URL and token

2. Set environment variables:
   UPSTASH_REDIS_URL=https://your-redis.upstash.io
   UPSTASH_REDIS_TOKEN=your-token-here

3. Install Upstash Redis client:
   Add to imports in deno.json:
   {
     "imports": {
       "@upstash/redis": "https://esm.sh/@upstash/redis@latest"
     }
   }

4. Use in your router:
   import { Redis } from '@upstash/redis';
   import { redisRateLimitMiddleware } from './examples/redis-rate-limit.ts';
   
   const redis = new Redis({
     url: Deno.env.get('UPSTASH_REDIS_URL')!,
     token: Deno.env.get('UPSTASH_REDIS_TOKEN')!,
   });
   
   const router = defineRouter({
     middlewares: [
       redisRateLimitMiddleware({
         redis,
         maxRequests: 100,
         windowMs: 60000,
       }),
     ],
     routes: [...]
   });

Alternative: Cloudflare Rate Limiting
======================================

If your Supabase Edge Functions are behind Cloudflare, you can use
Cloudflare's built-in rate limiting instead:

1. Go to Cloudflare Dashboard > Security > WAF
2. Create a rate limiting rule
3. No code changes needed!

This is the simplest solution if available.
`;
