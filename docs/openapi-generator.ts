import type {
  CompiledRoute,
  OpenAPIOperation,
  OpenAPISchema,
  ServiceContainer,
} from "../core/types.ts";
import type { CompiledRoutesData } from "../routing/compiler.ts";
import {
  extractSchema,
  getGlobalSchemas,
} from "../validation/schema-extractor.ts";
import type { ZodTypeAny } from "npm:zod";
import { DEFAULT_SECURITY_SCHEMES } from "../core/constants.ts";

interface OpenAPIRequestMedia {
  schema: OpenAPISchema;
}

interface OpenAPIRequestBody {
  content: Record<string, OpenAPIRequestMedia>;
}

/**
 * OpenAPI specification interface
 */
export interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, OpenAPIOperation>>;
  components: {
    securitySchemes: Record<string, OpenAPISchema>;
    schemas: Record<string, OpenAPISchema>;
  };
}

interface SchemaObject {
  properties?: Record<string, unknown>;
  required?: string[];
}

/**
 * Generate OpenAPI paths from compiled routes
 * @template TContainer - Service container type (extends ServiceContainer)
 * @param data - Compiled routes data (array or optimized structure)
 * @returns OpenAPI paths object
 *
 * @example
 * ```typescript
 * const paths = generateOpenAPIPaths(compiledRoutes);
 * ```
 */
export function generateOpenAPIPaths<
  TRole = string,
  TUser = unknown,
  TContainer extends ServiceContainer = ServiceContainer,
>(
  data:
    // deno-lint-ignore no-explicit-any
    | Array<CompiledRoute<TRole, TUser, any, any, any, boolean, TContainer>>
    | CompiledRoutesData<TRole, TUser, TContainer>,
): Record<string, Record<string, OpenAPIOperation>> {
  const paths: Record<string, Record<string, OpenAPIOperation>> = {};
  const routes = Array.isArray(data) ? data : data.routes;
  // Routes are already properly typed above

  for (const route of routes) {
    // Convert :param to {param} for OpenAPI
    const key = route.fullPath.replace(/:(\w+)/g, "{$1}");
    const method = route.method.toLowerCase();

    // Initialize path if not exists
    paths[key] ??= {};

    // Build parameters
    const parameters: Array<Record<string, unknown>> = [];

    if (route.requestSchema?.query) {
      const querySchema = extractSchema(
        route.requestSchema.query,
        "Query",
      ) as SchemaObject;
      const props = querySchema.properties ?? {};
      const required = querySchema.required ?? [];

      for (const [name, def] of Object.entries(props)) {
        parameters.push({
          in: "query",
          name,
          required: required.includes(name),
          schema: def,
        });
      }
    }

    if (route.requestSchema?.params) {
      const paramsSchema = extractSchema(
        route.requestSchema.params,
        "Params",
      ) as SchemaObject;
      for (const [name, def] of Object.entries(paramsSchema.properties ?? {})) {
        parameters.push({
          in: "path",
          name,
          required: true,
          schema: def,
        });
      }
    }

    // Build request body
    let requestBody: OpenAPIRequestBody | undefined;
    if (route.requestSchema?.body) {
      const bodySchema = route.requestSchema.body;

      // Check if multi-content-type schema
      const isMultiContentType = typeof bodySchema === "object" &&
        !("safeParse" in bodySchema);

      if (isMultiContentType) {
        const contentTypeSchemas = bodySchema as Record<string, ZodTypeAny>;
        const multiContentRequestBody: OpenAPIRequestBody = { content: {} };

        for (
          const [contentType, schema] of Object.entries(contentTypeSchemas)
        ) {
          multiContentRequestBody.content[contentType] = {
            schema: extractSchema(schema, "RequestBody") ?? {},
          };
        }

        requestBody = multiContentRequestBody;
      } else {
        requestBody = {
          content: {
            "application/json": {
              schema: extractSchema(bodySchema as ZodTypeAny, "RequestBody") ??
                {},
            },
          },
        };
      }
    }

    // Build responses
    const successCode = route.successResponseCode ?? 200;
    const responses: Record<number, OpenAPISchema> = {
      [successCode]: route.responseSchema
        ? {
          description: route.successResponseDescription ?? "Success",
          content: {
            "application/json": {
              schema: extractSchema(route.responseSchema, "ResponseBody") ?? {},
            },
          },
        }
        : {
          description: route.successResponseDescription ?? "OK",
        },
    };

    // Add error schemas
    if (route.errorSchemas) {
      for (const [code, errorDef] of Object.entries(route.errorSchemas)) {
        const statusCode = Number(code);
        const schema = typeof errorDef === "object" && errorDef !== null &&
            "schema" in errorDef
          ? (errorDef as { schema: ZodTypeAny }).schema
          : errorDef;
        const errorName =
          typeof (errorDef as { name?: unknown }).name === "string"
            ? String((errorDef as { name?: unknown }).name)
            : `Error ${code}`;

        responses[statusCode] = {
          description: errorName,
          content: {
            "application/json": {
              schema: extractSchema(schema as ZodTypeAny, `Error${code}`) ?? {},
            },
          },
        };
      }
    }

    // Determine security requirements
    const security = route.security ??
      (route.authRequired === false ? undefined : [{ supabaseBearerAuth: [] }]);

    // Build operation object
    const operation: OpenAPIOperation = {
      summary: route.summary,
      description: route.description,
      tags: route.tags,
      ...(parameters.length > 0 && { parameters }),
      ...(requestBody && { requestBody }),
      responses,
      ...(security && { security }),
    };
    paths[key][method] = operation;
  }

  return paths;
}

/**
 * Extract unique tags from paths
 * @param paths - OpenAPI paths object
 * @returns Array of tag objects
 *
 * @example
 * ```typescript
 * const tags = extractTags(paths);
 * ```
 */
export function extractTags(
  paths: Record<string, Record<string, OpenAPIOperation>>,
): Array<{ name: string; description: string }> {
  const tagSet = new Set<string>();

  for (const methods of Object.values(paths)) {
    for (const operation of Object.values(methods)) {
      const tags = (operation as { tags?: unknown }).tags;
      if (Array.isArray(tags)) {
        tags.forEach((tag) => tagSet.add(String(tag)));
      }
    }
  }

  return Array.from(tagSet).map((tag) => ({
    name: tag,
    description: `${tag} endpoints`,
  }));
}

/**
 * Generate complete OpenAPI specification
 * @param routes - Compiled routes
 * @param config - OpenAPI configuration
 * @returns Complete OpenAPI spec
 *
 * @example
 * ```typescript
 * const spec = generateOpenAPISpec(routes, {
 *   title: "My API",
 *   version: "1.0.0",
 *   securitySchemes: {...}
 * });
 * ```
 */
export function generateOpenAPISpec<
  TRole = string,
  TUser = unknown,
  TContainer extends ServiceContainer = ServiceContainer,
>(
  data:
    // deno-lint-ignore no-explicit-any
    | Array<CompiledRoute<TRole, TUser, any, any, any, boolean, TContainer>>
    | CompiledRoutesData<TRole, TUser, TContainer>,
  config: {
    title?: string;
    version?: string;
    description?: string;
    servers?: Array<{ url: string; description?: string }>;
    securitySchemes?: Record<string, OpenAPISchema>;
  } = {},
): OpenAPISpec {
  const paths = generateOpenAPIPaths<TRole, TUser, TContainer>(data);

  const securitySchemes: Record<string, OpenAPISchema> = {
    ...DEFAULT_SECURITY_SCHEMES,
    ...(config.securitySchemes ?? {}),
  };

  return {
    openapi: "3.0.0",
    info: {
      title: config.title || "API",
      version: config.version || "1.0.0",
      ...(config.description && { description: config.description }),
    },
    ...(config.servers && { servers: config.servers }),
    tags: extractTags(paths),
    paths,
    components: {
      securitySchemes,
      schemas: getGlobalSchemas(),
    },
  };
}
