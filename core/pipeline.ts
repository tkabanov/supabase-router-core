import type {
  AnyCompiledRoute,
  AuthHandler,
  AuthOptions,
  CorsConfig,
  Erased,
  Middleware,
  MiddlewareContext,
  ServiceContainer,
} from "./types.ts";
import type { ZodTypeAny } from "zod";
import type { CompiledRoutesData } from "../routing/compiler.ts";
import { matchRouteRaw } from "../routing/compiler.ts";
import { getAllowedMethods } from "../routing/matcher.ts";
import { resolveCorsHeaders } from "../security/cors.ts";
import {
  parseQuerySafely,
  sanitizeErrorMessage,
  sanitizePathParam,
} from "../security/sanitizer.ts";
import {
  parseAndValidateBody,
  validateDTO,
} from "../validation/dto-validator.ts";
import { validateAuthResult } from "../authentication/authenticator.ts";
import { composeMiddlewares } from "../middleware/composer.ts";

/**
 * Compiled route with everything the pipeline precomputes at startup
 */
export type PipelineRoute =
  & AnyCompiledRoute
  & {
    /** Auth options merged with the `allowedRoles` shorthand */
    authOptions: AuthOptions<unknown> & { allowedMethods: string[] };
    /** `throwBadRequest(...)` etc. derived from error schemas */
    throwers: Record<string, (...args: unknown[]) => never>;
  };

/**
 * Everything the request pipeline needs from the router
 */
export interface PipelineConfig {
  routes: CompiledRoutesData<Erased, Erased, Erased>;
  container: ServiceContainer;
  corsHeaders?: CorsConfig | Record<string, string>;
  middlewares: Middleware<Erased, Erased>[];
  getAuthHandler: () => Promise<AuthHandler<Erased, Erased>>;
}

type Context = MiddlewareContext<unknown, ServiceContainer>;

interface RequestState {
  ctx: Context;
  route: PipelineRoute;
  url: URL;
  rawParams: Record<string, string>;
}

type Step = (
  state: RequestState,
  config: PipelineConfig,
) => Promise<Response | undefined> | Response | undefined;

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** Copy a response (its headers may be immutable) and add CORS headers */
const withHeaders = (
  response: Response,
  headers: Record<string, string>,
  stripBody: boolean,
): Response => {
  const copy = new Response(stripBody ? null : response.body, response);
  for (const [key, value] of Object.entries(headers)) {
    copy.headers.set(key, value);
  }
  return copy;
};

/** Recreate an object without prototype to prevent prototype pollution */
const toSafeObject = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  return Object.assign(Object.create(null), value);
};

const validateInto = (
  state: RequestState,
  key: "params" | "query",
  data: Record<string, unknown>,
  schema: ZodTypeAny | undefined,
): Response | undefined => {
  if (!schema || state.route.disableDTOValidation) {
    state.ctx[key] = data;
    return undefined;
  }

  const result = validateDTO(data, schema);
  if (!result.success) {
    const label = key === "params" ? "Path parameter" : "Query";
    return json(400, {
      error: `${label} validation failed`,
      details: result.errors,
    });
  }

  state.ctx[key] = toSafeObject(result.data) as Record<string, unknown>;
  return undefined;
};

const authStep: Step = async ({ ctx, route }, config) => {
  if (!route.authRequired) {
    try {
      ctx.supabaseClient = config.container.getOrCreateAnonClient();
    } catch {
      // Public routes work without a Supabase client
    }
    return undefined;
  }

  const allowed = route.authOptions.allowedMethods.map((m) => m.toUpperCase());
  if (!allowed.includes(route.method.toUpperCase())) {
    return json(405, { error: "Method Not Allowed" }, {
      "Allow": allowed.join(", "),
    });
  }

  const authHandler = await config.getAuthHandler();
  const result = validateAuthResult(
    await authHandler(ctx.req, route.authOptions),
    route.authOptions,
  );
  if (result.response) {
    return result.response;
  }

  ctx.user = result.user;
  ctx.supabaseClient = result.supabaseClient;
  ctx.serviceRoleClient = result.serviceRoleClient;
  return undefined;
};

const paramsStep: Step = (state) => {
  const sanitized: Record<string, string> = {};
  try {
    for (const [key, value] of Object.entries(state.rawParams)) {
      sanitized[key] = sanitizePathParam(value);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : undefined;
    return json(400, {
      error: sanitizeErrorMessage(message ?? "Invalid path parameter"),
    });
  }
  return validateInto(
    state,
    "params",
    sanitized,
    state.route.requestSchema?.params,
  );
};

const queryStep: Step = (state) =>
  validateInto(
    state,
    "query",
    parseQuerySafely(state.url.searchParams),
    state.route.requestSchema?.query,
  );

const bodyStep: Step = async ({ ctx, route }) => {
  const schema = route.requestSchema?.body;
  if (!schema || route.disableDTOValidation) {
    return undefined;
  }

  // Throws a Response (400/415) on failure
  ctx.body = await parseAndValidateBody(
    ctx.req,
    schema,
    ctx.req.headers.get("content-type") ?? "application/json",
    route.supportedContentTypes,
  );
  return undefined;
};

const databaseStep: Step = async ({ ctx, route }, { container }) => {
  if (!route.useDatabase) {
    return undefined;
  }

  if (typeof container.getOrCreateDbClient !== "function") {
    return json(500, { error: "Database configuration error" });
  }

  try {
    ctx.db = await container.getOrCreateDbClient();
  } catch (error) {
    container.logger.error("Failed to initialize database client", error);
    return json(500, { error: "Database connection error" });
  }
  return undefined;
};

// Authenticate first so unauthenticated requests never get their body parsed
const STEPS: Step[] = [authStep, paramsStep, queryStep, bodyStep, databaseStep];

const executeHandler = async (
  ctx: Context,
  route: PipelineRoute,
): Promise<Response> => {
  // Auth and validation steps guarantee the shape promised by RouteContext
  const handlerContext = { ...ctx, ...route.throwers } as Parameters<
    PipelineRoute["handler"]
  >[0];
  const result = await route.handler(handlerContext);

  if (result instanceof Response) {
    return result;
  }

  return json(route.successResponseCode ?? 200, result);
};

/** Convert thrown Responses (e.g. `throwNotFound()`) into return values */
const catchThrownResponse = async (
  run: () => Promise<Response>,
): Promise<Response> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    throw error;
  }
};

const runRoute = async (
  state: RequestState,
  config: PipelineConfig,
): Promise<Response> => {
  for (const step of STEPS) {
    const response = await step(state, config);
    if (response) {
      return response;
    }
  }

  const routeMiddleware = composeMiddlewares(state.route.middlewares ?? []);
  return await routeMiddleware(
    state.ctx,
    () => executeHandler(state.ctx, state.route),
  );
};

const findRoute = (
  method: string,
  pathname: string,
  config: PipelineConfig,
) => {
  const match = matchRouteRaw(method, pathname, config.routes);
  // HEAD is served by the GET route (the body is stripped later)
  return match ??
    (method === "HEAD" ? matchRouteRaw("GET", pathname, config.routes) : null);
};

const allowedMethodsFor = (
  pathname: string,
  config: PipelineConfig,
): string[] => {
  const methods = getAllowedMethods(pathname, config.routes);
  if (methods.includes("GET") && !methods.includes("HEAD")) {
    methods.push("HEAD");
  }
  return methods;
};

const handlePreflight = (
  req: Request,
  pathname: string,
  config: PipelineConfig,
): Response => {
  const allowedMethods = allowedMethodsFor(pathname, config);
  const origin = req.headers.get("origin");

  if (allowedMethods.length === 0) {
    const cors = resolveCorsHeaders(origin, config.corsHeaders, []);
    return json(404, { error: "Not Found" }, cors);
  }

  // Use the CORS config of the route the browser is actually going to call
  const requested = req.headers.get("access-control-request-method");
  const match =
    (requested && findRoute(requested.toUpperCase(), pathname, config)) ||
    matchRouteRaw("OPTIONS", pathname, config.routes);
  const corsConfig = match?.route.corsHeaders ?? config.corsHeaders;

  return new Response(null, {
    status: 204,
    headers: resolveCorsHeaders(origin, corsConfig, allowedMethods),
  });
};

const handleUnmatched = (
  req: Request,
  pathname: string,
  config: PipelineConfig,
): Response => {
  const allowedMethods = allowedMethodsFor(pathname, config);
  const cors = resolveCorsHeaders(
    req.headers.get("origin"),
    config.corsHeaders,
    allowedMethods,
  );

  if (allowedMethods.length === 0) {
    return json(404, { error: "Not Found" }, cors);
  }

  return json(405, { error: "Method Not Allowed" }, {
    ...cors,
    "Allow": allowedMethods.join(", "),
  });
};

const handleMatched = async (
  req: Request,
  url: URL,
  match: { route: PipelineRoute; params: Record<string, string> },
  config: PipelineConfig,
): Promise<Response> => {
  const { container } = config;
  const ctx: Context = {
    req,
    requestId: container.idGenerator.generate(),
    params: {},
    query: {},
    body: undefined,
    services: container,
  };
  const state: RequestState = {
    ctx,
    route: match.route,
    url,
    rawParams: match.params,
  };

  const globalMiddleware = composeMiddlewares(config.middlewares);
  const response = await runSafely(
    () =>
      globalMiddleware(
        ctx,
        () => catchThrownResponse(() => runRoute(state, config)),
      ),
    container,
    ctx.requestId,
  );

  const cors = resolveCorsHeaders(
    req.headers.get("origin"),
    match.route.corsHeaders ?? config.corsHeaders,
    allowedMethodsFor(url.pathname, config),
  );
  return withHeaders(response, cors, req.method === "HEAD");
};

/**
 * Last line of defence: never let an exception escape to the runtime.
 * Details are logged; the client only gets a generic message and request ID.
 */
const runSafely = async (
  run: () => Promise<Response>,
  container: ServiceContainer,
  requestId?: string,
): Promise<Response> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    container.logger.error("Unhandled error while processing request", {
      requestId,
      error,
    });
    return json(500, { error: "Internal server error", requestId });
  }
};

/**
 * Create the router's request handler
 * @param config - Compiled routes, container, CORS and middleware configuration
 * @returns Fetch-style request handler
 */
export function createRequestHandler(
  config: PipelineConfig,
): (req: Request) => Promise<Response> {
  return (req) =>
    runSafely(() => {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return Promise.resolve(handlePreflight(req, url.pathname, config));
      }

      const match = findRoute(req.method, url.pathname, config);
      if (!match) {
        return Promise.resolve(handleUnmatched(req, url.pathname, config));
      }

      return handleMatched(
        req,
        url,
        match as typeof match & {
          route: PipelineRoute;
        },
        config,
      );
    }, config.container);
}
