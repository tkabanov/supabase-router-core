import type { CorsConfig } from "../core/types.ts";
import { sanitizeHeaderList } from "./sanitizer.ts";
import { DEFAULT_CORS_HEADERS } from "../core/constants.ts";

/**
 * Build CORS headers based on configuration and origin
 * @param origin - Request origin header
 * @param config - CORS configuration
 * @returns CORS headers object
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
  const headers: Record<string, string> = {};

  // If config is plain object (legacy), return it
  if (!("allowedOrigins" in config)) {
    return config;
  }

  // Validate origin
  if (config.allowedOrigins === "*") {
    if (config.credentials) {
      throw new Error("Cannot use wildcard origin with credentials");
    }
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (origin && config.allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    if (config.credentials) {
      headers["Access-Control-Allow-Credentials"] = "true";
    }
  }

  // Sanitize and add allowed methods
  if (config.allowedMethods) {
    const methods = Array.isArray(config.allowedMethods)
      ? config.allowedMethods
      : [config.allowedMethods];
    headers["Access-Control-Allow-Methods"] = sanitizeHeaderList(methods);
  }

  // Sanitize and add allowed headers
  if (config.allowedHeaders) {
    const hdrs = Array.isArray(config.allowedHeaders)
      ? config.allowedHeaders
      : [config.allowedHeaders];
    headers["Access-Control-Allow-Headers"] = sanitizeHeaderList(hdrs);
  }

  // Sanitize and add exposed headers
  if (config.exposedHeaders) {
    const exposed = Array.isArray(config.exposedHeaders)
      ? config.exposedHeaders
      : [config.exposedHeaders];
    headers["Access-Control-Expose-Headers"] = sanitizeHeaderList(exposed);
  }

  // Add max age
  if (config.maxAge) {
    headers["Access-Control-Max-Age"] = String(config.maxAge);
  }

  return headers;
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
    if ("allowedOrigins" in customCors) {
      return buildCorsHeaders(null, customCors);
    }
    return customCors;
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
 * const merged = mergeCorsConfigs(globalCors, routeCors);
 * ```
 */
export function mergeCorsConfigs(
  ...configs: Array<CorsConfig | Record<string, string> | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const config of configs) {
    if (!config) continue;

    if ("allowedOrigins" in config) {
      Object.assign(result, buildCorsHeaders(null, config));
    } else {
      Object.assign(result, config);
    }
  }

  return result;
}
