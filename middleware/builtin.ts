import type { Middleware, MiddlewareContext } from "../core/types.ts";
import { sanitizeErrorMessage } from "../security/sanitizer.ts";

/**
 * Logging middleware - logs request and response information
 * @param options - Logging options
 * @returns Logging middleware
 *
 * @example
 * ```typescript
 * const middleware = loggingMiddleware({ logBody: false });
 * ```
 */
export function loggingMiddleware<TUser = unknown>(options?: {
  logBody?: boolean;
  logHeaders?: boolean;
}): Middleware<TUser> {
  return async (ctx, next) => {
    const start = Date.now();
    const { req, services } = ctx;

    services.logger.log(`→ ${req.method} ${req.url}`);

    if (options?.logHeaders) {
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key] = value;
      });
      services.logger.log("  Headers:", headers);
    }

    if (options?.logBody && ctx.body) {
      services.logger.log("  Body:", ctx.body);
    }

    const response = await next();
    const duration = Date.now() - start;

    services.logger.log(
      `← ${req.method} ${req.url} - ${response.status} (${duration}ms)`,
    );

    return response;
  };
}

/**
 * Request timing middleware - adds timing information to response headers
 * @returns Timing middleware
 *
 * @example
 * ```typescript
 * const middleware = timingMiddleware();
 * ```
 */
export function timingMiddleware<TUser = unknown>(): Middleware<TUser> {
  return async (_ctx, next) => {
    const start = Date.now();
    const response = await next();
    const duration = Date.now() - start;

    // Clone response to add headers
    const newResponse = new Response(response.body, response);
    newResponse.headers.set("X-Response-Time", `${duration}ms`);

    return newResponse;
  };
}

/**
 * Request ID middleware - adds unique request ID to context and response
 * @returns Request ID middleware
 *
 * @example
 * ```typescript
 * const middleware = requestIdMiddleware();
 * ```
 */
export function requestIdMiddleware<TUser = unknown>(): Middleware<TUser> {
  return async (ctx, next) => {
    const requestId = ctx.services.idGenerator.generate();

    // Add to context (if not already set)
    const contextWithRequestId = ctx as typeof ctx & { requestId?: string };
    if (!contextWithRequestId.requestId) {
      contextWithRequestId.requestId = requestId;
    }

    const response = await next();

    // Clone response to add header
    const newResponse = new Response(response.body, response);
    newResponse.headers.set("X-Request-Id", requestId);

    return newResponse;
  };
}

/**
 * Rate limiting middleware (in-memory, simple implementation)
 *
 * @deprecated FOR LOCAL DEVELOPMENT ONLY
 *
 * WARNING: This in-memory implementation DOES NOT WORK in serverless environments
 * with multiple instances (auto-scaling). Each instance maintains its own Map,
 * allowing rate limits to be bypassed when requests are distributed across instances.
 *
 * ISSUES:
 * - Memory leak: Map grows indefinitely without cleanup
 * - Not shared across instances: Rate limits are per-instance, not global
 * - OOM risk: Sustained load will exhaust memory
 *
 * FOR PRODUCTION USE:
 * - Cloudflare Rate Limiting (automatic, no code needed)
 * - Upstash Redis (see examples/redis-rate-limit.ts)
 * - Other distributed rate limiting solutions
 *
 * @param options - Rate limit options
 * @returns Rate limiting middleware
 *
 * @example Local development only
 * ```typescript
 * const middleware = rateLimitMiddleware({
 *   maxRequests: 100,
 *   windowMs: 60000 // 1 minute
 * });
 * ```
 *
 * @example Production with Redis
 * ```typescript
 * import { redisRateLimitMiddleware } from './examples/redis-rate-limit.ts';
 * const middleware = redisRateLimitMiddleware({
 *   redis: redisClient,
 *   maxRequests: 100,
 *   windowMs: 60000
 * });
 * ```
 */
export function rateLimitMiddleware<TUser = unknown>(options: {
  maxRequests: number;
  windowMs: number;
  keyFn?: (ctx: MiddlewareContext<TUser>) => string;
}): Middleware<TUser> {
  const requests = new Map<string, number[]>();

  return async (ctx, next) => {
    const key = options.keyFn
      ? options.keyFn(ctx)
      : ctx.req.headers.get("x-forwarded-for") || "unknown";
    const now = Date.now();

    // Get or create request timestamps for this key
    let timestamps = requests.get(key) || [];

    // Filter out old timestamps
    timestamps = timestamps.filter((ts) => now - ts < options.windowMs);

    // Check if rate limit exceeded
    if (timestamps.length >= options.maxRequests) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded" }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(Math.ceil(options.windowMs / 1000)),
          },
        },
      );
    }

    // Add current timestamp
    timestamps.push(now);
    requests.set(key, timestamps);

    return await next();
  };
}

/**
 * Request timeout middleware
 * @param timeoutMs - Timeout in milliseconds
 * @returns Timeout middleware
 *
 * @example
 * ```typescript
 * const middleware = timeoutMiddleware(5000); // 5 second timeout
 * ```
 */
export function timeoutMiddleware<TUser = unknown>(
  timeoutMs: number,
): Middleware<TUser> {
  return async (_ctx, next) => {
    let timeoutId: number | undefined;

    const timeoutPromise = new Promise<Response>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error("Request timeout"));
      }, timeoutMs);
    });

    try {
      const response = await Promise.race([next(), timeoutPromise]);
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      return response;
    } catch (error) {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }

      if (error instanceof Error && error.message === "Request timeout") {
        return new Response(
          JSON.stringify({ error: "Request timeout" }),
          {
            status: 408,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      throw error;
    }
  };
}

/**
 * Body size limit middleware
 * @param maxSize - Maximum body size in bytes
 * @returns Body size middleware
 *
 * @example
 * ```typescript
 * const middleware = bodySizeLimitMiddleware(1024 * 1024); // 1MB limit
 * ```
 */
export function bodySizeLimitMiddleware<TUser = unknown>(
  maxSize: number,
): Middleware<TUser> {
  return async (ctx, next) => {
    const contentLength = ctx.req.headers.get("content-length");

    if (contentLength && parseInt(contentLength) > maxSize) {
      return new Response(
        JSON.stringify({ error: "Request body too large" }),
        {
          status: 413,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return await next();
  };
}

/**
 * Error handling middleware with sanitization
 * @param isDevelopment - Whether to include stack traces
 * @returns Error handling middleware
 *
 * @example
 * ```typescript
 * const middleware = errorHandlerMiddleware(Deno.env.get("ENV") === "dev");
 * ```
 */
export function errorHandlerMiddleware<TUser = unknown>(
  isDevelopment: boolean = false,
): Middleware<TUser> {
  return async (ctx, next) => {
    try {
      return await next();
    } catch (error) {
      ctx.services.logger.error("Request error:", error);

      if (error instanceof Response) {
        return error;
      }

      const message = error instanceof Error
        ? error.message
        : "Internal server error";
      const sanitized = sanitizeErrorMessage(message);

      return new Response(
        JSON.stringify({
          error: sanitized,
          ...(isDevelopment && error instanceof Error &&
            { stack: error.stack }),
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }
  };
}
