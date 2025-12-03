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

/**
 * Sanitize path parameter to prevent path traversal and ReDoS attacks
 * @param value - Raw path parameter value
 * @returns Sanitized parameter value
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
 * sanitizePathParam("../etc/passwd"); // throws Error
 * sanitizePathParam("a".repeat(300)); // throws Error (too long)
 * ```
 */
export function sanitizePathParam(value: string): string {
  // Check length FIRST to prevent ReDoS on long strings
  if (value.length > MAX_PATH_PARAM_LENGTH) {
    throw new Error(
      `Invalid path parameter: exceeds maximum length of ${MAX_PATH_PARAM_LENGTH} characters`,
    );
  }

  // Block encoded variants FIRST (before decoding)
  if (
    value.toLowerCase().includes("%2e%2e") ||
    value.toLowerCase().includes("%2f") || value.toLowerCase().includes("%5c")
  ) {
    throw new Error("Invalid path parameter: encoded traversal detected");
  }

  // Decode URL-encoding
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error("Invalid URL encoding in path parameter");
  }

  // Check decoded length as well (in case URL encoding inflated the size)
  if (decoded.length > MAX_PATH_PARAM_LENGTH) {
    throw new Error(
      `Invalid path parameter: decoded value exceeds maximum length of ${MAX_PATH_PARAM_LENGTH} characters`,
    );
  }

  // Block path traversal
  if (
    decoded.includes("..") || decoded.includes("/") || decoded.includes("\\")
  ) {
    throw new Error("Invalid path parameter: path traversal detected");
  }

  // Block null bytes
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
 * Sanitize error message to prevent XSS and information disclosure
 * @param message - Raw error message
 * @returns Sanitized error message
 *
 * @example
 * ```typescript
 * sanitizeErrorMessage("<script>alert('xss')</script>");
 * // "&lt;script&gt;alert('xss')&lt;/script&gt;"
 * ```
 */
export function sanitizeErrorMessage(message: unknown): string {
  if (typeof message !== "string") {
    return "Internal server error";
  }

  // Step 1: Unicode normalization (NFKC) to prevent bypass via Unicode variants
  // This converts look-alike characters to their canonical form
  // Example: \u006a\u0061vascript -> javascript
  let sanitized = message.normalize("NFKC");

  // Step 2: Remove control characters (0x00-0x1F, 0x7F-0x9F)
  // Prevents null bytes, newlines, and other control codes
  sanitized = stripControlCharacters(sanitized);

  // Step 3: Remove zero-width characters (used to hide content)
  // Includes: Zero Width Space, Zero Width Non-Joiner, Zero Width Joiner, etc.
  sanitized = sanitized.replace(/[\u200B-\u200D\uFEFF]/g, "");

  // Step 4: Remove dangerous protocols (after normalization)
  // Now that Unicode tricks are neutralized, simple replacement works
  sanitized = sanitized
    .replace(/javascript:/gi, "")
    .replace(/data:/gi, "")
    .replace(/vbscript:/gi, "")
    .replace(/file:/gi, "");

  // Step 5: HTML escape to prevent XSS
  const escaped = sanitized
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2F;");

  // Step 6: Limit length to prevent excessive logging
  return escaped.slice(0, MAX_ERROR_MESSAGE_LENGTH);
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
 * const data = await parseFormDataSafely(formData);
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
