import type { CompiledRoute, ServiceContainer } from '../core/types.ts';
import type { CompiledRoutesData } from './compiler.ts';

/**
 * Find all routes that match a given pathname (for OPTIONS handling)
 * @param pathname - URL pathname
 * @param data - Compiled routes data (array or optimized structure)
 * @returns Array of matching routes
 * 
 * @example
 * ```typescript
 * const matches = findMatchingRoutes("/users/123", compiledRoutes);
 * const allowedMethods = matches.map(r => r.method);
 * ```
 */
export function findMatchingRoutes<
	TRole = string,
	TUser = unknown,
	TContainer extends ServiceContainer = ServiceContainer,
>(
	pathname: string,
	data:
		// deno-lint-ignore no-explicit-any
		| Array<CompiledRoute<TRole, TUser, any, any, any, boolean, TContainer>>
		| CompiledRoutesData<TRole, TUser, TContainer>,
	// deno-lint-ignore no-explicit-any
): Array<CompiledRoute<TRole, TUser, any, any, any, boolean, TContainer>> {
	const routes = Array.isArray(data) ? data : data.routes;
	return routes.filter((route) => route.regex.test(pathname));
}

/**
 * Extract allowed HTTP methods for a pathname
 * @param pathname - URL pathname
 * @param data - Compiled routes data (array or optimized structure)
 * @returns Array of allowed methods
 * 
 * @example
 * ```typescript
 * const methods = getAllowedMethods("/users/123", routes);
 * // ["GET", "PUT", "DELETE"]
 * ```
 */
export function getAllowedMethods<
	TRole = string,
	TUser = unknown,
	TContainer extends ServiceContainer = ServiceContainer,
>(
	pathname: string,
	data:
		// deno-lint-ignore no-explicit-any
		| Array<CompiledRoute<TRole, TUser, any, any, any, boolean, TContainer>>
		| CompiledRoutesData<TRole, TUser, TContainer>,
): string[] {
	const matches = findMatchingRoutes<TRole, TUser, TContainer>(pathname, data);
	const methods = new Set(matches.map((r) => r.method));

	// Always include OPTIONS if there are any matches
	if (methods.size > 0) {
		methods.add('OPTIONS');
	}

	return Array.from(methods);
}






