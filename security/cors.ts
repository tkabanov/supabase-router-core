import type { CorsConfig } from "../core/types.ts";
import { sanitizeHeaderList } from "./sanitizer.ts";
import { DEFAULT_CORS_HEADERS } from "../core/constants.ts";

const isCorsConfig = (
  config: CorsConfig | Record<string, string>,
): config is CorsConfig => "allowedOrigins" in config;

const setHeaderList = (
  headers: Record<string, string>,
  name: string,
  values: string[] | undefined,
): void => {
  if (values) {
    headers[name] = sanitizeHeaderList(values);
  }
};

const resolveAllowedOrigin = (
  origin: string | null,
  config: CorsConfig,
): Record<string, string> => {
  if (config.allowedOrigins === "*") {
    return { "Access-Control-Allow-Origin": "*" };
  }

  // The response depends on the Origin header, so caches must key on it
  const headers: Record<string, string> = { "Vary": "Origin" };
  if (origin && config.allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    if (config.credentials) {
      headers["Access-Control-Allow-Credentials"] = "true";
    }
  }
  return headers;
};

/**
 * Throw if a CORS configuration is unsafe
 * @param config - CORS configuration
 * @throws Error if wildcard origin is combined with credentials
 */
export function assertValidCorsConfig(
  config: CorsConfig | Record<string, string> | undefined,
): void {
  if (
    config && isCorsConfig(config) && config.allowedOrigins === "*" &&
    config.credentials
  ) {
    throw new Error(
      "Cannot use wildcard origin (*) with credentials enabled. This is a security risk.",
    );
  }
}

/**
 * Build CORS headers based on configuration and origin
 * @param origin - Request origin header
 * @param config - CORS configuration
 * @returns CORS headers object. `Access-Control-Allow-Origin` is omitted when
 * the origin is not allowed.
 * @throws Error if wildcard used with credentials
 *
 * @example
 * ```typescript
 * const headers = buildCorsHeaders(
 *   "https://example.com",
 *   { allowedOrigins: ["https://example.com"], credentials: true }
 * );
 * ```
 */
export function buildCorsHeaders(
  origin: string | null,
  config: CorsConfig | Record<string, string>,
): Record<string, string> {
  // Plain header objects are used verbatim
  if (!isCorsConfig(config)) {
    return config;
  }

  assertValidCorsConfig(config);

  const headers = resolveAllowedOrigin(origin, config);
  setHeaderList(headers, "Access-Control-Allow-Methods", config.allowedMethods);
  setHeaderList(headers, "Access-Control-Allow-Headers", config.allowedHeaders);
  setHeaderList(
    headers,
    "Access-Control-Expose-Headers",
    config.exposedHeaders,
  );

  if (config.maxAge) {
    headers["Access-Control-Max-Age"] = String(config.maxAge);
  }

  return headers;
}

/**
 * Resolve the CORS headers for a request.
 *
 * - No config: permissive defaults (`*`) with the methods allowed on the path
 * - `CorsConfig`: origin allowlist; methods/headers default to the path's
 *   methods and the Supabase client headers when not configured
 * - Plain header object: used verbatim
 *
 * @param origin - Request origin header
 * @param config - Route or router CORS configuration
 * @param allowedMethods - Methods registered for the requested path
 * @returns CORS headers
 */
export function resolveCorsHeaders(
  origin: string | null,
  config: CorsConfig | Record<string, string> | undefined,
  allowedMethods: string[],
): Record<string, string> {
  const methodDefaults = {
    "Access-Control-Allow-Methods": allowedMethods.join(", "),
    "Access-Control-Allow-Headers":
      DEFAULT_CORS_HEADERS["Access-Control-Allow-Headers"],
  };

  if (!config) {
    return { ...DEFAULT_CORS_HEADERS, ...methodDefaults };
  }

  if (!isCorsConfig(config)) {
    return config;
  }

  return { ...methodDefaults, ...buildCorsHeaders(origin, config) };
}

/**
 * Get default CORS headers for a specific method
 * @param method - HTTP method
 * @param customCors - Optional custom CORS configuration
 * @returns CORS headers
 *
 * @example
 * ```typescript
 * const headers = getDefaultCorsHeaders("POST");
 * ```
 */
export function getDefaultCorsHeaders(
  method: string,
  customCors?: CorsConfig | Record<string, string>,
): Record<string, string> {
  if (customCors) {
    return buildCorsHeaders(null, customCors);
  }

  return {
    ...DEFAULT_CORS_HEADERS,
    "Access-Control-Allow-Methods": [method, "OPTIONS"].join(", "),
  };
}

/**
 * Merge multiple CORS configurations with proper precedence
 * @param configs - Array of CORS configurations (later ones override earlier)
 * @returns Merged CORS configuration
 *
 * @example
 * ```typescript
 * const merged = mergeCorsConfigs(
 *   { "Access-Control-Max-Age": "600" },
 *   { allowedOrigins: "*", allowedMethods: ["GET"] },
 * );
 * ```
 */
export function mergeCorsConfigs(
  ...configs: Array<CorsConfig | Record<string, string> | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const config of configs) {
    if (!config) continue;

    Object.assign(result, buildCorsHeaders(null, config));
  }

  return result;
}
