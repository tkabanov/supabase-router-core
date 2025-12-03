import { zodToJsonSchema } from "npm:zod-to-json-schema@3.23.5";
import type { ZodTypeAny } from "npm:zod";

/**
 * Global schemas cache for OpenAPI generation
 */
type JsonSchema = Record<string, unknown>;

const globalSchemas: Record<string, JsonSchema> = {};

/**
 * Extract JSON schema from Zod schema for OpenAPI
 * @param schema - Zod schema
 * @param name - Schema name
 * @returns JSON schema object
 *
 * @example
 * ```typescript
 * const jsonSchema = extractSchema(userSchema, "User");
 * ```
 */
export function extractSchema(
  schema: ZodTypeAny | undefined,
  name: string,
): JsonSchema | undefined {
  if (!schema) return undefined;

  const raw = zodToJsonSchema(schema, { name }) as {
    definitions?: Record<string, JsonSchema>;
  } & JsonSchema;

  // Store definitions in global cache
  if (raw.definitions) {
    Object.assign(globalSchemas, raw.definitions);
  }

  return raw.definitions?.[name] ?? raw;
}

/**
 * Get all cached schemas
 * @returns Global schemas object
 *
 * @example
 * ```typescript
 * const schemas = getGlobalSchemas();
 * ```
 */
export function getGlobalSchemas(): Record<string, JsonSchema> {
  return globalSchemas;
}

/**
 * Clear schema cache (useful for testing)
 *
 * @example
 * ```typescript
 * clearSchemaCache();
 * ```
 */
export function clearSchemaCache(): void {
  Object.keys(globalSchemas).forEach((key) => delete globalSchemas[key]);
}
