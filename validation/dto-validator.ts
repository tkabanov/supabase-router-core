import type { TypeOf, ZodError, ZodTypeAny } from "npm:zod";
import type { BodySchema } from "../core/types.ts";
import { parseFormDataSafely } from "../security/sanitizer.ts";

/**
 * Validation result
 */
export interface ValidationResult<T = unknown> {
  success: boolean;
  data?: T;
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
 *   return jsonResponse({ errors: formatted }, 400);
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
    // Restore File objects that may have been lost during Zod parsing
    const validatedData = result.data as TypeOf<TSchema>;
    if (
      fileFields.size > 0 && typeof validatedData === "object" &&
      validatedData !== null
    ) {
      for (const [key, fileValue] of fileFields) {
        (validatedData as Record<string, unknown>)[key] = fileValue;
      }
    }

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

/**
 * Parse request body based on content type
 * @param req - Request object
 * @param contentType - Content-Type header value
 * @returns Parsed body
 *
 * @example
 * ```typescript
 * const body = await parseBodyByContentType(req, "application/json");
 * ```
 */
async function parseBodyByContentType(
  req: Request,
  contentType: string,
): Promise<unknown> {
  if (contentType.includes("application/json")) {
    return await req.json();
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    const params = new URLSearchParams(text);
    const result: Record<string, string> = {};
    params.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    return await parseFormDataSafely(formData);
  }

  if (contentType.includes("text/plain")) {
    return await req.text();
  }

  throw new Error(`Unsupported content type: ${contentType}`);
}

/**
 * Parse and validate request body
 * @param req - Request object
 * @param bodySchema - Body schema definition (single schema or multi-content-type)
 * @param contentType - Content-Type header
 * @param supportedContentTypes - Optional list of supported content types
 * @returns Validated body data
 * @throws Response with validation errors
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
  // Check if schema is multi-content-type
  if (typeof bodySchema === "object" && !("safeParse" in bodySchema)) {
    const contentTypeSchemas = bodySchema as Record<string, ZodTypeAny>;

    // Find matching content type
    for (
      const [supportedType, typeSchema] of Object.entries(contentTypeSchemas)
    ) {
      if (contentType.includes(supportedType)) {
        const rawBody = await parseBodyByContentType(req, contentType);
        const result = validateDTO(rawBody, typeSchema);

        if (!result.success) {
          throw new Response(
            JSON.stringify({
              error: "Validation failed",
              details: result.errors,
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        return result.data;
      }
    }

    // No matching content type found
    throw new Response(
      JSON.stringify({ error: "Unsupported Media Type" }),
      {
        status: 415,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Single schema - validate supported content types
  if (supportedContentTypes && supportedContentTypes.length > 0) {
    const isSupported = supportedContentTypes.some((supportedType) =>
      contentType.includes(supportedType)
    );

    if (!isSupported) {
      throw new Response(
        JSON.stringify({ error: "Unsupported Media Type" }),
        {
          status: 415,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  // Parse and validate
  const rawBody = await parseBodyByContentType(req, contentType);
  const result = validateDTO(rawBody, bodySchema as ZodTypeAny);

  if (!result.success) {
    throw new Response(
      JSON.stringify({ error: "Validation failed", details: result.errors }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  return result.data;
}
