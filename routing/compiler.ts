import type {
  AnyCompiledRoute,
  AnyRouteDef,
  ServiceContainer,
} from "../core/types.ts";
import { SAFE_PATH_PARAM_PATTERN } from "../core/constants.ts";
import { extractParamNames, validatePathSafety } from "./params-validator.ts";

/**
 * Compiled routes data structure with method-based indexing
 * Performance optimization: Group routes by HTTP method for O(1) method lookup
 */
export interface CompiledRoutesData<
  TRole = string,
  TUser = unknown,
  TContainer extends ServiceContainer = ServiceContainer,
> {
  /** All compiled routes (for backward compatibility) */
  routes: Array<
    AnyCompiledRoute<TRole, TUser, TContainer>
  >;
  /** Routes indexed by HTTP method for faster lookup */
  routesByMethod: Map<
    string,
    Array<AnyCompiledRoute<TRole, TUser, TContainer>>
  >;
}

/**
 * Compile a route path into a regex pattern
 * @param path - Route path with parameters (e.g., "/users/:id")
 * @returns Object with regex and parameter names
 * @throws Error if path contains dangerous patterns
 *
 * @example
 * ```typescript
 * const { regex, params } = compileRoute("/users/:id");
 * regex.test("/users/123"); // true
 * params; // ["id"]
 * ```
 */
export function compileRoute(path: string): {
  regex: RegExp;
  params: string[];
} {
  // Validate path safety
  validatePathSafety(path);

  // Extract parameter names
  const params = extractParamNames(path);

  // Build safe regex pattern
  // Replace :paramName with safe capture group
  const safePattern = path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, () => {
    return SAFE_PATH_PARAM_PATTERN;
  });

  // A trailing slash is optional: "/hello" and "/hello/" match the same route
  const trimmed = safePattern.length > 1 ? safePattern.replace(/\/$/, "") : "";
  const regex = new RegExp(`^${trimmed}/?$`);

  return { regex, params };
}

/** Compiled route with erased params/query/body generics */
export type AnyRoute<TRole, TUser, TContainer extends ServiceContainer> =
  AnyCompiledRoute<TRole, TUser, TContainer>;

/** Matched route and its path parameters */
export type RouteMatch<TRole, TUser, TContainer extends ServiceContainer> = {
  route: AnyRoute<TRole, TUser, TContainer>;
  params: Record<string, string>;
};

const candidateRoutes = <TRole, TUser, TContainer extends ServiceContainer>(
  method: string,
  data:
    | Array<AnyRoute<TRole, TUser, TContainer>>
    | CompiledRoutesData<TRole, TUser, TContainer>,
): Array<AnyRoute<TRole, TUser, TContainer>> => {
  if (Array.isArray(data)) {
    return data;
  }
  // OPTIONS must see every route to find the matching path
  return method === "OPTIONS"
    ? data.routes
    : data.routesByMethod.get(method) ?? [];
};

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Match a URL path against compiled routes and return RAW (still URL-encoded)
 * parameter values. Use this when parameters are decoded later, e.g. by
 * `sanitizePathParam`, to avoid decoding twice.
 *
 * @param method - HTTP method
 * @param pathname - URL pathname to match
 * @param data - Compiled routes data (can be legacy array or optimized structure)
 * @returns Matched route and raw parameters, or null
 */
export function matchRouteRaw<
  TRole = string,
  TUser = unknown,
  TContainer extends ServiceContainer = ServiceContainer,
>(
  method: string,
  pathname: string,
  data:
    | Array<AnyRoute<TRole, TUser, TContainer>>
    | CompiledRoutesData<TRole, TUser, TContainer>,
): RouteMatch<TRole, TUser, TContainer> | null {
  for (const route of candidateRoutes(method, data)) {
    // Skip if method doesn't match (but allow OPTIONS)
    if (route.method !== method && method !== "OPTIONS") {
      continue;
    }

    const match = route.regex.exec(pathname);
    if (!match) {
      continue;
    }

    const params: Record<string, string> = {};
    route.params.forEach((name, index) => {
      params[name] = match[index + 1];
    });

    return { route, params };
  }

  return null;
}

/**
 * Match a URL path against compiled routes with method-based optimization
 *
 * Performance: Uses method-based indexing for O(1) method lookup instead of O(n)
 *
 * @param method - HTTP method
 * @param pathname - URL pathname to match
 * @param data - Compiled routes data (can be legacy array or optimized structure)
 * @returns Matched route and extracted (decoded) parameters, or null
 *
 * @example
 * ```typescript
 * const match = matchRoute("GET", "/users/123", compiledRoutes);
 * if (match) {
 *   console.log(match.params); // { id: "123" }
 * }
 * ```
 */
export function matchRoute<
  TRole = string,
  TUser = unknown,
  TContainer extends ServiceContainer = ServiceContainer,
>(
  method: string,
  pathname: string,
  data:
    | Array<AnyRoute<TRole, TUser, TContainer>>
    | CompiledRoutesData<TRole, TUser, TContainer>,
): RouteMatch<TRole, TUser, TContainer> | null {
  const match = matchRouteRaw(method, pathname, data);
  if (!match) {
    return null;
  }

  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(match.params)) {
    params[name] = safeDecode(value);
  }
  return { route: match.route, params };
}

/**
 * Compare two paths so that static segments win over parameters
 * (`/users/me` is tried before `/users/:id`). Returns 0 for equally
 * specific paths so declaration order is preserved (sort is stable).
 */
const compareSpecificity = (a: string, b: string): number => {
  const segmentsA = a.split("/");
  const segmentsB = b.split("/");
  const length = Math.min(segmentsA.length, segmentsB.length);

  for (let i = 0; i < length; i++) {
    const paramA = segmentsA[i].startsWith(":");
    const paramB = segmentsB[i].startsWith(":");
    if (paramA !== paramB) {
      return paramA ? 1 : -1;
    }
  }
  return 0;
};

/**
 * Compile all routes in router configuration with method-based indexing
 *
 * Performance optimization: Groups routes by HTTP method for faster lookup
 * - Reduces route matching from O(n) to O(n/methods)
 * - For 100 routes with 5 methods: 20x faster method lookup
 *
 * @param basePath - Base path for all routes
 * @param routes - Route definitions
 * @returns Compiled routes data with method-based indexing
 *
 * @example
 * ```typescript
 * const compiled = compileRoutes("/api", routeDefs);
 * ```
 */
export function compileRoutes<
  TRole = string,
  TUser = unknown,
  TContainer extends ServiceContainer = ServiceContainer,
>(
  basePath: string,
  routes: Array<AnyRouteDef<TRole, TUser, TContainer>>,
): CompiledRoutesData<TRole, TUser, TContainer> {
  const compiledRoutes = routes.map((route) => {
    const fullPath = basePath.replace(/\/$/, "") + route.fullPath;
    const { regex, params } = compileRoute(fullPath);

    return {
      ...route,
      fullPath,
      regex,
      params,
    } as AnyCompiledRoute<TRole, TUser, TContainer>;
  }).sort((a, b) => compareSpecificity(a.fullPath, b.fullPath));

  // Build method-based index for O(1) method lookup
  const routesByMethod = new Map<
    string,
    Array<AnyCompiledRoute<TRole, TUser, TContainer>>
  >();

  for (const route of compiledRoutes) {
    const method = route.method;
    if (!routesByMethod.has(method)) {
      routesByMethod.set(method, []);
    }
    routesByMethod.get(method)!.push(route);
  }

  return {
    routes: compiledRoutes,
    routesByMethod,
  };
}
