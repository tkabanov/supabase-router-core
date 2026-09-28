import type { SupabaseClient } from "@supabase/supabase-js";
import type { DrizzleConfig } from "drizzle-orm";
import type { drizzle as drizzleFactory } from "drizzle-orm/postgres-js";
import type { TypeOf, ZodTypeAny } from "zod";
import type { ServiceContainer } from "./container.ts";

// Re-export ServiceContainer for convenience
export type { ServiceContainer } from "./container.ts";

/**
 * Generic OpenAPI schema representation
 */
export type OpenAPISchema = Record<string, unknown>;

/**
 * OpenAPI document metadata
 */
export interface OpenAPIConfig {
  /** API title (default: "API Documentation" via `router.openapi()`) */
  title?: string;
  /** API version (default: "1.0.0") */
  version?: string;
  /** API description */
  description?: string;
  /** Server list */
  servers?: Array<{ url: string; description?: string }>;
}

/** OpenAPI operation object */
export interface OpenAPIOperation {
  /** Short summary */
  summary?: string;
  /** Long description */
  description?: string;
  /** Tags */
  tags?: string[];
  /** Path and query parameters */
  parameters?: Array<Record<string, unknown>>;
  /** Request body by media type */
  requestBody?: {
    content: Record<string, { schema: OpenAPISchema }>;
  };
  /** Responses by status code */
  responses: Record<number | string, OpenAPISchema>;
  /** Security requirements */
  security?: Array<Record<string, string[]>>;
  /** Vendor extensions and other OpenAPI fields */
  [key: string]: unknown;
}

/**
 * Generic authentication options
 * @template TRole - User role type (enum, string union, etc.)
 *
 * @example
 * ```typescript
 * enum MyRoles { ADMIN = 'admin', USER = 'user' }
 *
 * const authOptions: AuthOptions<MyRoles> = {
 *   allowedMethods: ['POST'],
 *   requireUserAuth: true,
 *   requireRBAC: true,
 *   allowedRoles: [MyRoles.ADMIN]
 * };
 * ```
 */
export interface AuthOptions<TRole = string> {
  /** HTTP methods allowed for this route */
  allowedMethods?: string[];
  /**
   * **SECURITY WARNING**: Require service role key authentication
   *
   * **NEVER use this for frontend-accessible endpoints!**
   *
   * The service role key bypasses Row Level Security (RLS) and grants **full database access**.
   * Exposing endpoints with `requireServiceRole: true` to frontend code is a **critical security vulnerability**.
   *
   * **Safe use cases:**
   * - Internal/admin operations (server-side only)
   * - Server-to-server communication
   * - Background jobs or cron tasks
   * - Edge Functions called by other services (not from browser)
   *
   * **Never use for:**
   * - Public API endpoints
   * - Frontend-accessible routes
   * - User-facing operations
   *
   * ** Alternative for frontend:**
   * Use `requireUserAuth: true` with `requireRBAC: true` and `allowedRoles` instead.
   * This maintains RLS and provides proper access control.
   *
   * @example
   * ```typescript
   * // WRONG - Never expose to frontend!
   * defineRoute({
   *   authentication: { requireServiceRole: true },
   *   handler: async ({ serviceRoleClient }) => {
   *     // This bypasses RLS - DANGEROUS if called from browser!
   *   }
   * });
   *
   * // CORRECT - Use user auth with RBAC for frontend
   * defineRoute({
   *   authentication: {
   *     requireUserAuth: true,
   *     requireRBAC: true,
   *     allowedRoles: [Roles.ADMIN]
   *   },
   *   handler: async ({ user, supabaseClient }) => {
   *     // RLS is enforced, safe for frontend
   *   }
   * });
   * ```
   */
  requireServiceRole?: boolean;
  /** Allow bypassing with service role key */
  bypassWithServiceRole?: boolean;
  /**
   * Accept the anon key instead of a user token.
   *
   * **SECURITY WARNING**: the anon key is public (it ships with every
   * frontend), so this effectively makes the route public. RBAC still applies
   * and therefore always rejects anon-key requests.
   */
  bypassWithAnonRole?: boolean;
  /**
   * Require an authenticated user (default: `true` for routes with
   * `authRequired`). Set to `false` to accept a valid token without a user.
   */
  requireUserAuth?: boolean;
  /** Enable role-based access control */
  requireRBAC?: boolean;
  /** Allowed roles when RBAC is enabled */
  allowedRoles?: TRole[];
}

/**
 * Result of authentication operation
 * @template TUser - User data type
 * @template TRole - User role type
 */
export interface AuthResult<TUser = unknown, TRole = string> {
  /** Error response if authentication failed */
  response?: Response;
  /** Supabase client instance */
  supabaseClient?: SupabaseClient;
  /** Service role client instance (if explicitly granted) */
  serviceRoleClient?: SupabaseClient;
  /** Authenticated user data */
  user?: TUser;
  /** Whether the service role key was used (trusted, skips user/RBAC checks) */
  serviceBypassed?: boolean;
  /** Whether the public anon key was accepted instead of a user token */
  anonBypassed?: boolean;
}

/**
 * Custom authentication handler
 * @template TRole - User role type
 * @template TUser - User data type
 *
 * @example
 * ```typescript
 * const authHandler: AuthHandler<MyRoles, MyUser> = async (req, options) => {
 *   // Custom auth logic
 *   return { user, supabaseClient };
 * };
 * ```
 */
export type AuthHandler<TRole = string, TUser = unknown> = (
  req: Request,
  options: AuthOptions<TRole>,
) => Promise<AuthResult<TUser, TRole>>;

/**
 * Custom user loader from database
 * @template TUser - User data type
 *
 * @example
 * ```typescript
 * const userLoader: UserLoader<MyUser> = async (userId, supabase) => {
 *   const { data } = await supabase
 *     .from('users')
 *     .select('*')
 *     .eq('id', userId)
 *     .single();
 *   return data;
 * };
 * ```
 */
export type UserLoader<TUser = unknown> = (
  userId: string,
  supabaseClient: SupabaseClient,
) => Promise<TUser | null>;

/**
 * Context for authenticated routes
 * @template TUser - User data structure
 */
export interface AuthenticatedContext<TUser = unknown> {
  /** Authenticated user data */
  user: TUser;
  /** Supabase client with user context */
  supabaseClient: SupabaseClient;
  /** Explicit service-role client when granted */
  serviceRoleClient?: SupabaseClient;
  /** Drizzle database client scoped to transaction pooler */
  db?: TransactionDbClient;
}

/**
 * Context for public routes (`authRequired: false`)
 */
export interface PublicContext {
  /** Never set on public routes */
  user?: undefined;
  /** Never set on public routes */
  serviceRoleClient?: undefined;
  /** Client for the publishable (or legacy anon) key, when configured */
  supabaseClient?: SupabaseClient;
}

/**
 * Generic route context with full type inference
 * @template TParams - Path parameters type
 * @template TQuery - Query parameters type
 * @template TBody - Request body type
 * @template TAuth - Whether authentication is required
 * @template TUser - User data type
 * @template TContainer - Service container type (extends ServiceContainer)
 *
 * @example
 * ```typescript
 * // Authenticated route with typed params and custom services
 * interface MyServices extends ServiceContainer {
 *   emailService: EmailService;
 * }
 *
 * type Context = RouteContext<
 *   { id: string },  // params
 *   { page: number }, // query
 *   CreateUserDto,   // body
 *   true,            // authenticated
 *   MyUser,          // user type
 *   MyServices       // container type
 * >;
 *
 * // services.emailService is now fully typed!
 * ```
 */
export type RouteContext<
  TParams = unknown,
  TQuery = unknown,
  TBody = unknown,
  TAuth extends boolean = false,
  TUser = unknown,
  TContainer extends ServiceContainer = ServiceContainer,
> =
  & {
    /** Original Request object */
    req: Request;
    /** Request ID for tracing */
    requestId: string;
    /** Parsed and validated path parameters */
    params: TParams;
    /** Parsed and validated query parameters */
    query: TQuery;
    /** Parsed and validated request body */
    body: TBody;
    /** Service container with core and custom services */
    services: TContainer;
    /** Optional Drizzle database client (transaction pooler) */
    db?: TransactionDbClient;
  }
  & (TAuth extends true ? AuthenticatedContext<TUser> : PublicContext);

/**
 * Middleware context type
 * @template TUser - User data type
 * @template TContainer - Service container type (extends ServiceContainer)
 */
export interface MiddlewareContext<
  TUser = unknown,
  TContainer extends ServiceContainer = ServiceContainer,
> {
  /** Original Request object */
  req: Request;
  /** Request ID for tracing */
  requestId: string;
  /** Path parameters (validated output once validation ran) */
  params: Record<string, unknown>;
  /** Query parameters (validated output once validation ran) */
  query: Record<string, unknown>;
  /** Parsed body according to Content‑Type (set after validation) */
  body: unknown;
  /** Service container with core and custom services */
  services: TContainer;
  /** Authenticated user (when available) */
  user?: TUser;
  /** Supabase client scoped to authenticated user */
  supabaseClient?: SupabaseClient;
  /** Supabase client with service-role privileges */
  serviceRoleClient?: SupabaseClient;
  /** Drizzle database client when route opts in */
  db?: TransactionDbClient;
}

/**
 * Middleware function type
 * @template TUser - User data type
 * @template TContainer - Service container type (extends ServiceContainer)
 *
 * @example
 * ```typescript
 * const loggingMiddleware: Middleware = async (ctx, next) => {
 *   console.log(`${ctx.req.method} ${ctx.req.url}`);
 *   const response = await next();
 *   console.log(`Response: ${response.status}`);
 *   return response;
 * };
 * ```
 */
export type Middleware<
  TUser = unknown,
  TContainer extends ServiceContainer = ServiceContainer,
> = (
  ctx: MiddlewareContext<TUser, TContainer>,
  next: () => Promise<Response>,
) => Promise<Response>;

/**
 * Request schema definition
 */
export interface RouteSchemaDefinition {
  /** Path parameters schema */
  params?: ZodTypeAny;
  /** Query parameters schema */
  query?: ZodTypeAny;
  /** Request body schema (single or per content type) */
  body?: BodySchema;
}

/** Path params type inferred from a request schema */
export type InferParamsFromSchema<TSchema> = TSchema extends { params: infer P }
  ? P extends ZodTypeAny ? TypeOf<P> : Record<string, string>
  : Record<string, string>;

/** Query type inferred from a request schema */
export type InferQueryFromSchema<TSchema> = TSchema extends { query: infer Q }
  ? Q extends ZodTypeAny ? TypeOf<Q> : Record<string, unknown>
  : Record<string, unknown>;

/** Body type inferred from a request schema */
export type InferBodyFromSchema<TSchema> = TSchema extends { body: infer B }
  ? B extends ZodTypeAny ? TypeOf<B>
  : B extends Record<string, ZodTypeAny> ? {
      [K in keyof B]: TypeOf<B[K]>;
    }[keyof B]
  : unknown
  : unknown;

/** Whether a route definition requires auth */
export type InferAuthFromRoute<TRoute> = TRoute extends { authRequired: false }
  ? false
  : true;

/**
 * Route handler receiving the fully typed route context
 */
export type RouteHandler<
  TParams,
  TQuery,
  TBody,
  TAuth extends boolean,
  TUser,
  TContainer extends ServiceContainer,
> = (
  ctx: RouteContext<TParams, TQuery, TBody, TAuth, TUser, TContainer>,
) => Promise<unknown>;

/**
 * Route definition input used by defineRoute
 * @template TContainer - Service container type (extends ServiceContainer)
 */
export type RouteDefinitionInput<
  TRole = string,
  TUser = unknown,
  TSchema extends Partial<RouteSchemaDefinition> | undefined = undefined,
  TAuth extends boolean = true,
  TParams = InferParamsFromSchema<TSchema>,
  TQuery = InferQueryFromSchema<TSchema>,
  TBody = InferBodyFromSchema<TSchema>,
  TContainer extends ServiceContainer = ServiceContainer,
> =
  & Omit<
    RouteDef<TRole, TUser, TParams, TQuery, TBody, TAuth, TContainer>,
    "fullPath" | "path" | "requestSchema" | "authRequired"
  >
  & {
    path: string;
    requestSchema?: TSchema;
    authRequired?: TAuth;
  };

/** Handler `params` type for a request schema */
export type RouteParamsOf<
  TSchema extends RouteSchemaDefinition | undefined,
> = InferParamsFromSchema<TSchema>;

/** Handler `query` type for a request schema */
export type RouteQueryOf<
  TSchema extends RouteSchemaDefinition | undefined,
> = InferQueryFromSchema<TSchema>;

/** Handler `body` type for a request schema */
export type RouteBodyOf<
  TSchema extends RouteSchemaDefinition | undefined,
> = InferBodyFromSchema<TSchema>;

/** Whether a route definition requires auth */
export type RouteAuthModeOf<TRoute> = InferAuthFromRoute<TRoute>;

/**
 * Request body schema type - can be single schema or multi-content-type schemas
 */
export type BodySchema = ZodTypeAny | Record<string, ZodTypeAny>;

/**
 * Error schema definition with typed throw helper
 */
export interface ErrorSchemaDefinition {
  /** Name used for the `throw<Name>` helper and OpenAPI description */
  name: string;
  /** Response body schema */
  schema: ZodTypeAny;
  /** Throw the error response */
  throw: (...args: unknown[]) => never;
}

/**
 * Route definition with authentication and validation
 * @template TRole - User role type
 * @template TUser - User data type
 * @template TContainer - Service container type (extends ServiceContainer)
 *
 * @example
 * ```typescript
 * interface MyServices extends ServiceContainer {
 *   emailService: EmailService;
 * }
 *
 * const route: RouteDef<MyRoles, MyUser, any, any, any, boolean, MyServices> = {
 *   method: 'POST',
 *   path: '/users',
 *   summary: 'Create user',
 *   authRequired: true,
 *   allowedRoles: [MyRoles.ADMIN],
 *   requestSchema: { body: createUserSchema },
 *   handler: async ({ body, user, services }) => {
 *     // services.emailService is fully typed!
 *     await services.emailService.sendEmail(...);
 *   }
 * };
 * ```
 */
export interface RouteDef<
  TRole = string,
  TUser = unknown,
  TParams = Record<string, string>,
  TQuery = Record<string, unknown>,
  TBody = unknown,
  TAuth extends boolean = boolean,
  TContainer extends ServiceContainer = ServiceContainer,
> {
  /** HTTP method */
  method: string;
  /** Route path relative to router base path */
  path?: string;
  /** Full path with basePath */
  fullPath: string;
  /** OpenAPI tags */
  tags?: string[];
  /** Request schema definitions */
  requestSchema?: RouteSchemaDefinition;
  /** Supported content types, defaults to ["application/json"] */
  supportedContentTypes?: string[];
  /** Response schema for OpenAPI */
  responseSchema?: ZodTypeAny;
  /** Success response HTTP code */
  successResponseCode?: number;
  /** Success response description */
  successResponseDescription?: string;
  /** Custom error schemas */
  errorSchemas?: Record<number, ErrorSchemaDefinition>;
  /** Whether authentication is required */
  authRequired?: boolean;
  /** Include default error schemas in OpenAPI */
  includeDefaultErrors?: boolean;
  /** Disable automatic DTO validation */
  disableDTOValidation?: boolean;
  /** Authentication options */
  authentication?: AuthOptions<TRole>;
  /** Shorthand for authentication.allowedRoles */
  allowedRoles?: TRole[];
  /** CORS configuration (overrides the router-level `corsHeaders`) */
  corsHeaders?: CorsConfig | Record<string, string>;
  /** OpenAPI security requirements */
  security?: Array<Record<string, string[]>>;
  /** Route summary for OpenAPI */
  summary?: string;
  /** Route description for OpenAPI */
  description?: string;
  /**
   * Route-level middlewares. They run after authentication and validation,
   * right before the handler, so `ctx.user` and `ctx.body` are available.
   */
  middlewares?: Middleware<TUser, TContainer>[];
  /** Opt-in access to transaction pooler database client */
  useDatabase?: boolean;
  /** Route handler function */
  handler: RouteHandler<TParams, TQuery, TBody, TAuth, TUser, TContainer>;
}

/**
 * CORS configuration
 *
 * @example
 * ```typescript
 * const corsConfig: CorsConfig = {
 *   allowedOrigins: ['https://example.com'],
 *   allowedMethods: ['GET', 'POST'],
 *   allowedHeaders: ['Content-Type', 'Authorization'],
 *   credentials: true
 * };
 * ```
 */
export interface CorsConfig {
  /** Whitelist of allowed origins or '*' for all */
  allowedOrigins: string[] | "*";
  /** Allowed HTTP methods */
  allowedMethods?: string[];
  /** Allowed request headers */
  allowedHeaders?: string[];
  /** Exposed response headers */
  exposedHeaders?: string[];
  /** Allow credentials */
  credentials?: boolean;
  /** Preflight cache duration in seconds */
  maxAge?: number;
}

/**
 * Generic router configuration
 * @template TRole - User role type (enum, string union, etc.)
 * @template TUser - User data structure from your database
 * @template TContainer - Service container type (extends ServiceContainer)
 *
 * @example
 * ```typescript
 * interface MyServices extends ServiceContainer {
 *   emailService: EmailService;
 * }
 *
 * const router = defineRouter<MyRoles, MyUser, MyServices>({
 *   basePath: '/api/v1',
 *   defaultTags: ['API'],
 *   container: myServicesContainer,
 *   routes: [...],
 *   authHandler: customAuthHandler,
 *   userLoader: customUserLoader
 * });
 * ```
 */
export interface RouterConfig<
  TRole = string,
  TUser = Record<string, unknown>,
  TContainer extends ServiceContainer = ServiceContainer,
> {
  /** Base path for all routes */
  basePath: string;
  /** Default OpenAPI tags added to every route (default: none) */
  defaultTags?: string[];
  /** Route definitions */
  routes: Array<AnyRouteDef<TRole, TUser, TContainer>>;
  /** Custom authentication handler */
  authHandler?: AuthHandler<TRole, TUser>;
  /**
   * Load the user (including its role) from your database after the default
   * auth handler verified the token. Without it, the user is built from the
   * token's `app_metadata`, which only the server can modify.
   * Ignored when a custom `authHandler` is provided.
   */
  userLoader?: UserLoader<TUser>;
  /**
   * How the default auth handler verifies access tokens (default: `"claims"`,
   * local JWKS verification). Use `"auth-server"` to detect signed-out
   * sessions immediately. Ignored when a custom `authHandler` is provided.
   */
  tokenVerification?: "claims" | "auth-server";
  /**
   * Global middlewares. They wrap the whole request pipeline (right after route
   * matching), so they run before authentication and body parsing: use them for
   * rate limiting, body size limits, timeouts, logging and error handling.
   * `ctx.user`/`ctx.body` are only populated after `await next()`.
   */
  middlewares?: Middleware<TUser, TContainer>[];
  /** OpenAPI security schemes */
  securitySchemes?: Record<string, OpenAPISchema>;
  /** Global CORS configuration (default: permissive `*`) */
  corsHeaders?: CorsConfig | Record<string, string>;
  /** OpenAPI document metadata */
  openapi?: OpenAPIConfig;
  /** Service container for dependency injection */
  container?: Partial<TContainer> | TContainer;
  /** Transaction pooler database configuration */
  database?: RouterDatabaseConfig;
}

/**
 * Type-erased slot. Routers hold routes whose params/query/body types differ,
 * so collections of routes erase those generics. This is the only `any`.
 */
// deno-lint-ignore no-explicit-any
export type Erased = any;

/**
 * Route definition with erased params/query/body/auth generics
 */
export type AnyRouteDef<
  TRole = Erased,
  TUser = Erased,
  TContainer extends ServiceContainer = Erased,
> = RouteDef<TRole, TUser, Erased, Erased, Erased, boolean, TContainer>;

/**
 * Compiled route with erased params/query/body/auth generics
 */
export type AnyCompiledRoute<
  TRole = Erased,
  TUser = Erased,
  TContainer extends ServiceContainer = Erased,
> = CompiledRoute<TRole, TUser, Erased, Erased, Erased, boolean, TContainer>;

/**
 * Compiled route with regex pattern
 */
export interface CompiledRoute<
  TRole = string,
  TUser = unknown,
  TParams = Record<string, string>,
  TQuery = Record<string, unknown>,
  TBody = unknown,
  TAuth extends boolean = boolean,
  TContainer extends ServiceContainer = ServiceContainer,
> extends RouteDef<TRole, TUser, TParams, TQuery, TBody, TAuth, TContainer> {
  /** Regex pattern for URL matching */
  regex: RegExp;
  /** Extracted parameter names */
  params: string[];
}

/**
 * Router instance with handler and OpenAPI generator
 */
export interface Router {
  /** Request handler function */
  handler: (req: Request) => Promise<Response>;
  /** OpenAPI specification generator */
  openapi: () => {
    info: { title: string; version: string };
    paths: Record<string, Record<string, OpenAPIOperation>>;
    components: {
      securitySchemes: Record<string, OpenAPISchema>;
      schemas: Record<string, OpenAPISchema>;
    };
  };
}

/**
 * Security scheme definition for OpenAPI
 */
export interface SecurityScheme {
  /** Scheme type */
  type: "apiKey" | "http" | "oauth2" | "openIdConnect";
  /** Description */
  description?: string;
  /** Header, query or cookie name (apiKey) */
  name?: string;
  /** Location of the API key (apiKey) */
  in?: "query" | "header" | "cookie";
  /** HTTP auth scheme, e.g. `bearer` (http) */
  scheme?: string;
  /** Bearer token format hint, e.g. `JWT` */
  bearerFormat?: string;
}

/**
 * Transaction pooler database configuration
 */
export interface RouterDatabaseConfig {
  /** Enable transaction pooler client creation */
  enableTransactionPooler?: boolean;
  /** Environment variable containing pooler connection string */
  connectionStringEnv?: string;
  /** Maximum number of pooled connections */
  maxConnections?: number;
  /** Idle timeout in milliseconds */
  idleTimeoutMs?: number;
  /**
   * Statement timeout in milliseconds, sent as a connection startup parameter.
   *
   * Transaction poolers (Supabase Supavisor on port 6543, PgBouncer) silently
   * drop startup parameters, so with them this has no effect; the router
   * checks the effective value on connect and logs a warning. Set the timeout
   * on the database role instead, which also works through the pooler:
   * `ALTER ROLE postgres SET statement_timeout = '10s';`
   * (use the role from your connection string).
   */
  statementTimeoutMs?: number;
  /** Connection (socket) timeout in milliseconds */
  connectionTimeoutMs?: number;
  /** Disable prepared statements (default: true; required by transaction poolers) */
  disablePreparedStatements?: boolean;
  /** Drizzle configuration overrides */
  drizzleConfig?: DrizzleConfig;
}

/** Drizzle client for postgres-js */
export type DrizzleInstance = ReturnType<typeof drizzleFactory>;

/** Drizzle client connected through the transaction pooler */
export type TransactionDbClient = DrizzleInstance;
