import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { DrizzleConfig } from "npm:drizzle-orm";
import type { drizzle as drizzleFactory } from "npm:drizzle-orm/postgres-js";
import type { TypeOf, ZodTypeAny } from "npm:zod";
import type { ServiceContainer } from "./container.ts";

// Re-export ServiceContainer for convenience
export type { ServiceContainer } from "./container.ts";

/**
 * Generic OpenAPI schema representation
 */
export type OpenAPISchema = Record<string, unknown>;

export interface OpenAPIOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<Record<string, unknown>>;
  requestBody?: {
    content: Record<string, { schema: OpenAPISchema }>;
  };
  responses: Record<number | string, OpenAPISchema>;
  security?: Array<Record<string, string[]>>;
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
  /** Allow bypassing with anon role key */
  bypassWithAnonRole?: boolean;
  /** Require authenticated user */
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
  /** Whether service role bypass was used */
  serviceBypassed?: boolean;
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
  & (TAuth extends true ? AuthenticatedContext<TUser>
    : Record<PropertyKey, never>);

/**
 * Middleware context type
 * @template TUser - User data type
 * @template TContainer - Service container type (extends ServiceContainer)
 */
export interface MiddlewareContext<
  TUser = unknown,
  TContainer extends ServiceContainer = ServiceContainer,
> {
  req: Request;
  params: Record<string, string>;
  query: Record<string, unknown>;
  /** Parsed body according to Content‑Type */
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
  params?: ZodTypeAny;
  query?: ZodTypeAny;
  body?: BodySchema;
}

type InferParamsFromSchema<TSchema> = TSchema extends { params: infer P }
  ? P extends ZodTypeAny ? TypeOf<P> : Record<string, string>
  : Record<string, string>;

type InferQueryFromSchema<TSchema> = TSchema extends { query: infer Q }
  ? Q extends ZodTypeAny ? TypeOf<Q> : Record<string, unknown>
  : Record<string, unknown>;

type InferBodyFromSchema<TSchema> = TSchema extends { body: infer B }
  ? B extends ZodTypeAny ? TypeOf<B>
  : B extends Record<string, ZodTypeAny> ? {
      [K in keyof B]: TypeOf<B[K]>;
    }[keyof B]
  : unknown
  : unknown;

type InferAuthFromRoute<TRoute> = TRoute extends { authRequired: false }
  ? false
  : true;

type RouteHandler<
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
> = Omit<
  RouteDef<TRole, TUser, TParams, TQuery, TBody, TAuth, TContainer>,
  "fullPath" | "path" | "requestSchema" | "authRequired"
> & {
  path: string;
  requestSchema?: TSchema;
  authRequired?: TAuth;
};

export type RouteParamsOf<
  TSchema extends RouteSchemaDefinition | undefined,
> = InferParamsFromSchema<TSchema>;

export type RouteQueryOf<
  TSchema extends RouteSchemaDefinition | undefined,
> = InferQueryFromSchema<TSchema>;

export type RouteBodyOf<
  TSchema extends RouteSchemaDefinition | undefined,
> = InferBodyFromSchema<TSchema>;

export type RouteAuthModeOf<TRoute> = InferAuthFromRoute<TRoute>;

/**
 * Request body schema type - can be single schema or multi-content-type schemas
 */
export type BodySchema = ZodTypeAny | Record<string, ZodTypeAny>;

/**
 * Error schema definition with typed throw helper
 */
export interface ErrorSchemaDefinition {
  name: string;
  schema: ZodTypeAny;
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
  /** CORS headers for OPTIONS requests */
  corsHeaders?: Record<string, string>;
  /** OpenAPI security requirements */
  security?: Array<Record<string, string[]>>;
  /** Route summary for OpenAPI */
  summary?: string;
  /** Route description for OpenAPI */
  description?: string;
  /** Route-level middlewares */
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
  /** Default OpenAPI tags */
  defaultTags: string[];
  /** Route definitions */
  // deno-lint-ignore no-explicit-any
  routes: Array<RouteDef<TRole, TUser, any, any, any, boolean, TContainer>>;
  /** Custom authentication handler */
  authHandler?: AuthHandler<TRole, TUser>;
  /** Custom user loader from database */
  userLoader?: UserLoader<TUser>;
  /** Global middlewares */
  middlewares?: Middleware<TUser, TContainer>[];
  /** OpenAPI security schemes */
  securitySchemes?: Record<string, OpenAPISchema>;
  /** Global CORS headers */
  corsHeaders?: CorsConfig | Record<string, string>;
  /** Service container for dependency injection */
  container?: Partial<TContainer> | TContainer;
  /** Transaction pooler database configuration */
  database?: RouterDatabaseConfig;
}

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
  type: "apiKey" | "http" | "oauth2" | "openIdConnect";
  description?: string;
  name?: string;
  in?: "query" | "header" | "cookie";
  scheme?: string;
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
  /** Statement timeout in milliseconds */
  statementTimeoutMs?: number;
  /** Connection (socket) timeout in milliseconds */
  connectionTimeoutMs?: number;
  /** Disable prepared statements (recommended for PgBouncer) */
  disablePreparedStatements?: boolean;
  /** Drizzle configuration overrides */
  drizzleConfig?: DrizzleConfig;
}

type DrizzleInstance = ReturnType<typeof drizzleFactory>;

export type TransactionDbClient = DrizzleInstance;
