import { HTTP_STATUS } from "../core/constants.ts";
import { sanitizeErrorMessage } from "../security/sanitizer.ts";
import { z, type ZodTypeAny } from "npm:zod";
import type { ErrorSchemaDefinition } from "../core/types.ts";

/**
 * Base error response creator
 * @param message - Error message
 * @param status - HTTP status code
 * @param cause - Optional error cause
 * @returns Response with error
 */
function createErrorResponse(
  message: string,
  status: number,
  cause?: unknown,
): Response {
  const sanitized = sanitizeErrorMessage(message);

  const body: Record<string, unknown> = {
    error: sanitized,
  };

  if (cause !== undefined) {
    body.cause = cause;
  }

  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

/**
 * 200 OK - Success response
 * @param data - Response data
 * @returns JSON response
 *
 * @example
 * ```typescript
 * return ok({ message: "Success" });
 * ```
 */
export function ok<T>(data: T): Response {
  return new Response(JSON.stringify(data), {
    status: HTTP_STATUS.OK,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * 201 Created - Resource created successfully
 * @param data - Created resource data
 * @returns JSON response
 *
 * @example
 * ```typescript
 * return created({ id: "123", name: "New User" });
 * ```
 */
export function created<T>(data: T): Response {
  return new Response(JSON.stringify(data), {
    status: HTTP_STATUS.CREATED,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * 204 No Content - Success with no response body
 * @returns Empty response
 *
 * @example
 * ```typescript
 * return noContent();
 * ```
 */
export function noContent(): Response {
  return new Response(null, {
    status: HTTP_STATUS.NO_CONTENT,
  });
}

/**
 * 400 Bad Request - Invalid request data
 * @param message - Error message
 * @param cause - Optional error cause
 * @returns Error response
 *
 * @example
 * ```typescript
 * return badRequest("Invalid email format");
 * ```
 */
export function badRequest(
  message: string = "Bad Request",
  cause?: unknown,
): Response {
  return createErrorResponse(message, HTTP_STATUS.BAD_REQUEST, cause);
}

/**
 * 401 Unauthorized - Authentication required
 * @param message - Error message
 * @param cause - Optional error cause
 * @returns Error response
 *
 * @example
 * ```typescript
 * return unauthorized("Invalid token");
 * ```
 */
export function unauthorized(
  message: string = "Unauthorized",
  cause?: unknown,
): Response {
  return createErrorResponse(message, HTTP_STATUS.UNAUTHORIZED, cause);
}

/**
 * 403 Forbidden - Insufficient permissions
 * @param message - Error message
 * @param cause - Optional error cause
 * @returns Error response
 *
 * @example
 * ```typescript
 * return forbidden("Admin access required");
 * ```
 */
export function forbidden(
  message: string = "Forbidden",
  cause?: unknown,
): Response {
  return createErrorResponse(message, HTTP_STATUS.FORBIDDEN, cause);
}

/**
 * 404 Not Found - Resource not found
 * @param message - Error message
 * @param cause - Optional error cause
 * @returns Error response
 *
 * @example
 * ```typescript
 * return notFound("User not found");
 * ```
 */
export function notFound(
  message: string = "Not Found",
  cause?: unknown,
): Response {
  return createErrorResponse(message, HTTP_STATUS.NOT_FOUND, cause);
}

/**
 * 405 Method Not Allowed - HTTP method not supported
 * @param message - Error message
 * @param cause - Optional error cause
 * @returns Error response
 *
 * @example
 * ```typescript
 * return methodNotAllowed("Only POST allowed");
 * ```
 */
export function methodNotAllowed(
  message: string = "Method Not Allowed",
  cause?: unknown,
): Response {
  return createErrorResponse(message, HTTP_STATUS.METHOD_NOT_ALLOWED, cause);
}

/**
 * 422 Unprocessable Entity - Validation failed
 * @param message - Error message
 * @param cause - Optional error cause
 * @returns Error response
 *
 * @example
 * ```typescript
 * return unprocessableEntity("Validation failed", validationErrors);
 * ```
 */
export function unprocessableEntity(
  message: string = "Unprocessable Entity",
  cause?: unknown,
): Response {
  return createErrorResponse(message, HTTP_STATUS.UNPROCESSABLE_ENTITY, cause);
}

/**
 * 500 Internal Server Error - Server error
 * @param message - Error message
 * @param cause - Optional error cause
 * @returns Error response
 *
 * @example
 * ```typescript
 * return internalServerError("Database connection failed");
 * ```
 */
export function internalServerError(
  message: string = "Internal Server Error",
  cause?: unknown,
): Response {
  return createErrorResponse(message, HTTP_STATUS.INTERNAL_SERVER_ERROR, cause);
}

/**
 * Default error schema for OpenAPI
 */
const defaultErrorSchema = z.object({ error: z.string() });

/**
 * Default error schemas with throw helpers
 */
export const DEFAULT_ERROR_SCHEMAS: Record<number, ErrorSchemaDefinition> = {
  400: {
    name: "BadRequest",
    schema: defaultErrorSchema,
    throw: (...args: unknown[]) => {
      const [msg] = args as [string | string[] | undefined];
      const message = Array.isArray(msg)
        ? msg.join(", ")
        : msg ?? "Bad Request";
      throw badRequest(message);
    },
  },
  401: {
    name: "Unauthorized",
    schema: defaultErrorSchema,
    throw: () => {
      throw unauthorized();
    },
  },
  403: {
    name: "Forbidden",
    schema: defaultErrorSchema,
    throw: () => {
      throw forbidden();
    },
  },
  404: {
    name: "NotFound",
    schema: defaultErrorSchema,
    throw: () => {
      throw notFound();
    },
  },
  415: {
    name: "UnsupportedMediaType",
    schema: defaultErrorSchema,
    throw: () => {
      throw new Response(JSON.stringify({ error: "Unsupported Media Type" }), {
        status: HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
  500: {
    name: "InternalServerError",
    schema: defaultErrorSchema,
    throw: () => {
      throw internalServerError();
    },
  },
} as const satisfies Record<
  number,
  { name: string; schema: ZodTypeAny; throw: (...a: unknown[]) => never }
>;

/**
 * Create error response based on environment
 * @param error - Error object
 * @param isDevelopment - Whether in development mode
 * @returns Error response
 *
 * @example
 * ```typescript
 * catch (error) {
 *   return createErrorResponseByEnv(error, Deno.env.get("ENV") === "dev");
 * }
 * ```
 */
export function createErrorResponseByEnv(
  error: Error,
  isDevelopment: boolean,
): Response {
  const sanitized = sanitizeErrorMessage(error.message);

  const body = {
    error: sanitized,
    // Include stack trace only in development
    ...(isDevelopment && { stack: error.stack }),
  };

  return new Response(JSON.stringify(body), {
    status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    headers: {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
