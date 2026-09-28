import type { AuthOptions, AuthResult } from "../core/types.ts";
import { checkRoles } from "./rbac.ts";
import { forbidden, unauthorized } from "../errors/http-errors.ts";

/**
 * Generic authentication wrapper
 * This module provides utilities to work with custom authentication handlers
 */

const checkUserRole = <TRole>(
  user: unknown,
  allowedRoles: TRole[] | undefined,
): Response | undefined => {
  const userRole = (user as { role?: TRole } | undefined)?.role;

  if (userRole === undefined || userRole === null) {
    return forbidden("User role not found");
  }

  if (!allowedRoles || allowedRoles.length === 0) {
    return forbidden("No roles configured for this route");
  }

  return checkRoles(userRole, allowedRoles)
    ? undefined
    : forbidden("Insufficient permissions");
};

const validateWithoutUser = <TUser, TRole>(
  result: AuthResult<TUser, TRole>,
  options: AuthOptions<TRole>,
): AuthResult<TUser, TRole> => {
  // RBAC can never be satisfied without a user: fail closed
  if (options.requireRBAC) {
    return { response: unauthorized("User authentication required") };
  }

  if (options.requireUserAuth !== false && !result.anonBypassed) {
    return { response: unauthorized("User authentication required") };
  }

  return result;
};

/**
 * Validate authentication result and check RBAC.
 *
 * Fails closed: unless `requireUserAuth` is explicitly `false` (or the anon
 * key bypass was used), a result without a user is rejected. RBAC always
 * requires a user. Only the service role bypass skips these checks.
 *
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
  if (result.response || result.serviceBypassed) {
    return result;
  }

  if (!result.user) {
    return validateWithoutUser(result, options);
  }

  const denied = options.requireRBAC
    ? checkUserRole(result.user, options.allowedRoles)
    : undefined;

  return denied ? { response: denied } : result;
}

/**
 * Create an authentication handler that never authenticates anyone.
 * Routes using it get 401 unless they set `requireUserAuth: false`
 * (or `authRequired: false`); mainly useful in tests.
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
