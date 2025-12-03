/**
 * Generic role-based access control utilities
 */

/**
 * Check if user role is allowed
 * @param userRole - User's current role
 * @param allowedRoles - Array of allowed roles
 * @returns True if role is allowed
 *
 * @example
 * ```typescript
 * enum Roles { ADMIN = 'admin', USER = 'user' }
 * checkRoles(Roles.ADMIN, [Roles.ADMIN, Roles.USER]); // true
 * checkRoles(Roles.GUEST, [Roles.ADMIN]); // false
 * ```
 */
export function checkRoles<TRole>(
  userRole: TRole,
  allowedRoles: TRole[],
): boolean {
  if (allowedRoles.length === 0) {
    return false;
  }

  return allowedRoles.includes(userRole);
}

/**
 * Check if user has any of the required roles
 * @param userRoles - User's roles (array)
 * @param requiredRoles - Array of required roles (any match is sufficient)
 * @returns True if user has at least one required role
 *
 * @example
 * ```typescript
 * hasAnyRole(
 *   [Roles.USER, Roles.MODERATOR],
 *   [Roles.ADMIN, Roles.MODERATOR]
 * ); // true (has MODERATOR)
 * ```
 */
export function hasAnyRole<TRole>(
  userRoles: TRole[],
  requiredRoles: TRole[],
): boolean {
  return requiredRoles.some((role) => userRoles.includes(role));
}

/**
 * Check if user has all of the required roles
 * @param userRoles - User's roles (array)
 * @param requiredRoles - Array of required roles (all must match)
 * @returns True if user has all required roles
 *
 * @example
 * ```typescript
 * hasAllRoles(
 *   [Roles.USER, Roles.PREMIUM, Roles.VERIFIED],
 *   [Roles.USER, Roles.PREMIUM]
 * ); // true
 * ```
 */
export function hasAllRoles<TRole>(
  userRoles: TRole[],
  requiredRoles: TRole[],
): boolean {
  return requiredRoles.every((role) => userRoles.includes(role));
}

/**
 * Create a role hierarchy checker
 * @param hierarchy - Role hierarchy map (role -> array of implied roles)
 * @returns Function to check if user role satisfies required role
 *
 * @example
 * ```typescript
 * enum Roles { ADMIN = 'admin', MOD = 'mod', USER = 'user' }
 *
 * const checkRole = createRoleHierarchy({
 *   [Roles.ADMIN]: [Roles.MOD, Roles.USER],
 *   [Roles.MOD]: [Roles.USER],
 *   [Roles.USER]: []
 * });
 *
 * checkRole(Roles.ADMIN, Roles.USER); // true (admin implies user)
 * checkRole(Roles.USER, Roles.ADMIN); // false
 * ```
 */
export function createRoleHierarchy<TRole>(
  hierarchy: Record<string, TRole[]>,
): (userRole: TRole, requiredRole: TRole) => boolean {
  return (userRole: TRole, requiredRole: TRole): boolean => {
    // Direct match
    if (userRole === requiredRole) {
      return true;
    }

    // Check if userRole implies requiredRole
    const impliedRoles = hierarchy[String(userRole)] || [];
    return impliedRoles.includes(requiredRole);
  };
}
