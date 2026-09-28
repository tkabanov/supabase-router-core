# supabase-router

[![JSR](https://jsr.io/badges/@supabase-router/core)](https://jsr.io/@supabase-router/core)
[![JSR Score](https://jsr.io/badges/@supabase-router/core/score)](https://jsr.io/@supabase-router/core)

Type-safe routing framework for Supabase Edge Functions (and other Deno-based
runtimes) with built-in Supabase authentication, DTO validation, and OpenAPI
documentation generation.

## Features

- **Security hardening** - Fail-closed auth and RBAC, path traversal and
  prototype pollution protection, strict CORS allowlists, constant-time key
  comparison, generic error responses
- **Generic types** - Bring your own role system and user type
- **Automatic validation** - Zod-based DTO validation with readable error
  details
- **Built-in authentication** - Supabase Auth by default, with flexible RBAC
- **OpenAPI generation** - `router.openapi()` builds the spec from your routes
- **Middleware support** - Composable request/response middleware
- **Type-safe handlers** - Full type inference from schemas to handlers
- **Dependency injection** - Easy testing and service injection
- **Lightweight core** - Minimal runtime deps with optional Drizzle-based DB
  access

## Installation

### From JSR (Recommended)

```typescript
// Direct import
import { defineRoute, defineRouter } from "jsr:@supabase-router/core@2.0.0";
```

Or add to `deno.json` (the library requires Zod 4):

```json
{
  "imports": {
    "@supabase-router/core": "jsr:@supabase-router/core@^2.0.0",
    "zod": "npm:zod@^4.6.5"
  }
}
```

Then import:

```typescript
import { defineRoute, defineRouter } from "@supabase-router/core";
```

### Local Development

```typescript
// Import from local path
import { defineRoute, defineRouter } from "../_shared/router/mod.ts";
```

## Quick Start

### 1. Define your types

```typescript
// types.ts
export enum ProjectRoles {
  ADMIN = "admin",
  USER = "user",
  GUEST = "guest",
}

// Shape of the user built by the default auth handler: the token's
// `app_metadata` (e.g. `role`) plus `id` and `email`
export interface MyUser {
  id: string;
  email?: string;
  role?: ProjectRoles;
}
```

### 2. Create a router

```typescript
import { created, defineRoute, defineRouter } from "@supabase-router/core";
import { z } from "zod";
import { type MyUser, ProjectRoles } from "./types.ts";

const createProjectSchema = z.object({
  name: z.string().min(1),
  ownerEmail: z.email(),
  visibility: z.enum(["private", "public"]),
});

const router = defineRouter<ProjectRoles, MyUser>({
  basePath: "/api/v1",
  defaultTags: ["API"], // optional

  // No authHandler: the built-in Supabase auth is used. Optionally load the
  // user (and its role) from your own table instead of `app_metadata`:
  // userLoader: async (userId, supabase) => { ... },

  routes: [
    defineRoute({
      method: "GET",
      path: "/health",
      summary: "Health check",
      authRequired: false, // routes are authenticated unless set to false
      handler: async () => ({ status: "ok" }),
    }),

    defineRoute({
      method: "POST",
      path: "/projects",
      summary: "Create project (admin only)",
      description: "Creates a new project",

      // Authentication is on by default; allowedRoles adds RBAC
      allowedRoles: [ProjectRoles.ADMIN],

      // Automatic validation
      requestSchema: {
        body: createProjectSchema,
      },

      // Fully typed handler
      handler: async ({ body, user, supabaseClient }) => {
        // body is typed as z.infer<typeof createProjectSchema>
        // user is typed as MyUser, with role ADMIN
        // supabaseClient is scoped to the user, so RLS applies
        const { data, error } = await supabaseClient
          .from("projects")
          .insert({ ...body, created_by: user.id })
          .select()
          .single();

        if (error) throw error; // logged, client gets a generic 500
        return created(data);
      },
    }),
  ],
});

// Serve the router
if (import.meta.main) {
  Deno.serve(router.handler);
}
```

### 3. Generate OpenAPI docs

```typescript
const spec = router.openapi(); // OpenAPI document built from your routes
console.log(JSON.stringify(spec, null, 2));
```

See [OpenAPI Documentation](#openapi-documentation) for serving it.

## Core Concepts

### Routes

Routes are defined with `defineRoute()` and provide full type safety:

```typescript
defineRoute({
  method: "GET", // HTTP method
  path: "/users/:id", // Path with parameters
  summary: "Get user", // OpenAPI summary
  description: "...", // OpenAPI description
  allowedRoles: [ProjectRoles.ADMIN], // RBAC (auth is on by default)

  requestSchema: {
    params: z.object({ id: z.uuid() }),
    query: z.object({ include: z.string().optional() }),
  },

  responseSchema: z.object({ id: z.string(), include: z.string().optional() }),

  handler: async ({ params, query }) => {
    // params.id is typed as string
    // query.include is typed as string | undefined
    return { id: params.id, include: query.include };
  },
});
```

The router infers full types for `params`, `query`, `body`, and `user`
automatically from your Zod schemas and the router's generics
(`defineRouter<Role, User>`), so handler destructuring works without manual
annotations. Without the generics, `user` is typed as `unknown`.

- Routes require authentication by default (`authRequired` defaults to
  `true`). Public routes must set `authRequired: false`; there `user` is not
  available and `supabaseClient` is an optional anonymous client
  (`SupabaseClient | undefined`).
- Handlers return plain data (sent as JSON with `successResponseCode`, default
  `200`) or a `Response`.
- Static segments take precedence over parameters (`/users/me` before
  `/users/:id`), `HEAD` is served by the matching `GET` route, and an unknown
  method on a known path returns `405` with an `Allow` header.

### Authentication

The router includes **built-in Supabase authentication** - you don't need to
provide a custom `authHandler` unless you have special requirements!

#### Built-in Authentication (Default)

If you don't provide an `authHandler`, the router automatically uses Supabase
Auth:

```typescript
const router = defineRouter<ProjectRoles, MyUser>({
  basePath: "/api",
  // No authHandler needed!

  // Optional: load the user and role from your own table
  userLoader: async (userId, supabase) => {
    const { data } = await supabase
      .from("profiles")
      .select("id, email, role")
      .eq("id", userId)
      .single();
    return data as MyUser | null;
  },

  routes: [
    defineRoute({
      method: "GET",
      path: "/profile",
      // Authenticated by default: validates the Bearer token
      handler: async ({ user, supabaseClient }) => {
        // supabaseClient is user-scoped and respects RLS
        const { data } = await supabaseClient.from("settings").select();
        return { userId: user.id, settings: data };
      },
    }),
  ],
});
```

**Requirements:**

- Environment variables: `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEYS`
  (plus `SUPABASE_SECRET_KEYS` for secret-key routes). Hosted Edge Functions
  provision them automatically; locally the CLI provides
  `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY`. The legacy
  `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` are still accepted, but
  Supabase deprecates them by the end of 2026.
- Set `verify_jwt = false` for the function in `supabase/config.toml`: the
  router does its own verification, and secret-key callers send no user JWT.
- For RBAC, users need a `role` in **`app_metadata`** (set server-side, e.g.
  `supabase.auth.admin.updateUserById(id, { app_metadata: { role: "admin" } })`),
  or provide a `userLoader` that loads the user and role from your own table.
  `user_metadata` is never used for `id`, `email` or `role`: every user can
  edit it via `auth.updateUser`, so trusting it would allow privilege
  escalation. It is still available as `user.user_metadata`.
- Send requests with: `Authorization: Bearer <user_access_token>`

**What it does:**

1. Verifies the Bearer token with `auth.getClaims()`. With asymmetric JWT
   signing keys (ES256/RS256, the Supabase default) the signature is checked
   locally against `SUPABASE_JWKS` / the project's JWKS endpoint, without a
   request to the Auth server. Legacy HS256 projects fall back to the Auth
   server. Trade-off: a signed-out session stays valid until its access token
   expires; set `tokenVerification: "auth-server"` on the router to check every
   token with `auth.getUser()` instead.
2. Builds the user from `app_metadata` plus `id`, `email`, `user_metadata` and
   `is_anonymous` (or calls `userLoader(userId, client)`)
3. Checks RBAC if `allowedRoles` specified
4. Provides `user` and a user-scoped `supabaseClient` to handlers (RLS active)

#### Custom Authentication

For custom logic, provide an `authHandler` (`userLoader` and
`tokenVerification` are then ignored):

```typescript
import { createClient } from "@supabase/supabase-js";
import {
  type AuthOptions,
  defineRouter,
  parseBearerToken,
  unauthorized,
} from "@supabase-router/core";

const router = defineRouter<ProjectRoles, MyUser>({
  basePath: "/api",

  // Custom auth handler
  authHandler: async (req: Request, options: AuthOptions<ProjectRoles>) => {
    const token = parseBearerToken(req.headers.get("Authorization"));

    if (options.requireServiceRole) {
      // Check your service credentials here
    }

    // requireUserAuth defaults to true: a result without `user` is rejected
    // with 401 unless the route sets `requireUserAuth: false`.
    // RBAC (`allowedRoles`) is checked by the router afterwards and always
    // requires a user.
    const user = token ? await validateUser(token) : null; // your logic
    if (!user) {
      return { response: unauthorized("Invalid token") };
    }
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    );
    return { user, supabaseClient };
  },

  routes: [],
});
```

#### Secret Key (Service Role) and Publishable Key (Anon)

⚠️ **SECURITY WARNING**: `requireServiceRole` should **NEVER** be used for
frontend-accessible endpoints. Secret (service role) keys bypass Row Level
Security (RLS) and have full database access. Only use this for
internal/admin operations or server-to-server communication. The router logs
a warning once via `services.logger` when it is created with such a route.

Send secret keys on the `apikey` header (recommended by Supabase); the router
also accepts them, and legacy `service_role` JWTs, on
`Authorization: Bearer`. The secret key skips the user and RBAC checks.

```typescript
// Secret key endpoint (internal use ONLY - never expose to frontend!)
defineRoute({
  method: "POST",
  path: "/internal/cleanup",
  authentication: {
    requireServiceRole: true,
  },
  handler: async ({ serviceRoleClient }) => {
    // Only accessible with a secret key:
    //   apikey: sb_secret_...
    // serviceRoleClient is already elevated
    await serviceRoleClient!
      .from("sessions")
      .delete()
      .lt("expires_at", new Date().toISOString());
    return { ok: true };
  },
});

// Secret key OR user token
defineRoute({
  method: "GET",
  path: "/reports",
  authentication: {
    bypassWithServiceRole: true,
  },
  handler: async ({ user, supabaseClient, serviceRoleClient }) => {
    // With the secret key, serviceRoleClient is set and `user` is undefined
    // (despite its type), so check serviceRoleClient first
    if (serviceRoleClient) {
      return { caller: "service" };
    }
    // Otherwise a user token was sent: supabaseClient is user-scoped (RLS)
    const { data } = await supabaseClient.from("reports").select();
    return { caller: user.id, reports: data };
  },
});

// Publishable (anon) key OR user token
defineRoute({
  method: "GET",
  path: "/catalog",
  authentication: {
    bypassWithAnonRole: true,
  },
  handler: async ({ user }) => {
    // Accepts a publishable/anon key on `apikey` or `Authorization`. These
    // keys ship with every frontend, so the route is effectively public:
    // `user` is undefined for key-only callers, and RBAC rejects them.
    // A valid user token still takes precedence.
    return { signedIn: Boolean(user) };
  },
});
```

#### Per-route auth configuration

```typescript
defineRoute({
  method: "PUT",
  path: "/moderation/:id",
  authentication: {
    requireUserAuth: true, // default
    requireRBAC: true,
    allowedRoles: [ProjectRoles.ADMIN, ProjectRoles.USER],
  },
  handler: async ({ user }) => {
    // user is guaranteed to exist and have a required role
    return { moderator: user.id };
  },
});
```

`allowedRoles` on the route is a shorthand for `requireRBAC` +
`authentication.allowedRoles`. RBAC always needs a user and fails closed.

### Validation

Automatic DTO validation with Zod 4:

```typescript
defineRoute({
  method: "POST",
  path: "/signup",
  authRequired: false,
  requestSchema: {
    body: z.object({
      email: z.email(),
      age: z.number().min(18),
    }),
  },
  handler: async ({ body }) => {
    // body is typed and validated
    // If validation fails, returns 400 with details
    return { email: body.email };
  },
});
```

Malformed JSON returns `400 Malformed request body`; an unsupported
`Content-Type` returns `415`. Handlers receive the parsed schema output (e.g.
`z.coerce.number()` yields a number).

#### Multi-content-type support

```typescript
defineRoute({
  method: "POST",
  path: "/uploads",
  requestSchema: {
    body: {
      "application/json": jsonSchema,
      "multipart/form-data": formDataSchema,
    },
  },
  handler: async ({ body }) => {
    // body is parsed based on Content-Type
    return { received: body };
  },
});
```

#### Disable validation (for custom logic)

```typescript
defineRoute({
  method: "POST",
  path: "/webhook",
  disableDTOValidation: true,
  handler: async ({ req }) => {
    // Parse and validate manually
    const body = await req.json();
    return { received: body };
  },
});
```

### Middleware

Middleware can be applied globally or per-route:

```typescript
import {
  defineRouter,
  loggingMiddleware,
  timingMiddleware,
} from "@supabase-router/core";

const router = defineRouter({
  basePath: "/api",

  // Global middlewares
  middlewares: [
    loggingMiddleware({ logBody: false }),
    timingMiddleware(),
  ],

  routes: [],
});
```

**Execution order:**

```
route match → global middlewares → auth → params → query → body → db
            → route middlewares → handler
```

- CORS preflights (`OPTIONS`), unmatched paths (`404`) and unknown methods
  (`405`) are answered **before** global middlewares run.
- **Global** middlewares wrap the rest of the pipeline, so rate limiting, body
  size limits, timeouts and error handling also cover unauthenticated and
  invalid requests. `ctx.user`, `ctx.body` and `ctx.db` are populated only
  after `await next()`.
- **Route** middlewares run right before the handler; `ctx.user`,
  `ctx.supabaseClient`, `ctx.serviceRoleClient`, `ctx.body` and `ctx.db` are
  available.
- Unhandled errors are logged via `services.logger` and returned as a generic
  `500 { error: "Internal server error", requestId }`.

#### Rate Limiting

Edge Functions run many short-lived instances, so rate limits must live in a
shared store; the package has no in-memory limiter. Copy
`examples/redis-rate-limit.ts` into your project (replace its `../mod.ts`
import with `@supabase-router/core`). It wraps
[`@upstash/ratelimit`](https://github.com/upstash/ratelimit-js) (atomic sliding
window over HTTP Redis, as recommended by Supabase):

```typescript
import { defineRoute } from "@supabase-router/core";
import { createUpstashLimiter, rateLimit } from "./redis-rate-limit.ts";

// Reads UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
const limiter = createUpstashLimiter(10, "10 s");

defineRoute({
  method: "POST",
  path: "/messages",
  // Route middleware: runs after auth, so it can limit per user
  middlewares: [
    rateLimit({ limiter, key: (ctx) => (ctx.user as { id: string }).id }),
  ],
  handler: () => Promise.resolve({ sent: true }),
});
```

- Limited requests get `429` with `Retry-After` and `X-RateLimit-*` headers.
- If Redis is unavailable, requests pass (`failOpen: true`, logged); set
  `failOpen: false` to answer `503`.
- As a global middleware it also protects authentication, but `ctx.user` is not
  set yet there. Only key by IP using the header entry your platform's proxy
  guarantees: clients can add their own `x-forwarded-for` values.

#### Custom middleware

```typescript
import type { Middleware } from "@supabase-router/core";

const requestLogger: Middleware = async (ctx, next) => {
  ctx.services.logger.log(`Request: ${ctx.req.method} ${ctx.req.url}`);

  const response = await next();

  ctx.services.logger.log(`Response: ${response.status} (${ctx.requestId})`);
  return response;
};
```

### Error Handling

Built-in error response helpers:

```typescript
import { defineRoute, notFound } from "@supabase-router/core";

defineRoute({
  method: "GET",
  path: "/projects/:id",
  requestSchema: { params: z.object({ id: z.uuid() }) },
  handler: async ({ params, supabaseClient }) => {
    const { data } = await supabaseClient
      .from("projects")
      .select()
      .eq("id", params.id)
      .maybeSingle();

    if (!data) {
      return notFound("Project not found");
    }

    return data;
  },
});
```

Also available: `ok`, `created`, `noContent`, `badRequest`, `unauthorized`,
`forbidden`, `methodNotAllowed`, `unprocessableEntity`, `internalServerError`.
Error messages are sanitized (control characters removed, length limited) and
returned as JSON with `X-Content-Type-Options: nosniff`; they are not
HTML-escaped, so escape them if you render them as HTML.

Unhandled errors return a generic `500` with a `requestId`; details only go to
`services.logger`. `errorHandlerMiddleware(isDevelopment)` and
`createErrorResponseByEnv(error, isDevelopment)` include the real message (and
stack) only when `isDevelopment` is `true`, and a generic message otherwise.

### CORS

Configure CORS globally or per-route:

```typescript
const router = defineRouter({
  basePath: "/api",

  // Global CORS (applies to every route)
  corsHeaders: {
    allowedOrigins: ["https://example.com", "https://app.example.com"],
    allowedMethods: ["GET", "POST", "PUT", "DELETE"],
    // allowedHeaders omitted: defaults cover the supabase-js headers
    credentials: true,
  },

  routes: [
    defineRoute({
      method: "GET",
      path: "/public",
      authRequired: false,

      // Route-specific CORS: replaces the router config for this route
      corsHeaders: {
        allowedOrigins: "*",
      },

      handler: async () => ({ ok: true }),
    }),
  ],
});
```

- Without any configuration, permissive defaults (`*`) are used.
- A route-level `corsHeaders` **replaces** (does not merge with) the router
  config.
- If `allowedHeaders` is omitted, the default list is used: `authorization`,
  `x-client-info`, `apikey`, `content-type`, `x-retry-count`, `traceparent`,
  `tracestate`, `baggage` (what supabase-js sends). If you set it, include
  those headers.
- Allowlisted origins are echoed back with `Vary: Origin`; other origins get
  no `Access-Control-Allow-Origin`. `allowedOrigins: "*"` with
  `credentials: true` throws when the router is created.
- Note: the **local** Supabase gateway answers CORS preflights itself, so
  test preflight behaviour against a deployed function.

## Dependency Injection

The router includes a lightweight dependency injection system for better
testability and flexibility.

### Built-in Services

Every handler has access to core services via the `services` property:

```typescript
defineRoute({
  method: "GET",
  path: "/services",
  handler: async ({ services }) => {
    // Logger
    services.logger.log("Processing request");

    // ID Generator
    const id = services.idGenerator.generate();

    // Environment Variables
    const apiKey = services.env.get("API_KEY");

    // Cached Supabase clients (publishable key / secret key)
    const anonClient = services.getOrCreateAnonClient();

    return { id, hasApiKey: Boolean(apiKey), anon: Boolean(anonClient) };
  },
});
```

### Custom Services

Inject your own services (email, payment, analytics, etc.):

```typescript
import {
  createContainer,
  defineRoute,
  defineRouter,
  type ServiceContainer,
} from "@supabase-router/core";

// 1. Define service interface
interface EmailService {
  sendEmail(to: string, subject: string): Promise<void>;
}

// 2. Implement service
class SendGridService implements EmailService {
  async sendEmail(to: string, subject: string) {
    // SendGrid implementation
  }
}

// 3. Extend container type
interface AppServices extends ServiceContainer {
  emailService: EmailService;
}

// 4. Create container with your services
const container: AppServices = createContainer({
  emailService: new SendGridService(),
});

// 5. Pass to router (third generic = container type)
const router = defineRouter<ProjectRoles, MyUser, AppServices>({
  basePath: "/api",
  container, // Inject custom services
  routes: [
    // 6. Use in handlers
    defineRoute({
      method: "POST",
      path: "/welcome",
      handler: async ({ services, user }) => {
        await services.emailService.sendEmail(user.email!, "Welcome!");
        return { sent: true };
      },
    }),
  ],
});
```

### Testing with Mocks

The main benefit is easy testing:

```typescript
import { createContainer, defineRouter } from "@supabase-router/core";

const testContainer = createContainer({
  // Mock email service
  emailService: {
    sendEmail: async (to: string, subject: string) => {
      console.log(`[TEST] Email to ${to}: ${subject}`);
    },
  },

  // Silent logger for tests
  logger: {
    log: () => {},
    error: () => {},
    warn: () => {},
  },
});

const router = defineRouter({
  basePath: "/api",
  container: testContainer,
  routes: [],
});

// Now you can test without sending real emails!
```

**Learn more:** See [DEPENDENCY_INJECTION.md](./DEPENDENCY_INJECTION.md) for
complete guide with examples.

## Direct Database Access (Transaction Pooler)

Supabase Router can optionally expose a Drizzle-powered client that connects to
the Supabase **transaction pooler**. This keeps the serverless-friendly pooling
semantics while letting you issue SQL/ORM calls or wrap work in transactions.

### Opting in

```typescript
const router = defineRouter({
  basePath: "/api",
  database: {
    enableTransactionPooler: true,
    connectionStringEnv: "SUPABASE_DB_POOLER_URL", // default
    maxConnections: 4,
    // disablePreparedStatements defaults to true (required by the pooler)
  },
  routes: [],
});
```

Supply a connection string for the transaction pooler (from the Supabase
dashboard) via `SUPABASE_DB_POOLER_URL`. The router lazily loads `postgres` +
Drizzle on first use, creates a shared client and reuses it across requests.

**Statement timeouts:** transaction poolers (Supavisor on port 6543, PgBouncer)
drop connection parameters, so `statementTimeoutMs` has no effect through them
(the router logs a warning when it is not applied). Set the timeout on the
database role instead, which works through the pooler:

```sql
ALTER ROLE <role> SET statement_timeout = '10s';
```

### Using the client in routes

Routes opt in individually:

```typescript
import { sql } from "drizzle-orm";

defineRoute({
  method: "POST",
  path: "/reports/weekly",
  useDatabase: true,
  handler: async ({ db }) => {
    if (!db) throw new Response("Database unavailable", { status: 503 });

    await db.transaction(async (tx) => {
      // Replace with your queries / ORM calls
      await tx.execute(sql`select current_date`);
    });

    return { success: true };
  },
});
```

The `ctx.db` property is only populated when `useDatabase: true`. Route
middlewares receive the same `db` reference (enabling cross-cutting concerns
such as auditing); global middlewares only after `await next()`. If you
provide your own `getOrCreateDbClient` in the container, it may return the
client or a promise of it.

The pooler client connects as the role in your connection string and does
not carry the caller's JWT, so RLS policies based on `auth.uid()` do not
apply: authorize requests in your handler.

### Safety checklist

- Prefer the transaction pooler for stateless workloads; avoid long-lived
  transactions.
- Keep prepared statements disabled (the default) unless you connect in
  session mode.
- Set `statement_timeout` on the database role (see above) and keep
  `connectionTimeoutMs` conservative to prevent runaway queries from occupying
  the pool.
- Scope the database credentials to the minimum privileges required by these
  handlers.
- Log and monitor pool saturation (5xx responses with `"Database connection
  error"`) to tune `maxConnections`.
- The optional `drizzle-orm` and `postgres` dependencies are MIT licensed—
  include their license notices if you redistribute bundled assets.

## Security Features

- Fail-closed authentication: routes are authenticated by default,
  `requireUserAuth` defaults to `true`, RBAC always requires a user
- Default auth takes roles only from `app_metadata` or your `userLoader`,
  never `user_metadata`
- Constant-time comparison of API keys, strict `Bearer` parsing
- Path traversal, null byte and length checks on path parameters (before any
  regex matching)
- Prototype pollution protection for query parameters and form bodies
- CORS allowlists with `Vary: Origin`; wildcard + credentials is rejected
- Header name validation for configured CORS header lists
- Error messages sanitized and returned as JSON with `nosniff`; unhandled
  errors return a generic `500`
- Multipart file size limit (`DEFAULT_MAX_FILE_SIZE`, 10 MB)

Security headers are **not** added automatically. `DEFAULT_SECURITY_HEADERS`
(X-Content-Type-Options, X-Frame-Options, HSTS, CSP, ...) is exported so you
can apply it yourself, e.g. with a global middleware:

```typescript
import {
  DEFAULT_SECURITY_HEADERS,
  type Middleware,
} from "@supabase-router/core";

const securityHeaders: Middleware = async (_ctx, next) => {
  const response = await next();
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
```

## OpenAPI Documentation

### Generate documentation

`router.openapi()` returns an OpenAPI document built from your routes:

```typescript
const router = defineRouter({
  basePath: "/api",
  openapi: {
    title: "My API", // default: "API Documentation"
    version: "1.0.0", // default: "1.0.0"
    description: "API Documentation",
    servers: [
      { url: "http://localhost:54321/functions/v1", description: "Local" },
    ],
  },
  routes: [],
});

const spec = router.openapi();
```

- Request/response schemas are inlined per operation (generated with Zod's
  `toJSONSchema`); every path parameter is declared.
- Security schemes: `supabaseBearerAuth` (user token), `supabaseSecretKey` and
  `supabasePublishableKey` (`apikey` header), plus deprecated legacy bearer
  schemes. Routes are documented with the scheme(s) they accept; add your own
  with the `securitySchemes` router option or per-route `security`.

### Access documentation

The spec can be used with Swagger UI, Redoc, or other OpenAPI tools:

```typescript
Deno.serve((req) => {
  const url = new URL(req.url);

  if (url.pathname.endsWith("/openapi.json")) {
    return Response.json(router.openapi());
  }

  if (url.pathname.endsWith("/docs")) {
    // Render with Redoc
    return new Response(
      `<!DOCTYPE html>
      <html>
        <head>
          <title>API Docs</title>
          <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
        </head>
        <body>
          <redoc spec-url="openapi.json"></redoc>
        </body>
      </html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  }

  return router.handler(req);
});
```

### CLI (separate package)

A separate package, `@supabase-router/cli` (`efr`), offers multi-function
OpenAPI generation (`efr doc-gen` with an `openapi.config.ts`) and function
templates (`efr generate`). It is not part of `@supabase-router/core`; see
that package's own documentation.

## Testing

```bash
# Run all tests
deno task test

# Watch mode
deno task test:watch

# With coverage
deno task test:coverage
deno task coverage        # Generate LCOV report
deno task coverage:html   # Generate HTML report

# Integration tests against a throwaway local Supabase stack
# (requires Docker and the Supabase CLI)
deno task test:integration
deno task test:integration --alg RS256   # signing key algorithm (default ES256)
deno task test:integration --keep        # leave the stack running

# Everything CI runs (fmt, lint, type check, tests)
deno task ci
```

Unit and regression tests live in `tests/*_test.ts`. `test:integration` runs
`tests/integration/run.ts`, which starts a local Supabase stack, serves a
fixture Edge Function and runs `tests/integration/*_test.ts`. Set
`SUPABASE_CLI` to use another CLI build (e.g. `SUPABASE_CLI="npx -y
supabase@beta"`). Other tasks: `check`, `lint`, `lint:complexity`.

See [TESTING.md](./TESTING.md) for complete testing guide.

**For your application:**

```typescript
import { assertEquals } from "@std/assert";
import {
  createContainer,
  defineRoute,
  defineRouter,
  type SupabaseClient,
} from "@supabase-router/core";

const env: Record<string, string> = {
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
};

// Mock client: the default auth handler verifies tokens with auth.getClaims()
const mockClient = {
  auth: {
    getClaims: async (token: string) =>
      token === "valid-token"
        ? { data: { claims: { sub: "user-1", app_metadata: {} } }, error: null }
        : { data: null, error: { message: "Invalid JWT" } },
  },
} as unknown as SupabaseClient;

Deno.test("my endpoint works", async () => {
  const router = defineRouter<string, { id: string }>({
    basePath: "/api",
    container: createContainer({
      logger: { log: () => {}, error: () => {}, warn: () => {} },
      env: {
        get: (key) => env[key],
        require: (key) => env[key],
      },
      supabaseClientFactory: {
        create: () => mockClient,
        createWithToken: () => mockClient,
      },
    }),
    routes: [
      defineRoute({
        method: "GET",
        path: "/me",
        handler: async ({ user }) => ({ id: user.id }),
      }),
    ],
  });

  const response = await router.handler(
    new Request("http://localhost/api/me", {
      headers: { Authorization: "Bearer valid-token" },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { id: "user-1" });
});
```

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or pull request.

## Support

For issues, questions, or contributions, please open an issue on GitHub.
