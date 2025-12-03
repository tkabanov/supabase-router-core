import type {
  AuthHandler,
  AuthResult,
  ErrorSchemaDefinition,
  OpenAPISchema,
  RouteContext,
  RouteDef,
  RouteDefinitionInput,
  RouteParamsOf,
  RouteQueryOf,
  RouteBodyOf,
  RouteSchemaDefinition,
  Middleware,
  Router,
  RouterConfig,
  RouterDatabaseConfig,
  TransactionDbClient,
} from "./core/types.ts";
import { compileRoutes, matchRoute } from "./routing/compiler.ts";
import { getAllowedMethods } from "./routing/matcher.ts";
import { generateOpenAPISpec } from "./docs/openapi-generator.ts";
import {
  parseQuerySafely,
  sanitizeErrorMessage,
  sanitizePathParam,
} from "./security/sanitizer.ts";
import { buildCorsHeaders, mergeCorsConfigs } from "./security/cors.ts";
import { composeMiddlewares } from "./middleware/composer.ts";
import { parseAndValidateBody } from "./validation/dto-validator.ts";
import { DEFAULT_ERROR_SCHEMAS } from "./errors/http-errors.ts";
import { validateAuthResult } from "./authentication/authenticator.ts";
import { getOrCreateDefaultAuthHandler } from "./authentication/default-auth.ts";
import { createContainer, type ServiceContainer } from "./core/container.ts";
import { drizzle } from "npm:drizzle-orm/postgres-js";
import postgres from "npm:postgres";

/**
 * Define a route with type inference
 * @param def - Route definition
 * @returns Route definition
 *
 * @example
 * ```typescript
 * const route = defineRoute({
 *   method: 'POST',
 *   path: '/users',
 *   summary: 'Create user',
 *   authRequired: true,
 *   requestSchema: { body: userSchema },
 *   handler: async ({ body, user }) => {
 *     // Handler logic
 *   }
 * });
 * ```
 */
export function defineRoute<
  TRole = string,
  TUser = unknown,
  TSchema extends RouteSchemaDefinition | undefined = undefined,
  TAuth extends boolean = true,
  TContainer extends ServiceContainer = ServiceContainer,
>(
  // TParams, TQuery, TBody are inferred automatically from TSchema
  // deno-lint-ignore no-explicit-any
  def: RouteDefinitionInput<TRole, TUser, TSchema, TAuth, any, any, any, TContainer>,
): RouteDef<
  TRole,
  TUser,
  RouteParamsOf<TSchema>,
  RouteQueryOf<TSchema>,
  RouteBodyOf<TSchema>,
  TAuth,
  TContainer
> {
  // Security warning: requireServiceRole should never be called from frontend
  if (def.authentication?.requireServiceRole) {
    console.warn(
      `⚠️  SECURITY WARNING: Route "${def.method} ${def.path}" uses requireServiceRole.\n` +
        `   This endpoint requires SUPABASE_SERVICE_ROLE_KEY and should NEVER be called from frontend code.\n` +
        `   Service role key bypasses Row Level Security (RLS) and has full database access.\n` +
        `   Only use this for internal/admin operations or server-to-server communication.\n` +
        `   Frontend should use user authentication (requireUserAuth) instead.`,
    );
  }

  return {
    ...def,
    fullPath: def.path,
  } as RouteDef<
    TRole,
    TUser,
    RouteParamsOf<TSchema>,
    RouteQueryOf<TSchema>,
    RouteBodyOf<TSchema>,
    TAuth,
    TContainer
  >;
}

const DEFAULT_DB_CONNECTION_ENV = "SUPABASE_DB_POOLER_URL";
const DEFAULT_DB_MAX_CONNECTIONS = 5;
const DEFAULT_DB_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 10_000;
const DEFAULT_DB_CONNECTION_TIMEOUT_MS = 5_000;

const toSeconds = (ms: number): number => {
  return Math.max(1, Math.floor(ms / 1000));
};

const ensureTransactionPoolerClient = (
  container: ServiceContainer,
  databaseConfig?: RouterDatabaseConfig,
) => {
  if (!databaseConfig?.enableTransactionPooler) {
    return;
  }

  if (typeof container.getOrCreateDbClient === "function") {
    return;
  }

  const {
    connectionStringEnv = DEFAULT_DB_CONNECTION_ENV,
    maxConnections = DEFAULT_DB_MAX_CONNECTIONS,
    idleTimeoutMs = DEFAULT_DB_IDLE_TIMEOUT_MS,
    statementTimeoutMs = DEFAULT_DB_STATEMENT_TIMEOUT_MS,
    connectionTimeoutMs = DEFAULT_DB_CONNECTION_TIMEOUT_MS,
    disablePreparedStatements = true,
    drizzleConfig,
  } = databaseConfig;

  let cachedDb: TransactionDbClient | null = null;
  let sqlClient: ReturnType<typeof postgres> | null = null;
  let cleanupRegistered = false;
  let statementConfigured = false;

  container.getOrCreateDbClient = () => {
    if (cachedDb) {
      return cachedDb;
    }

    const connectionString = container.env.get(connectionStringEnv);
    if (!connectionString) {
      throw new Error(
        `Transaction pooler enabled but ${connectionStringEnv} is not set`,
      );
    }

    sqlClient = postgres(connectionString, {
      max: maxConnections,
      idle_timeout: toSeconds(idleTimeoutMs),
      connect_timeout: toSeconds(connectionTimeoutMs),
      prepare: !(disablePreparedStatements ?? true),
    });

    if (!statementConfigured && statementTimeoutMs > 0) {
      statementConfigured = true;
      sqlClient`set statement_timeout = ${statementTimeoutMs}`.catch(
        (error: unknown) => {
          container.logger.warn(
            "Failed to set statement_timeout on transaction pooler connection",
            error,
          );
        },
      );
    }

    cachedDb = drizzleConfig
      ? drizzle(sqlClient, drizzleConfig)
      : drizzle(sqlClient);

    if (!cleanupRegistered && typeof addEventListener === "function") {
      cleanupRegistered = true;
      addEventListener("unload", () => {
        if (!sqlClient) {
          return;
        }

        sqlClient.end().catch((error: unknown) => {
          container.logger.warn(
            "Failed to close transaction pooler connection on shutdown",
            error,
          );
        });
      });
    }

    return cachedDb;
  };
};

/**
 * Define a router with routes and configuration
 * @param config - Router configuration
 * @returns Router instance
 *
 * @example
 * ```typescript
 * // With default ServiceContainer
 * const router = defineRouter({
 *   basePath: '/api',
 *   defaultTags: ['API'],
 *   routes: [...]
 * });
 *
 * // With custom services container - specify type as third generic parameter
 * interface MyServices extends ServiceContainer {
 *   emailService: EmailService;
 * }
 *
 * const router = defineRouter<MyRoles, MyUser, MyServices>({
 *   basePath: '/api',
 *   container: myServicesContainer,
 *   routes: [
 *     defineRoute({
 *       handler: async ({ services }) => {
 *         // ✅ services.emailService is now fully typed!
 *         await services.emailService.sendEmail(...);
 *       }
 *     })
 *   ]
 * });
 *
 * Deno.serve(router.handler);
 * ```
 */
export function defineRouter<
  TRole = string,
  TUser = unknown,
  TContainer extends ServiceContainer = ServiceContainer,
>(
  config: RouterConfig<TRole, TUser, TContainer>,
): Router {

  const composeTyped = composeMiddlewares as <TContextUser, TContextContainer extends ServiceContainer>(
    middlewares: Middleware<TContextUser, TContextContainer>[],
  ) => Middleware<TContextUser, TContextContainer>;
  // Create service container with defaults + user overrides
  // TContainer is automatically inferred from config.container if provided
  const container = createContainer(
    config.container as Partial<TContainer>,
  ) as TContainer;
  ensureTransactionPoolerClient(container, config.database);
  const databaseEnabled = typeof container.getOrCreateDbClient === "function";

  // Validate CORS configuration
  if (config.corsHeaders && "allowedOrigins" in config.corsHeaders) {
    if (
      config.corsHeaders.allowedOrigins === "*" &&
      config.corsHeaders.credentials
    ) {
      throw new Error(
        "Cannot use wildcard origin (*) with credentials enabled. This is a security risk.",
      );
    }
  }

  // Initialize auth handler - use provided or create default
  let authHandlerPromise: Promise<AuthHandler<TRole, TUser>> | null = null;
  const getAuthHandler = async (): Promise<AuthHandler<TRole, TUser>> => {
    if (!authHandlerPromise) {
      authHandlerPromise = config.authHandler
        ? Promise.resolve(config.authHandler)
        : getOrCreateDefaultAuthHandler<TUser, TRole>(container);
    }
    return await authHandlerPromise;
  };

  // Compile all routes
  const compiledRoutes = compileRoutes<TRole, TUser, TContainer>(
    config.basePath,
    // deno-lint-ignore no-explicit-any
    config.routes.map((route: RouteDef<TRole, TUser, any, any, any, boolean, TContainer>) => {
      const fullPath = typeof route.path === "string"
        ? route.path
        : route.fullPath;
      if (route.useDatabase && !databaseEnabled) {
        throw new Error(
          `Route "${fullPath}" requires database access but transaction pooler support is not configured.`,
        );
      }
      return {
        ...route,
        tags: [...(config.defaultTags ?? []), ...(route.tags ?? [])],
        fullPath,
        // Merge error schemas
        errorSchemas: {
          ...(route.includeDefaultErrors !== false
            ? DEFAULT_ERROR_SCHEMAS
            : {}),
          ...(route.errorSchemas ?? {}),
        },
        // Set defaults
        authRequired: route.authRequired ?? true,
        includeDefaultErrors: route.includeDefaultErrors ?? true,
        supportedContentTypes: route.supportedContentTypes ??
          ["application/json"],
      };
    }),
  );

  // Main request handler
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // Find matching route
    const matchResult = matchRoute<TRole, TUser, TContainer>(
      req.method,
      url.pathname,
      compiledRoutes,
    );

    // Get all routes that match this path (for CORS)
    const allowedMethods = getAllowedMethods<TRole, TUser, TContainer>(
      url.pathname,
      compiledRoutes,
    );
    const defaultCors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": allowedMethods.join(", "),
      "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type",
      "Access-Control-Max-Age": "86400",
    };

    // Handle OPTIONS (CORS preflight)
    if (req.method === "OPTIONS") {
      if (allowedMethods.length === 0) {
        return new Response(JSON.stringify({ error: "Not Found" }), {
          status: 404,
          headers: defaultCors,
        });
      }

      const corsHeaders = matchResult?.route.corsHeaders
        ? buildCorsHeaders(
          req.headers.get("origin"),
          matchResult.route.corsHeaders,
        )
        : defaultCors;

      return new Response(null, {
        status: 204,
        headers: mergeCorsConfigs(defaultCors, corsHeaders),
      });
    }

    // No matching route found
    if (!matchResult) {
      return new Response(JSON.stringify({ error: "Not Found" }), {
        status: 404,
        headers: defaultCors,
      });
    }

    const { route, params } = matchResult;
    const corsHeaders = route.corsHeaders
      ? buildCorsHeaders(req.headers.get("origin"), route.corsHeaders)
      : defaultCors;

    // Generate request ID using container
    const requestId = container.idGenerator.generate();

    // Sanitize path parameters
    const sanitizedParams: Record<string, string> = {};
    try {
      for (const [key, value] of Object.entries(params)) {
        sanitizedParams[key] = sanitizePathParam(value);
      }
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: sanitizeErrorMessage(
            error instanceof Error ? error.message : "Invalid path parameter",
          ),
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Parse query parameters safely
    const query = parseQuerySafely(url.searchParams);
    let validatedQuery: Record<string, unknown> = { ...query };
    if (!route.disableDTOValidation && route.requestSchema?.query) {
      try {
        const parsed = route.requestSchema.query.parse(query) as Record<
          string,
          unknown
        >;
        // Recreate with null prototype to prevent prototype pollution
        const safe = Object.create(null) as Record<string, unknown>;
        for (const key of Object.keys(parsed)) {
          safe[key] = parsed[key];
        }
        validatedQuery = safe;
      } catch (error) {
        return new Response(
          JSON.stringify({ error: "Query validation failed", details: error }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // Validate params schema
    if (!route.disableDTOValidation && route.requestSchema?.params) {
      try {
        route.requestSchema.params.parse(sanitizedParams);
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: "Path parameter validation failed",
            details: error,
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // Parse and validate body
    let body: unknown;
    const contentType = req.headers.get("content-type") ?? "application/json";

    if (route.requestSchema?.body && !route.disableDTOValidation) {
      try {
        body = await parseAndValidateBody(
          req,
          route.requestSchema.body,
          contentType,
          route.supportedContentTypes,
        );
      } catch (error) {
        if (error instanceof Response) {
          // Add CORS headers to error response
          for (const [key, value] of Object.entries(corsHeaders)) {
            error.headers.set(key, value);
          }
          return error;
        }

        return new Response(
          JSON.stringify({ error: "Body validation failed" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    let dbClient: TransactionDbClient | undefined;
    if (route.useDatabase) {
      if (typeof container.getOrCreateDbClient !== "function") {
        return new Response(
          JSON.stringify({
            error: "Database configuration error",
            message:
              "Route requires database access but no transaction pooler client is configured.",
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      try {
        dbClient = container.getOrCreateDbClient();
      } catch (error) {
        container.logger.error(
          "Failed to initialize transaction pooler client",
          error,
        );
        return new Response(
          JSON.stringify({
            error: "Database connection error",
            message: sanitizeErrorMessage(
              error instanceof Error ? error.message : String(error),
            ),
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // Authentication
    let authContext: Partial<
      Pick<
        AuthResult<TUser, TRole>,
        "user" | "supabaseClient" | "serviceRoleClient"
      >
    > = {};

    // Always create a default Supabase client for non-auth routes
    // Performance: Use cached client from container (avoids 5-8ms overhead per request)
    if (!route.authRequired) {
      try {
        authContext.supabaseClient = container.getOrCreateAnonClient();
      } catch (_error) {
        // Silently fail - routes can work without Supabase client
      }
    }

    if (route.authRequired) {
      try {
        const authHandler = await getAuthHandler();
        // Merge allowedRoles shorthand into authentication options
        const authOptions = {
          ...(route.authentication || {}),
          allowedMethods: route.authentication?.allowedMethods ||
            [route.method],
          ...(route.allowedRoles && {
            requireRBAC: true,
            allowedRoles: route.allowedRoles,
          }),
        };
        const normalizedAllowedMethods = (authOptions.allowedMethods ?? [])
          .map((method) => method.toUpperCase());

        if (
          req.method !== "OPTIONS" &&
          normalizedAllowedMethods.length > 0 &&
          !normalizedAllowedMethods.includes(req.method.toUpperCase())
        ) {
          return new Response(
            JSON.stringify({ error: "Method Not Allowed" }),
            {
              status: 405,
              headers: {
                ...corsHeaders,
                "Allow": normalizedAllowedMethods.join(", "),
                "Content-Type": "application/json",
              },
            },
          );
        }

        const authResult = await authHandler(req, authOptions);
        const validated = validateAuthResult(authResult, authOptions);

        if (validated.response) {
          // Add CORS headers to auth error
          for (const [key, value] of Object.entries(corsHeaders)) {
            validated.response.headers.set(key, value);
          }
          return validated.response;
        }

        authContext = {
          user: validated.user,
          supabaseClient: validated.supabaseClient,
          serviceRoleClient: validated.serviceRoleClient,
        };
      } catch (error) {
        // Authentication setup error
        return new Response(
          JSON.stringify({
            error: "Authentication configuration error",
            message: error instanceof Error ? error.message : String(error),
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // Build context
    const context = {
      req,
      requestId,
      params: sanitizedParams,
      query: validatedQuery,
      body,
      services: container,
      db: dbClient,
      ...authContext,
    };

    // Build error throwers
    const throwers: Record<string, (...args: unknown[]) => never> = {};
    for (const definition of Object.values(route.errorSchemas ?? {})) {
      const typedDefinition = definition as ErrorSchemaDefinition;
      throwers[`throw${typedDefinition.name}`] = (...args: unknown[]) =>
        typedDefinition.throw(...args);
    }

    // Core handler execution
    const executeHandler = async () => {
      try {
        const handlerContext = {
          ...context,
          ...throwers,
        } as RouteContext<
          Record<string, string>,
          Record<string, unknown>,
          unknown,
          boolean,
          TUser,
          TContainer
        > & typeof throwers;

        const result = await route.handler(handlerContext);

        // If handler returns Response, use it
        if (result instanceof Response) {
          // Add CORS headers
          for (const [key, value] of Object.entries(corsHeaders)) {
            result.headers.set(key, value);
          }
          return result;
        }

        // Otherwise, serialize as JSON
        return new Response(JSON.stringify(result), {
          status: route.successResponseCode ?? 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        });
      } catch (error) {
        // If error is Response, return it with CORS
        if (error instanceof Response) {
          for (const [key, value] of Object.entries(corsHeaders)) {
            error.headers.set(key, value);
          }
          return error;
        }

        // Generic error handling with XSS sanitization
        const errorMessage = error instanceof Error
          ? error.message
          : "Internal server error";
        return new Response(
          JSON.stringify({
            error: sanitizeErrorMessage(errorMessage),
          }),
          {
            status: 500,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          },
        );
      }
    };

    // Compose and execute middlewares
    const routeMiddlewareList = route.middlewares ??
      ([] as Middleware<TUser, TContainer>[]);
    const globalMiddlewareList = config.middlewares ??
      ([] as Middleware<TUser, TContainer>[]);
    const routeMiddlewares = composeTyped(routeMiddlewareList);
    const globalMiddlewares = composeTyped(globalMiddlewareList);

    return await globalMiddlewares(
      context,
      () => routeMiddlewares(context, executeHandler),
    );
  };

  // OpenAPI generator
  const openapi = () => {
    return generateOpenAPISpec<TRole, TUser, TContainer>(compiledRoutes, {
      title: "API Documentation",
      version: "1.0.0",
      securitySchemes: config.securitySchemes as
        | Record<string, OpenAPISchema>
        | undefined,
    });
  };

  return {
    handler,
    openapi,
  };
}
