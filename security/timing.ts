const encoder = new TextEncoder();

/**
 * Compare two secrets in time that does not depend on where they differ.
 * @param a - First value
 * @param b - Second value
 * @returns True if both strings are identical
 *
 * @example
 * ```typescript
 * timingSafeEqual(token, serviceKey);
 * ```
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);

  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }

  return diff === 0;
}
