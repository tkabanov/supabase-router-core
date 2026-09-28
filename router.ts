import type {
  AnyRouteDef,
  AuthHandler,
  ErrorSchemaDefinition,
  RouteBodyOf,
  RouteDef,
  RouteDefinitionInput,
  RouteParamsOf,
  RouteQueryOf,
  Router,
  RouterConfig,
  RouteSchemaDefinition,
} from "./core/types.ts";
import { compileRoutes } from "./routing/compiler.ts";
import { generateOpenAPISpec } from "./docs/openapi-generator.ts";
import { assertValidCorsConfig } from "./security/cors.ts";
import { DEFAULT_ERROR_SCHEMAS } from "./errors/http-errors.ts";
import { getOrCreateDefaultAuthHandler } from "./authentication/default-auth.ts";
import { createContainer, type ServiceContainer } from "./core/container.ts";
import { installTransactionPoolerClient } from "./database/pooler.ts";
import { createRequestHandler, type PipelineRoute } from "./core/pipeline.ts";

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
  // Handler params/query/body types are inferred from TSchema
  def: RouteDefinitionInput<
    TRole,
    TUser,
    TSchema,
    TAuth,
    RouteParamsOf<TSchema>,
    RouteQueryOf<TSchema>,
    RouteBodyOf<TSchema>,
    TContainer
  >,
): RouteDef<
  TRole,
  TUser,
  RouteParamsOf<TSchema>,
  RouteQueryOf<TSchema>,
  RouteBodyOf<TSchema>,
  // Without NoInfer, TAuth would be inferred as `boolean` from the router's
  // routes array, making `user` optional in every authenticated handler
  NoInfer<TAuth>,
  TContainer
> {
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

const buildThrowers = (
  errorSchemas: Record<number, ErrorSchemaDefinition>,
): PipelineRoute["throwers"] => {
  const throwers: PipelineRoute["throwers"] = {};
  for (const definition of Object.values(errorSchemas)) {
    throwers[`throw${definition.name}`] = (...args: unknown[]) =>
      definition.throw(...args);
  }
  return throwers;
};

const buildAuthOptions = (
  route: AnyRouteDef,
): PipelineRoute["authOptions"] => ({
  ...route.authentication,
  allowedMethods: route.authentication?.allowedMethods ?? [route.method],
  ...(route.allowedRoles && {
    requireRBAC: true,
    allowedRoles: route.allowedRoles,
  }),
});

const assertRouteConfig = (
  route: AnyRouteDef,
  fullPath: string,
  container: ServiceContainer,
): void => {
  if (
    route.useDatabase && typeof container.getOrCreateDbClient !== "function"
  ) {
    throw new Error(
      `Route "${fullPath}" requires database access but transaction pooler support is not configured.`,
    );
  }

  assertValidCorsConfig(route.corsHeaders);

  if (route.authentication?.requireServiceRole) {
    container.logger.warn(
      `Route "${route.method} ${fullPath}" uses requireServiceRole. It bypasses RLS and must never be called from frontend code.`,
    );
  }
};

const mergeErrorSchemas = (
  route: AnyRouteDef,
): Record<number, ErrorSchemaDefinition> => ({
  ...(route.includeDefaultErrors !== false ? DEFAULT_ERROR_SCHEMAS : {}),
  ...(route.errorSchemas ?? {}),
});

const prepareRoute = (
  route: AnyRouteDef,
  defaultTags: string[],
  container: ServiceContainer,
): PipelineRoute => {
  const fullPath = route.path ?? route.fullPath;
  assertRouteConfig(route, fullPath, container);
  const errorSchemas = mergeErrorSchemas(route);

  return {
    ...route,
    fullPath,
    tags: [...defaultTags, ...(route.tags ?? [])],
    errorSchemas,
    authRequired: route.authRequired ?? true,
    includeDefaultErrors: route.includeDefaultErrors ?? true,
    supportedContentTypes: route.supportedContentTypes ?? ["application/json"],
    authOptions: buildAuthOptions(route),
    throwers: buildThrowers(errorSchemas),
  } as PipelineRoute;
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
 *     defineRoute<MyRoles, MyUser, undefined, true, MyServices>({
 *       method: 'POST',
 *       path: '/invite',
 *       handler: async ({ services, user }) => {
 *         // services.emailService is fully typed
 *         await services.emailService.sendEmail(user.email, 'Welcome!');
 *         return { sent: true };
 *       },
 *     }),
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
  // TContainer is inferred from config.container if provided
  const container = createContainer(
    config.container as Partial<TContainer>,
  ) as TContainer;
  installTransactionPoolerClient(container, config.database);
  assertValidCorsConfig(config.corsHeaders);

  // Resolved once, on the first authenticated request
  let authHandler: Promise<AuthHandler<TRole, TUser>> | null = null;
  const getAuthHandler = () =>
    authHandler ??= config.authHandler
      ? Promise.resolve(config.authHandler)
      : getOrCreateDefaultAuthHandler<TUser, TRole>(container, {
        userLoader: config.userLoader,
        tokenVerification: config.tokenVerification,
      });

  const compiledRoutes = compileRoutes(
    config.basePath,
    config.routes.map((route) =>
      prepareRoute(route, config.defaultTags ?? [], container)
    ),
  );

  const handler = createRequestHandler({
    routes: compiledRoutes,
    container,
    corsHeaders: config.corsHeaders,
    middlewares: config.middlewares ?? [],
    getAuthHandler,
  });

  const openapi = () =>
    generateOpenAPISpec(compiledRoutes, {
      title: "API Documentation",
      version: "1.0.0",
      ...config.openapi,
      securitySchemes: config.securitySchemes,
    });

  return { handler, openapi };
}
