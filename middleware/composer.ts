import type {
  Middleware,
  MiddlewareContext,
  ServiceContainer,
} from "../core/types.ts";

/**
 * Compose multiple middlewares into a single middleware
 * @param middlewares - Array of middleware functions
 * @returns Composed middleware
 *
 * @example
 * ```typescript
 * const composed = composeMiddlewares([logging, auth, validation]);
 * ```
 */
export function composeMiddlewares<
  TUser = unknown,
  TContainer extends ServiceContainer = ServiceContainer,
>(
  middlewares: Middleware<TUser, TContainer>[],
): Middleware<TUser, TContainer> {
  if (middlewares.length === 0) {
    // No-op middleware if empty
    return async (_ctx, next) => await next();
  }

  return (ctx: MiddlewareContext<TUser, TContainer>, last: Middleware<TUser, TContainer>) => {
    let index = -1;

    const dispatch = (i: number): Promise<Response> => {
      if (i <= index) {
        return Promise.reject(new Error("next() called multiple times"));
      }

      index = i;

      const middleware = i < middlewares.length ? middlewares[i] : last;

      return middleware(ctx, () => dispatch(i + 1));
    };

    return dispatch(0);
  };
}

/**
 * Create a middleware that runs only if condition is met
 * @param condition - Function that returns boolean
 * @param middleware - Middleware to run conditionally
 * @returns Conditional middleware
 *
 * @example
 * ```typescript
 * const authIfNotPublic = conditionalMiddleware(
 *   (ctx) => !ctx.req.url.includes("/public"),
 *   authMiddleware
 * );
 * ```
 */
export function conditionalMiddleware<
  TUser = unknown,
  TContainer extends ServiceContainer = ServiceContainer,
>(
  condition: (ctx: MiddlewareContext<TUser, TContainer>) => boolean,
  middleware: Middleware<TUser, TContainer>,
): Middleware<TUser, TContainer> {
  return async (ctx, next) => {
    if (condition(ctx)) {
      return await middleware(ctx, next);
    }
    return await next();
  };
}

/**
 * Create a middleware that catches errors
 * @param errorHandler - Error handling function
 * @returns Error catching middleware
 *
 * @example
 * ```typescript
 * const errorMiddleware = catchErrors((error, ctx) => {
 *   console.error(error);
 *   return new Response("Error", { status: 500 });
 * });
 * ```
 */
export function catchErrors<
  TUser = unknown,
  TContainer extends ServiceContainer = ServiceContainer,
>(
  errorHandler: (
    error: unknown,
    ctx: MiddlewareContext<TUser, TContainer>,
  ) => Response | Promise<Response>,
): Middleware<TUser, TContainer> {
  return async (ctx, next) => {
    try {
      return await next();
    } catch (error) {
      return await errorHandler(error, ctx);
    }
  };
}
