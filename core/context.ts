/**
 * Request metadata interface
 */
export interface RequestMetadata {
  /** Request ID for tracing */
  requestId: string;
  /** HTTP method */
  method: string;
  /** Full request URL */
  url: string;
  /** URL path */
  pathname: string;
  /** URL query string (including `?`) */
  search: string;
  /** ISO timestamp when the metadata was created */
  timestamp: string;
  /** `User-Agent` header */
  userAgent: string | null;
  /** `Origin` header */
  origin: string | null;
}

/**
 * Generate a unique request ID for tracing
 * @returns UUID v4 string
 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Create request metadata for logging and tracing
 * @param req - Request object
 * @param requestId - Unique request identifier
 * @returns Request metadata object
 */
export function createRequestMetadata(
  req: Request,
  requestId: string,
): RequestMetadata {
  const url = new URL(req.url);

  return {
    requestId,
    method: req.method,
    url: req.url,
    pathname: url.pathname,
    search: url.search,
    timestamp: new Date().toISOString(),
    userAgent: req.headers.get("user-agent"),
    origin: req.headers.get("origin"),
  };
}
