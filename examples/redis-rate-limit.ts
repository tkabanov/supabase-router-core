/**
 * Distributed rate limiting for Supabase Edge Functions with Upstash Redis.
 *
 * Edge Functions run many short-lived instances, so limits must live in a
 * shared store. This example uses `@upstash/ratelimit` (HTTP-based Redis,
 * atomic sliding window), as recommended by Supabase for Edge Functions.
 * Copy this file into your project; it is not exported by the package.
 *
 * Setup:
 * 1. Create a Redis database at https://console.upstash.com
 * 2. Set the secrets:
 *      supabase secrets set UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=...
 * 3. Add to deno.json:
 *      "@upstash/ratelimit": "npm:@upstash/ratelimit@^2.2.0",
 *      "@upstash/redis": "npm:@upstash/redis@^1.39.0"
 *
 * Choosing the key:
 * - Per user (recommended): add the middleware to a ROUTE's `middlewares`.
 *   Route middlewares run after authentication, so `ctx.user` is set.
 * - Per client IP: a GLOBAL middleware runs before authentication (it also
 *   protects the auth step), but `ctx.user` is not available there. Client IP
 *   headers are set by proxies and a client can add its own values; only
 *   trust the entry your platform's proxy guarantees.
 */
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type { Middleware, MiddlewareContext } from "../mod.ts";

/**
 * Anything with the `limit()` method of `@upstash/ratelimit`
 */
export interface RateLimiter {
  /** Count one request for `identifier` */
  limit(identifier: string): Promise<{
    success: boolean;
    limit: number;
    remaining: number;
    /** Unix time in milliseconds when the window resets */
    reset: number;
  }>;
}

/**
 * Options for {@link rateLimit}
 */
export interface RateLimitOptions<TUser> {
  /** Limiter, e.g. `new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, "10 s") })` */
  limiter: RateLimiter;
  /**
   * Identifier to count requests by. Return null to skip limiting for a
   * request (e.g. when no key is available).
   */
  key: (ctx: MiddlewareContext<TUser>) => string | null;
  /**
   * Let requests through when Redis is unavailable (default: true). Set to
   * false to answer 503 instead, e.g. for expensive endpoints.
   */
  failOpen?: boolean;
}

const tooManyRequests = (limit: number, reset: number): Response => {
  const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
  return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfter),
      "X-RateLimit-Limit": String(limit),
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": String(Math.ceil(reset / 1000)),
    },
  });
};

/**
 * Rate limiting middleware backed by a shared limiter
 * @param options - Limiter, key function and failure behaviour
 * @returns Middleware answering 429 with `Retry-After` when the limit is hit
 *
 * @example Per user, as a route middleware
 * ```typescript
 * const limiter = new Ratelimit({
 *   redis: Redis.fromEnv(),
 *   limiter: Ratelimit.slidingWindow(10, "10 s"),
 *   prefix: "my-app",
 * });
 *
 * defineRoute({
 *   method: "POST",
 *   path: "/messages",
 *   middlewares: [
 *     rateLimit({ limiter, key: (ctx) => (ctx.user as { id: string }).id }),
 *   ],
 *   handler: async () => ({ sent: true }),
 * });
 * ```
 */
export function rateLimit<TUser = unknown>(
  options: RateLimitOptions<TUser>,
): Middleware<TUser> {
  const { limiter, key, failOpen = true } = options;

  return async (ctx, next) => {
    const identifier = key(ctx);
    if (identifier === null) {
      return await next();
    }

    let result: Awaited<ReturnType<RateLimiter["limit"]>>;
    try {
      result = await limiter.limit(identifier);
    } catch (error) {
      ctx.services.logger.error("Rate limiter unavailable", error);
      return failOpen
        ? await next()
        : new Response(JSON.stringify({ error: "Service unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
    }

    return result.success
      ? await next()
      : tooManyRequests(result.limit, result.reset);
  };
}

/**
 * Sliding-window limiter from the Upstash env variables
 * (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`)
 * @param requests - Requests allowed per window
 * @param window - Window length, e.g. `"10 s"` or `"1 m"`
 * @returns Limiter for {@link rateLimit}
 */
export function createUpstashLimiter(
  requests: number,
  window: Parameters<typeof Ratelimit.slidingWindow>[1],
): Ratelimit {
  return new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(requests, window),
    prefix: "supabase-router",
  });
}
