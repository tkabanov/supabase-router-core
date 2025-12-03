import { PATH_PARAM_NAME_REGEX } from "../core/constants.ts";

/**
 * Validate path parameter name
 * @param name - Parameter name to validate
 * @returns True if name is valid
 *
 * @example
 * ```typescript
 * isValidParamName("userId"); // true
 * isValidParamName("123invalid"); // false
 * isValidParamName("user-id"); // false
 * ```
 */
export function isValidParamName(name: string): boolean {
  return PATH_PARAM_NAME_REGEX.test(name);
}

/**
 * Validate path for dangerous patterns
 * @param path - Path to validate
 * @throws Error if path contains dangerous patterns
 *
 * @example
 * ```typescript
 * validatePathSafety("/users/:id"); // ok
 * validatePathSafety("/users/../admin"); // throws
 * ```
 */
export function validatePathSafety(path: string): void {
  // Check for path traversal
  if (path.includes("..")) {
    throw new Error("Path traversal attempt detected in route path");
  }

  // Check for encoded traversal
  if (path.toLowerCase().includes("%2e%2e")) {
    throw new Error("Encoded path traversal detected in route path");
  }

  // Check for null bytes
  if (path.includes("\0")) {
    throw new Error("Null byte detected in route path");
  }
}

/**
 * Extract and validate parameter names from path
 * @param path - Route path with parameters
 * @returns Array of parameter names
 * @throws Error if parameter names are invalid
 *
 * @example
 * ```typescript
 * extractParamNames("/users/:userId/posts/:postId");
 * // ["userId", "postId"]
 * ```
 */
export function extractParamNames(path: string): string[] {
  const params: string[] = [];
  const paramMatches = path.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);

  for (const match of paramMatches) {
    const paramName = match[1];

    if (!isValidParamName(paramName)) {
      throw new Error(`Invalid parameter name: ${paramName}`);
    }

    if (params.includes(paramName)) {
      throw new Error(`Duplicate parameter name: ${paramName}`);
    }

    params.push(paramName);
  }

  return params;
}
