import {
  DANGEROUS_QUERY_KEYS,
  DEFAULT_MAX_FILE_SIZE,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_PATH_PARAM_LENGTH,
} from "../core/constants.ts";

const DANGEROUS_QUERY_KEYS_SET = new Set<string>(DANGEROUS_QUERY_KEYS);

const stripControlCharacters = (value: string): string => {
  let result = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    const isControlCharacter = (code >= 0x00 && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f);
    if (!isControlCharacter) {
      result += char;
    }
  }
  return result;
};

const ENCODED_TRAVERSAL_PATTERN = /%2e%2e|%2f|%5c/i;

const assertParamLength = (value: string, label: string): void => {
  if (value.length > MAX_PATH_PARAM_LENGTH) {
    throw new Error(
      `Invalid path parameter: ${label} exceeds maximum length of ${MAX_PATH_PARAM_LENGTH} characters`,
    );
  }
};

const decodeParam = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("Invalid URL encoding in path parameter");
  }
};

/**
 * Sanitize a raw (still URL-encoded) path parameter and decode it exactly once.
 * @param value - Raw path parameter value as it appears in the URL
 * @returns Decoded, sanitized parameter value
 * @throws Error if parameter contains dangerous patterns or exceeds length limit
 *
 * Security protections:
 * - Length limit to prevent ReDoS attacks
 * - Path traversal detection (.., /, \)
 * - Null byte detection
 * - URL encoding validation
 *
 * @example
 * ```typescript
 * sanitizePathParam("123"); // "123"
 * sanitizePathParam("100%25"); // "100%"
 * sanitizePathParam("..%2Fetc"); // throws Error
 * sanitizePathParam("a".repeat(300)); // throws Error (too long)
 * ```
 */
export function sanitizePathParam(value: string): string {
  // Check length FIRST to prevent ReDoS on long strings
  assertParamLength(value, "value");

  // Block encoded variants before decoding
  if (ENCODED_TRAVERSAL_PATTERN.test(value)) {
    throw new Error("Invalid path parameter: encoded traversal detected");
  }

  const decoded = decodeParam(value);
  assertParamLength(decoded, "decoded value");

  if (/\.\.|[/\\]/.test(decoded)) {
    throw new Error("Invalid path parameter: path traversal detected");
  }

  if (decoded.includes("\0")) {
    throw new Error("Invalid path parameter: null byte detected");
  }

  return decoded;
}

/**
 * Safely parse query parameters to prevent prototype pollution
 * @param searchParams - URLSearchParams object
 * @returns Safe query object without prototype
 *
 * @example
 * ```typescript
 * const params = new URLSearchParams("page=1&limit=10");
 * const query = parseQuerySafely(params); // { page: "1", limit: "10" }
 * ```
 */
export function parseQuerySafely(
  searchParams: URLSearchParams,
): Record<string, string> {
  // Create object without prototype
  const query = Object.create(null);

  searchParams.forEach((value, key) => {
    // Skip if already exists (take first value only)
    if (key in query) {
      return;
    }

    // Block dangerous keys
    if (DANGEROUS_QUERY_KEYS_SET.has(key)) {
      return;
    }

    // Block bracket notation that could lead to pollution
    if (key.includes("[") || key.includes("]")) {
      return;
    }

    // Block keys starting with underscore (potential internal properties)
    if (key.startsWith("_")) {
      return;
    }

    query[key] = value;
  });

  return query;
}

/**
 * Sanitize an error message before it is returned to a client or logged.
 *
 * Messages are always serialized as JSON with `X-Content-Type-Options: nosniff`,
 * so HTML escaping is intentionally NOT applied here (it would corrupt
 * legitimate text such as `a/b` or `"quoted"`). Escape at render time instead.
 *
 * @param message - Raw error message
 * @returns Sanitized error message
 *
 * @example
 * ```typescript
 * sanitizeErrorMessage("bad\u0000input\r\nX-Evil: 1");
 * // "badinputX-Evil: 1"
 * ```
 */
export function sanitizeErrorMessage(message: unknown): string {
  if (typeof message !== "string") {
    return "Internal server error";
  }

  // Unicode normalization (NFKC) so look-alike characters collapse
  const normalized = message.normalize("NFKC");

  // Remove control characters (null bytes, CR/LF, ...) and zero-width characters
  const visible = stripControlCharacters(normalized)
    .replace(/[\u200B-\u200D\uFEFF]/g, "");

  // Limit length to prevent excessive payloads/logging
  return visible.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/**
 * Safely parse multipart/form-data to prevent duplicate keys and oversized files
 * @param formData - FormData object
 * @param maxFileSize - Maximum allowed file size in bytes
 * @returns Safe form data object
 * @throws Error if duplicate keys or oversized files detected
 *
 * @example
 * ```typescript
 * const formData = await req.formData();
 * const data = parseFormDataSafely(formData);
 * ```
 */
export function parseFormDataSafely(
  formData: FormData,
  maxFileSize: number = DEFAULT_MAX_FILE_SIZE,
): Record<string, unknown> {
  const result = Object.create(null);
  const seen = new Set<string>();

  // Use Array.from to convert to array, then iterate
  const entries = Array.from(formData.entries());

  for (const [key, value] of entries) {
    // Prevent duplicate keys
    if (seen.has(key)) {
      throw new Error(`Duplicate form field: ${key}`);
    }
    seen.add(key);

    // Block dangerous keys
    if (DANGEROUS_QUERY_KEYS_SET.has(key)) {
      continue;
    }

    // Handle Files
    if (value instanceof File) {
      if (value.size > maxFileSize) {
        throw new Error(
          `File too large: ${key} (${value.size} bytes, max ${maxFileSize})`,
        );
      }
      result[key] = value;
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Sanitize header value to prevent header injection
 * @param value - Raw header value
 * @returns Sanitized header value
 *
 * @example
 * ```typescript
 * sanitizeHeaderValue("application/json\r\nX-Evil: true");
 * // "application/json"
 * ```
 */
export function sanitizeHeaderValue(value: string): string {
  // Remove newlines and carriage returns
  return value.replace(/[\r\n]/g, "");
}

/**
 * Validate and sanitize header name
 * @param name - Header name
 * @returns True if header name is safe
 *
 * @example
 * ```typescript
 * isValidHeaderName("Content-Type"); // true
 * isValidHeaderName("Evil\r\nHeader"); // false
 * ```
 */
export function isValidHeaderName(name: string): boolean {
  // Only allow alphanumeric and hyphens
  return /^[a-zA-Z0-9-]+$/.test(name);
}

/**
 * Sanitize list of header names for CORS
 * @param headers - Array of header names
 * @returns Filtered and joined header list
 *
 * @example
 * ```typescript
 * sanitizeHeaderList(["Content-Type", "Evil\nHeader", "Authorization"]);
 * // "Content-Type, Authorization"
 * ```
 */
export function sanitizeHeaderList(headers: string[]): string {
  return headers
    .filter((h) => isValidHeaderName(h))
    .join(", ");
}
