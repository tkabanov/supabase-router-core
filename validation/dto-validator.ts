import type { TypeOf, ZodError, ZodTypeAny } from "zod";
import type { BodySchema } from "../core/types.ts";
import { DANGEROUS_QUERY_KEYS } from "../core/constants.ts";
import { parseFormDataSafely } from "../security/sanitizer.ts";

const DANGEROUS_KEYS = new Set<string>(DANGEROUS_QUERY_KEYS);

/**
 * Extract the media type from a Content-Type header
 * (`"Application/JSON; charset=utf-8"` -> `"application/json"`)
 */
const toMediaType = (contentType: string): string =>
  contentType.split(";")[0].trim().toLowerCase();

const jsonError = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Validation result
 */
export interface ValidationResult<T = unknown> {
  /** Whether validation passed */
  success: boolean;
  /** Validated (parsed) data when successful */
  data?: T;
  /** Validation errors when unsuccessful */
  errors?: Array<{
    path: string[];
    message: string;
  }>;
}

/**
 * Beautify Zod errors for API responses
 * @param error - Zod validation error
 * @returns Formatted error array
 *
 * @example
 * ```typescript
 * const { error } = schema.safeParse(data);
 * if (error) {
 *   const formatted = beautifyZodErrors(error);
 *   return badRequest("Validation failed", formatted);
 * }
 * ```
 */
export function beautifyZodErrors(error: ZodError): Array<{
  path: string[];
  message: string;
}> {
  return error.issues.map((err) => ({
    path: err.path.map(String),
    message: err.message,
  }));
}

/**
 * Validate data against Zod schema
 * @param data - Data to validate
 * @param schema - Zod schema
 * @returns Validation result
 *
 * @example
 * ```typescript
 * const result = validateDTO({ name: "John" }, userSchema);
 * if (result.success) {
 *   console.log(result.data);
 * }
 * ```
 */
export function validateDTO<TSchema extends ZodTypeAny>(
  data: unknown,
  schema: TSchema,
): ValidationResult<TypeOf<TSchema>> {
  // Preserve File objects during validation
  // Zod doesn't handle File/Blob well, so we extract them first
  const fileFields = extractFileFields(data);

  const result = schema.safeParse(data);

  if (result.success) {
    const validatedData = result.data as TypeOf<TSchema>;
    restoreFileFields(validatedData, fileFields);

    return {
      success: true,
      data: validatedData,
    };
  }

  return {
    success: false,
    errors: beautifyZodErrors(result.error),
  };
}

/**
 * Restore File objects that Zod may have cloned, but only for keys the schema
 * kept: fields stripped by the schema must stay stripped.
 */
function restoreFileFields(
  validatedData: unknown,
  fileFields: Map<string, File | Blob>,
): void {
  if (typeof validatedData !== "object" || validatedData === null) {
    return;
  }

  const target = validatedData as Record<string, unknown>;
  for (const [key, fileValue] of fileFields) {
    if (Object.hasOwn(target, key)) {
      target[key] = fileValue;
    }
  }
}

/**
 * Extract File and Blob fields from data before Zod validation
 * @param data - Data to extract from
 * @returns Map of field names to File/Blob objects
 */
function extractFileFields(data: unknown): Map<string, File | Blob> {
  const files = new Map<string, File | Blob>();

  if (typeof data === "object" && data !== null) {
    for (const [key, value] of Object.entries(data)) {
      if (value instanceof File || value instanceof Blob) {
        files.set(key, value);
      }
    }
  }

  return files;
}

const parseUrlEncoded = async (req: Request): Promise<unknown> => {
  const params = new URLSearchParams(await req.text());
  const result: Record<string, string> = Object.create(null);
  params.forEach((value, key) => {
    if (!DANGEROUS_KEYS.has(key)) {
      result[key] = value;
    }
  });
  return result;
};

const BODY_PARSERS: Record<string, (req: Request) => Promise<unknown>> = {
  "application/json": (req) => req.json(),
  "application/x-www-form-urlencoded": parseUrlEncoded,
  "multipart/form-data": async (req) =>
    parseFormDataSafely(await req.formData()),
  "text/plain": (req) => req.text(),
};

/**
 * Parse request body based on content type
 * @param req - Request object
 * @param mediaType - Media type (Content-Type without parameters)
 * @returns Parsed body
 */
async function parseBodyByMediaType(
  req: Request,
  mediaType: string,
): Promise<unknown> {
  const parser = BODY_PARSERS[mediaType];
  if (!parser) {
    throw jsonError(415, { error: "Unsupported Media Type" });
  }
  return await parser(req);
}

const resolveBodySchema = (
  bodySchema: BodySchema,
  mediaType: string,
  supportedContentTypes?: string[],
): ZodTypeAny | undefined => {
  // Multi-content-type schema: { "application/json": schema, ... }
  if (typeof bodySchema === "object" && !("safeParse" in bodySchema)) {
    const entry = Object.entries(bodySchema).find(([type]) =>
      toMediaType(type) === mediaType
    );
    return entry?.[1];
  }

  const supported = !supportedContentTypes?.length ||
    supportedContentTypes.some((type) => toMediaType(type) === mediaType);
  return supported ? bodySchema as ZodTypeAny : undefined;
};

/**
 * Parse and validate request body
 * @param req - Request object
 * @param bodySchema - Body schema definition (single schema or multi-content-type)
 * @param contentType - Content-Type header
 * @param supportedContentTypes - Optional list of supported content types
 * @returns Validated body data
 * @throws Response with validation errors (400) or unsupported media type (415)
 *
 * @example
 * ```typescript
 * const body = await parseAndValidateBody(
 *   req,
 *   { "application/json": jsonSchema },
 *   "application/json"
 * );
 * ```
 */
export async function parseAndValidateBody(
  req: Request,
  bodySchema: BodySchema,
  contentType: string,
  supportedContentTypes?: string[],
): Promise<unknown> {
  const mediaType = toMediaType(contentType);
  const schema = resolveBodySchema(
    bodySchema,
    mediaType,
    supportedContentTypes,
  );
  if (!schema) {
    throw jsonError(415, { error: "Unsupported Media Type" });
  }

  let rawBody: unknown;
  try {
    rawBody = await parseBodyByMediaType(req, mediaType);
  } catch (error) {
    if (error instanceof Response) throw error;
    throw jsonError(400, { error: "Malformed request body" });
  }

  const result = validateDTO(rawBody, schema);
  if (!result.success) {
    throw jsonError(400, {
      error: "Validation failed",
      details: result.errors,
    });
  }

  return result.data;
}
