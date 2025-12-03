/**
 * Request metadata interface
 */
export interface RequestMetadata {
  requestId: string;
  method: string;
  url: string;
  pathname: string;
  search: string;
  timestamp: string;
  userAgent: string | null;
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
