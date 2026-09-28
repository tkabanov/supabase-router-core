/**
 * @module supabase-router
 *
 * Type-safe routing framework for Edge Functions (Supabase, Deno Deploy,
 * Cloudflare Workers) with automatic authentication, DTO validation,
 * and OpenAPI documentation generation.
 *
 * ## Features
 * - **Security hardening** - Path traversal and prototype pollution protection,
 *   fail-closed auth and RBAC, CORS allowlists, constant-time key checks
 * - **Generic types** - Bring your own role system and user type
 * - **Automatic validation** - Zod-based DTO validation
 * - **Built-in authentication** - Automatic auth with RBAC support
 * - **OpenAPI generation** - Auto-generated API documentation
 * - **Middleware support** - Composable request/response middleware
 * - **Type-safe handlers** - Full type inference from schemas to handlers
 *
 * @example Basic usage
 * ```typescript
 * import { defineRouter, defineRoute } from '@supabase-router/core';
 * import { z } from 'zod';
 *
 * enum MyRoles { ADMIN = 'admin', USER = 'user' }
 *
 * const router = defineRouter<MyRoles>({
 *   basePath: '/api',
 *   defaultTags: ['API'],
 *   routes: [
 *     defineRoute({
 *       method: 'POST',
 *       path: '/users',
 *       summary: 'Create user',
 *       authRequired: true,
 *       allowedRoles: [MyRoles.ADMIN],
 *       requestSchema: {
 *         body: z.object({ name: z.string() })
 *       },
 *       handler: async ({ body, user }) => {
 *         // body is typed as { name: string }
 *         // user is available (authenticated)
 *         return { success: true };
 *       }
 *     })
 *   ]
 * });
 *
 * Deno.serve(router.handler);
 * ```
 *
 * @example With custom authentication
 * ```typescript
 * import { parseBearerToken, unauthorized } from '@supabase-router/core';
 *
 * const router = defineRouter<MyRoles, MyUser>({
 *   basePath: '/api',
 *   authHandler: async (req, options) => {
 *     const token = parseBearerToken(req.headers.get('Authorization'));
 *     const user = token ? await myVerifyToken(token) : null;
 *     // Without a user the router answers 401 unless requireUserAuth is false
 *     if (!user) return { response: unauthorized() };
 *     return { user, supabaseClient: createUserClient(token!) };
 *   },
 *   routes: [...]
 * });
 * ```
 */

// Core types
export type {
  AnyCompiledRoute,
  AnyRouteDef,
  AuthenticatedContext,
  AuthHandler,
  AuthOptions,
  AuthResult,
  BodySchema,
  CompiledRoute,
  CorsConfig,
  DrizzleInstance,
  Erased,
  InferAuthFromRoute,
  InferBodyFromSchema,
  InferParamsFromSchema,
  InferQueryFromSchema,
  Middleware,
  MiddlewareContext,
  OpenAPIConfig,
  OpenAPIOperation,
  OpenAPISchema,
  PublicContext,
  RouteAuthModeOf,
  RouteBodyOf,
  RouteContext,
  RouteDef,
  RouteDefinitionInput,
  RouteHandler,
  RouteParamsOf,
  RouteQueryOf,
  Router,
  RouterConfig,
  RouterDatabaseConfig,
  RouteSchemaDefinition,
  SecurityScheme,
  TransactionDbClient,
  UserLoader,
} from "./core/types.ts";

export type { SupabaseClient } from "@supabase/supabase-js";

// Dependency injection container
export type {
  EnvironmentProvider,
  IdGenerator,
  Logger,
  ServiceContainer,
  SupabaseClientFactory,
} from "./core/container.ts";

export {
  createContainer,
  defaultEnv,
  defaultIdGenerator,
  defaultLogger,
  defaultSupabaseClientFactory,
} from "./core/container.ts";

// Router functions
export { defineRoute, defineRouter } from "./router.ts";

// HTTP error responses
export type { ErrorSchemaDefinition } from "./core/types.ts";

export {
  badRequest,
  created,
  createErrorResponseByEnv,
  DEFAULT_ERROR_SCHEMAS,
  forbidden,
  internalServerError,
  methodNotAllowed,
  noContent,
  notFound,
  ok,
  unauthorized,
  unprocessableEntity,
} from "./errors/http-errors.ts";

// Security utilities
export {
  isValidHeaderName,
  parseFormDataSafely,
  parseQuerySafely,
  sanitizeErrorMessage,
  sanitizeHeaderList,
  sanitizeHeaderValue,
  sanitizePathParam,
} from "./security/sanitizer.ts";

export { timingSafeEqual } from "./security/timing.ts";

export {
  assertValidCorsConfig,
  buildCorsHeaders,
  getDefaultCorsHeaders,
  mergeCorsConfigs,
  resolveCorsHeaders,
} from "./security/cors.ts";

// Authentication utilities
export {
  checkRoles,
  createRoleHierarchy,
  hasAllRoles,
  hasAnyRole,
} from "./authentication/rbac.ts";

export {
  createNoAuthHandler,
  validateAuthResult,
} from "./authentication/authenticator.ts";

export type {
  DefaultAuthOptions,
  TokenVerification,
} from "./authentication/default-auth.ts";

export type { SupabaseJwk, SupabaseKeys } from "./core/supabase-keys.ts";

export { resolveSupabaseKeys } from "./core/supabase-keys.ts";

export {
  createDefaultAuthHandler,
  getOrCreateDefaultAuthHandler,
  parseBearerToken,
} from "./authentication/default-auth.ts";

// Middleware
export {
  catchErrors,
  composeMiddlewares,
  conditionalMiddleware,
} from "./middleware/composer.ts";

export {
  bodySizeLimitMiddleware,
  errorHandlerMiddleware,
  loggingMiddleware,
  requestIdMiddleware,
  timeoutMiddleware,
  timingMiddleware,
} from "./middleware/builtin.ts";

// Validation
export type { ValidationResult } from "./validation/dto-validator.ts";

export {
  beautifyZodErrors,
  parseAndValidateBody,
  validateDTO,
} from "./validation/dto-validator.ts";

export type {
  JsonSchema,
  SchemaDirection,
} from "./validation/schema-extractor.ts";

export { extractSchema } from "./validation/schema-extractor.ts";

// OpenAPI generation
export type { OpenAPISpec } from "./docs/openapi-generator.ts";

export {
  extractTags,
  generateOpenAPIPaths,
  generateOpenAPISpec,
} from "./docs/openapi-generator.ts";

// Constants
export {
  DANGEROUS_QUERY_KEYS,
  DEFAULT_CORS_HEADERS,
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_SECURITY_HEADERS,
  DEFAULT_SECURITY_SCHEMES,
  HTTP_STATUS,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_PATH_PARAM_LENGTH,
  PATH_PARAM_NAME_REGEX,
  SAFE_PATH_PARAM_PATTERN,
  SUPPORTED_CONTENT_TYPES,
} from "./core/constants.ts";

// Context utilities
export type { RequestMetadata } from "./core/context.ts";

export { createRequestMetadata, generateRequestId } from "./core/context.ts";

// Routing utilities (advanced usage)
export type {
  AnyRoute,
  CompiledRoutesData,
  RouteMatch,
} from "./routing/compiler.ts";

export {
  compileRoute,
  compileRoutes,
  matchRoute,
  matchRouteRaw,
} from "./routing/compiler.ts";

export { findMatchingRoutes, getAllowedMethods } from "./routing/matcher.ts";

export {
  extractParamNames,
  isValidParamName,
  validatePathSafety,
} from "./routing/params-validator.ts";

// Note: CLI types are now in @supabase-router/cli package
// Import from there if you need ScanConfig, OutputConfig, or DocsConfig
