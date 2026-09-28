import type {
  AnyCompiledRoute,
  BodySchema,
  ErrorSchemaDefinition,
  OpenAPIConfig,
  OpenAPIOperation,
  OpenAPISchema,
  ServiceContainer,
} from "../core/types.ts";
import type { CompiledRoutesData } from "../routing/compiler.ts";
import { extractSchema } from "../validation/schema-extractor.ts";
import type { ZodTypeAny } from "zod";
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
  /** OpenAPI version */
  openapi: string;
  /** Document metadata */
  info: {
    title: string;
    version: string;
    description?: string;
  };
  /** Server list */
  servers?: Array<{ url: string; description?: string }>;
  /** Tags used by operations */
  tags?: Array<{ name: string; description?: string }>;
  /** Operations by path and method */
  paths: Record<string, Record<string, OpenAPIOperation>>;
  /** Security schemes and shared schemas */
  components: {
    securitySchemes: Record<string, OpenAPISchema>;
    schemas: Record<string, OpenAPISchema>;
  };
}

interface SchemaObject {
  properties?: Record<string, OpenAPISchema>;
  required?: string[];
}

type Parameter = Record<string, unknown>;

const toObjectSchema = (schema: ZodTypeAny): SchemaObject =>
  (extractSchema(schema, "input") ?? {}) as SchemaObject;

const buildQueryParameters = (schema: ZodTypeAny | undefined): Parameter[] => {
  if (!schema) return [];
  const { properties = {}, required = [] } = toObjectSchema(schema);
  return Object.entries(properties).map(([name, def]) => ({
    in: "query",
    name,
    required: required.includes(name),
    schema: def,
  }));
};

const buildPathParameters = (route: AnyCompiledRoute): Parameter[] => {
  const properties = route.requestSchema?.params
    ? toObjectSchema(route.requestSchema.params).properties ?? {}
    : {};
  // Every path template variable must be declared, with or without a schema
  return route.params.map((name) => ({
    in: "path",
    name,
    required: true,
    schema: properties[name] ?? { type: "string" },
  }));
};

const isMultiContentBody = (
  body: BodySchema,
): body is Record<string, ZodTypeAny> =>
  typeof body === "object" && !("safeParse" in body);

const buildRequestBody = (
  body: BodySchema | undefined,
): OpenAPIRequestBody | undefined => {
  if (!body) return undefined;

  const schemas = isMultiContentBody(body)
    ? body
    : { "application/json": body };
  const content: Record<string, OpenAPIRequestMedia> = {};
  for (const [contentType, schema] of Object.entries(schemas)) {
    content[contentType] = { schema: extractSchema(schema, "input") ?? {} };
  }
  return { content };
};

const buildSuccessResponse = (route: AnyCompiledRoute): OpenAPISchema => {
  if (!route.responseSchema) {
    return { description: route.successResponseDescription ?? "OK" };
  }
  return {
    description: route.successResponseDescription ?? "Success",
    content: {
      "application/json": {
        schema: extractSchema(route.responseSchema, "output") ?? {},
      },
    },
  };
};

const buildResponses = (
  route: AnyCompiledRoute,
): Record<number, OpenAPISchema> => {
  const responses: Record<number, OpenAPISchema> = {
    [route.successResponseCode ?? 200]: buildSuccessResponse(route),
  };

  const errorSchemas: Record<number, ErrorSchemaDefinition> =
    route.errorSchemas ?? {};
  for (const [code, errorDef] of Object.entries(errorSchemas)) {
    responses[Number(code)] = {
      description: errorDef.name || `Error ${code}`,
      content: {
        "application/json": {
          schema: extractSchema(errorDef.schema, "output") ?? {},
        },
      },
    };
  }

  return responses;
};

const buildAuthSecurity = (
  route: AnyCompiledRoute,
): Array<Record<string, string[]>> => {
  const auth = route.authentication ?? {};
  if (auth.requireServiceRole) {
    return [{ supabaseSecretKey: [] }];
  }

  // Alternatives: any one of these is sufficient
  return [
    { supabaseBearerAuth: [] },
    ...(auth.bypassWithServiceRole ? [{ supabaseSecretKey: [] }] : []),
    ...(auth.bypassWithAnonRole ? [{ supabasePublishableKey: [] }] : []),
  ];
};

const buildSecurity = (
  route: AnyCompiledRoute,
): Array<Record<string, string[]>> | undefined => {
  if (route.security) return route.security;
  return route.authRequired === false ? undefined : buildAuthSecurity(route);
};

const buildOperation = (route: AnyCompiledRoute): OpenAPIOperation => {
  const parameters = [
    ...buildPathParameters(route),
    ...buildQueryParameters(route.requestSchema?.query),
  ];
  const requestBody = buildRequestBody(route.requestSchema?.body);
  const security = buildSecurity(route);

  return {
    summary: route.summary,
    description: route.description,
    tags: route.tags,
    ...(parameters.length > 0 && { parameters }),
    ...(requestBody && { requestBody }),
    responses: buildResponses(route),
    ...(security && { security }),
  };
};

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
    | Array<AnyCompiledRoute<TRole, TUser, TContainer>>
    | CompiledRoutesData<TRole, TUser, TContainer>,
): Record<string, Record<string, OpenAPIOperation>> {
  const paths: Record<string, Record<string, OpenAPIOperation>> = {};
  const routes = Array.isArray(data) ? data : data.routes;

  for (const route of routes) {
    // Convert :param to {param} for OpenAPI
    const key = route.fullPath.replace(/:(\w+)/g, "{$1}");
    paths[key] ??= {};
    paths[key][route.method.toLowerCase()] = buildOperation(route);
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
    | Array<AnyCompiledRoute<TRole, TUser, TContainer>>
    | CompiledRoutesData<TRole, TUser, TContainer>,
  config: OpenAPIConfig & {
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
      // Schemas are inlined per operation (see extractSchema)
      schemas: {},
    },
  };
}
