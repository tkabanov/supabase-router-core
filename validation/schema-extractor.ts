import { toJSONSchema, type ZodTypeAny } from "zod";

/**
 * JSON schema object as emitted for OpenAPI
 */
export type JsonSchema = Record<string, unknown>;

/**
 * Whether a schema describes data sent by the client (`input`) or returned
 * by the server (`output`). This matters for transforms, coercion and defaults.
 */
export type SchemaDirection = "input" | "output";

/**
 * Convert a Zod schema into an inline OpenAPI 3.0 schema object.
 *
 * Schemas are always inlined, so different routes can never overwrite each
 * other's definitions and no dangling `$ref`s are produced.
 *
 * @param schema - Zod schema
 * @param direction - `input` for request schemas, `output` for responses
 * @returns JSON schema object, or undefined when no schema is given
 *
 * @example
 * ```typescript
 * const jsonSchema = extractSchema(userSchema, "input");
 * ```
 */
export function extractSchema(
  schema: ZodTypeAny | undefined,
  direction: SchemaDirection = "input",
): JsonSchema | undefined {
  if (!schema) return undefined;

  return toJSONSchema(schema, {
    target: "openapi-3.0",
    io: direction,
    // Files, dates etc. become `{}` instead of throwing during doc generation
    unrepresentable: "any",
  }) as JsonSchema;
}
