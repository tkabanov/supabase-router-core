/**
 * Recommended security headers. They are NOT applied automatically: add them
 * to responses yourself, e.g. in a global middleware.
 *
 * Security coverage:
 * - Content Security Policy; the legacy XSS auditor is explicitly disabled
 * - Clickjacking prevention via X-Frame-Options
 * - MIME sniffing prevention via X-Content-Type-Options
 * - HTTPS enforcement via HSTS
 * - Privacy protection via Referrer-Policy
 * - Feature restrictions via Permissions-Policy
 */
export const DEFAULT_SECURITY_HEADERS = {
  /** Prevent MIME type sniffing */
  "X-Content-Type-Options": "nosniff",
  /** Prevent clickjacking */
  "X-Frame-Options": "DENY",
  /** Disable the legacy XSS auditor, which itself caused vulnerabilities (OWASP) */
  "X-XSS-Protection": "0",
  /** Enforce HTTPS with preload */
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  /** Content Security Policy - restrict resource loading */
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  /** Permissions Policy - restrict browser features */
  "Permissions-Policy":
    "geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), speaker=()",
  /** Referrer Policy - control referrer information */
  "Referrer-Policy": "strict-origin-when-cross-origin",
} as const;

/**
 * Default CORS headers for permissive configuration.
 *
 * Allow-Headers covers everything supabase-js sends: `x-retry-count` on
 * automatic retries (enabled by default) and the trace context headers when
 * `tracePropagation` is on.
 */
export const DEFAULT_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage",
  "Access-Control-Max-Age": "86400",
} as const;

/**
 * Dangerous query parameter keys that could lead to prototype pollution
 */
export const DANGEROUS_QUERY_KEYS = [
  "__proto__",
  "constructor",
  "prototype",
] as const;

/**
 * Maximum length for path parameters to prevent ReDoS attacks
 * Reasonable limit for IDs, slugs, and other path parameters
 */
export const MAX_PATH_PARAM_LENGTH = 200;

/**
 * Safe regex pattern for path parameters with length limit
 * Matches alphanumeric characters, hyphens, and underscores only
 *
 * Security: Length limit prevents ReDoS (Regular Expression Denial of Service)
 * attacks through catastrophic backtracking with malicious input.
 */
// Allow URL-encoded characters (%), single quotes, dots, and other safe chars in path parameters
// We allow dots because sanitizePathParam will check for path traversal (..)
// Single quotes are safe for path params and needed for SQL injection test scenarios
// Note: - (dash) must be at the end or escaped to avoid being interpreted as range
// Length limit {1,200} prevents ReDoS attacks
export const SAFE_PATH_PARAM_PATTERN: string =
  `([a-zA-Z0-9_%.='\\-]{1,${MAX_PATH_PARAM_LENGTH}})`;

/**
 * Regex for validating path parameter names
 * Must start with letter or underscore, followed by alphanumeric or underscore
 */
export const PATH_PARAM_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Maximum length for error messages to prevent excessive logging
 */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Maximum file size for multipart/form-data uploads (10MB)
 */
export const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Default OpenAPI security schemes
 */
export const DEFAULT_SECURITY_SCHEMES = {
  bearerAuth: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "`Bearer {token}`.",
  },
  supabaseBearerAuth: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "`Bearer {supabase_user_token}`. Supabase user access token.",
  },
  supabaseSecretKey: {
    type: "apiKey",
    in: "header",
    name: "apikey",
    description:
      "Supabase secret key (`sb_secret_...`). Server-to-server only; bypasses RLS.",
  },
  supabasePublishableKey: {
    type: "apiKey",
    in: "header",
    name: "apikey",
    description: "Supabase publishable key (`sb_publishable_...`).",
  },
  /** @deprecated Legacy service_role JWT; Supabase deprecates it by end of 2026 */
  supabaseServiceBearerAuth: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description:
      "Legacy: `Bearer {service_role_key}`. Deprecated by Supabase; use supabaseSecretKey.",
  },
  /** @deprecated Legacy anon JWT; Supabase deprecates it by end of 2026 */
  supabaseAnonBearerAuth: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description:
      "Legacy: `Bearer {anon_key}`. Deprecated by Supabase; use supabasePublishableKey.",
  },
} as const;

/**
 * Supported content types for request body parsing
 */
export const SUPPORTED_CONTENT_TYPES = [
  "application/json",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
] as const;

/**
 * HTTP status codes
 */
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE_ENTITY: 422,
  INTERNAL_SERVER_ERROR: 500,
} as const;
