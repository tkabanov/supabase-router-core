import type { Middleware } from "../core/types.ts";
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

    const response = await next();
    const duration = Date.now() - start;

    // The body is parsed inside the pipeline, so it is only available after next()
    if (options?.logBody && ctx.body) {
      services.logger.log("  Body:", ctx.body);
    }

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
 * Request ID middleware - exposes the request ID (the same one handlers see
 * as `ctx.requestId`) in the `X-Request-Id` response header
 * @returns Request ID middleware
 *
 * @example
 * ```typescript
 * const middleware = requestIdMiddleware();
 * ```
 */
export function requestIdMiddleware<TUser = unknown>(): Middleware<TUser> {
  return async (ctx, next) => {
    const requestId = ctx.requestId || ctx.services.idGenerator.generate();
    ctx.requestId = requestId;

    const response = await next();

    // Clone response to add header
    const newResponse = new Response(response.body, response);
    newResponse.headers.set("X-Request-Id", requestId);

    return newResponse;
  };
}

/**
 * Request timeout middleware.
 *
 * Note: JavaScript cannot cancel a running handler. The client gets a 408
 * after `timeoutMs`, but the handler keeps running in the background.
 *
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
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

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
    const contentLength = Number(ctx.req.headers.get("content-length") ?? 0);

    // Chunked requests have no Content-Length; enforce limits at the platform
    // level (Supabase/Deno Deploy) for those.
    if (contentLength > maxSize) {
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
 * Error handling middleware. Logs the error via `services.logger`; clients
 * only see the error message and stack trace in development, otherwise a
 * generic message (internal details such as SQL or connection strings must
 * not leak).
 * @param isDevelopment - Whether to expose the message and stack trace
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

      const details = isDevelopment && error instanceof Error;
      return new Response(
        JSON.stringify({
          error: details
            ? sanitizeErrorMessage(error.message)
            : "Internal server error",
          ...(details && { stack: error.stack }),
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
