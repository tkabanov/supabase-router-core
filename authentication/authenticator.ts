import type { AuthOptions, AuthResult } from "../core/types.ts";
import { checkRoles } from "./rbac.ts";
import { forbidden, unauthorized } from "../errors/http-errors.ts";

/**
 * Generic authentication wrapper
 * This module provides utilities to work with custom authentication handlers
 */

/**
 * Validate authentication result and check RBAC
 * @param result - Authentication result
 * @param options - Auth options with RBAC settings
 * @returns Validated auth result or error response
 *
 * @example
 * ```typescript
 * const result = await customAuthHandler(req, options);
 * const validated = validateAuthResult(result, options);
 * if (validated.response) {
 *   return validated.response; // Error
 * }
 * // Use validated.user, validated.supabaseClient
 * ```
 */
export function validateAuthResult<TUser = unknown, TRole = string>(
  result: AuthResult<TUser, TRole>,
  options: AuthOptions<TRole>,
): AuthResult<TUser, TRole> {
  // If auth already failed, return the error
  if (result.response) {
    return result;
  }

  // If service role bypassed, skip user validation
  if (result.serviceBypassed) {
    return result;
  }

  // If user auth is required but no user
  if (options.requireUserAuth && !result.user) {
    return { response: unauthorized("User authentication required") };
  }

  // Check RBAC if enabled
  if (options.requireRBAC && result.user) {
    const userRole = (result.user as { role?: TRole } | undefined)?.role;

    if (userRole === undefined || userRole === null) {
      return { response: forbidden("User role not found") };
    }

    if (!options.allowedRoles || options.allowedRoles.length === 0) {
      return { response: forbidden("No roles configured for this route") };
    }

    if (!checkRoles(userRole, options.allowedRoles)) {
      return { response: forbidden("Insufficient permissions") };
    }
  }

  return result;
}

/**
 * Create a default authentication handler that returns unauthenticated
 * Useful for public routes or when authentication is optional
 *
 * @example
 * ```typescript
 * const publicAuthHandler = createNoAuthHandler();
 * ```
 */
export function createNoAuthHandler<TUser = unknown, TRole = string>(): (
  req: Request,
  options: AuthOptions<TRole>,
) => Promise<AuthResult<TUser, TRole>> {
  return (
    _req: Request,
    _options: AuthOptions<TRole>,
  ): Promise<AuthResult<TUser, TRole>> => {
    return Promise.resolve({}); // No auth, no error
  };
}
