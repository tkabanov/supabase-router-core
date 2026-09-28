# Getting Started with supabase-router

Quick guide to building your first Supabase Edge Function with
`@supabase-router/core`.

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Your First Route](#your-first-route)
- [Adding Validation](#adding-validation)
- [Adding Authentication](#adding-authentication)
- [Adding Multiple Routes](#adding-multiple-routes)
- [Error Handling](#error-handling)
- [Direct Database Access (Optional)](#direct-database-access-optional)
- [Next Steps](#next-steps)

## Installation

Add the library and Zod 4 to your function's `deno.json` (for example
`supabase/functions/hello/deno.json`):

```json
{
  "imports": {
    "@supabase-router/core": "jsr:@supabase-router/core@^2.0.0",
    "zod": "npm:zod@^4.6.5"
  }
}
```

Or import directly:

```typescript
import { defineRoute, defineRouter } from "jsr:@supabase-router/core@^2.0.0";
```

## Configuration

**Environment variables.** The built-in authentication handler reads:

- `SUPABASE_URL` and a publishable key: `SUPABASE_PUBLISHABLE_KEYS` (JSON,
  auto-provisioned in Edge Functions) or `SUPABASE_PUBLISHABLE_KEY` (a single
  key you set yourself, e.g. when running locally outside the edge runtime).
- `SUPABASE_SECRET_KEYS` (or `SUPABASE_SECRET_KEY`), only for routes that accept
  the secret key (`requireServiceRole` / `bypassWithServiceRole`).
- `SUPABASE_JWKS` (optional, auto-provisioned in Edge Functions): user tokens
  are then verified locally instead of fetching the project's JWKS endpoint.

The legacy `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` are still accepted,
but Supabase deprecates them by the end of 2026. Public routes work without any
of these variables.

**Disable the gateway's JWT check.** The router authenticates requests itself
(user tokens, secret keys on the `apikey` header), so turn off `verify_jwt` for
the function in `supabase/config.toml`:

```toml
[functions.hello]
verify_jwt = false
```

## Your First Route

Create a simple "Hello World" function:

```typescript
// supabase/functions/hello/index.ts
import { defineRoute, defineRouter } from "@supabase-router/core";

const router = defineRouter({
  basePath: "/hello",
  routes: [
    defineRoute({
      method: "GET",
      path: "/", // matches /hello and /hello/
      summary: "Say hello",
      authRequired: false, // routes require a signed-in user by default
      handler: () => Promise.resolve({ message: "Hello, World!" }),
    }),
  ],
});

Deno.serve(router.handler);
```

The full path is `basePath` + `path`; a trailing slash is optional, so this
route answers both `/hello` and `/hello/`.

Test it:

```bash
# Start the local stack and serve all functions
npx supabase start
npx supabase functions serve

# Call it
curl http://localhost:54321/functions/v1/hello
# Output: {"message":"Hello, World!"}
```

## Adding Validation

Add request validation with Zod:

```typescript
import { defineRoute, defineRouter } from "@supabase-router/core";
import { z } from "zod";

const greetingSchema = z.object({
  name: z.string().min(1, "Name is required"),
  title: z.enum(["Mr", "Ms", "Dr"]).optional(),
});

const router = defineRouter({
  basePath: "/hello",
  routes: [
    defineRoute({
      method: "POST",
      path: "/greet",
      summary: "Personalized greeting",
      authRequired: false,
      requestSchema: {
        body: greetingSchema,
      },
      handler: ({ body }) => {
        // body is typed as { name: string; title?: "Mr" | "Ms" | "Dr" }
        const greeting = body.title
          ? `Hello, ${body.title} ${body.name}!`
          : `Hello, ${body.name}!`;

        return Promise.resolve({ message: greeting });
      },
    }),
  ],
});

Deno.serve(router.handler);
```

Test it:

```bash
# Valid request
curl -X POST http://localhost:54321/functions/v1/hello/greet \
  -H "Content-Type: application/json" \
  -d '{"name":"John","title":"Dr"}'
# Output: {"message":"Hello, Dr John!"}

# Invalid request (empty name) -> 400
curl -X POST http://localhost:54321/functions/v1/hello/greet \
  -H "Content-Type: application/json" \
  -d '{"name":""}'
# Output: {"error":"Validation failed","details":[{"path":["name"],"message":"Name is required"}]}
```

`requestSchema` also accepts `params` and `query` schemas. Handlers receive the
parsed output, so `z.coerce.number()` yields a number.

## Adding Authentication

Routes are authenticated by default (`authRequired` defaults to `true`). The
default auth handler verifies the `Authorization: Bearer <access token>` header
with `auth.getClaims()` and builds the user from the token: `id` and `email`
plus the fields of `app_metadata`. `user_metadata` is never used for roles
because users can edit it themselves.

```typescript
import { defineRoute, defineRouter } from "@supabase-router/core";

// Your application roles
enum UserRole {
  ADMIN = "admin",
  USER = "user",
}

// Shape of the user built by the default auth handler: id and email from the
// token, plus the fields of app_metadata (here: role)
interface User {
  id: string;
  email?: string;
  role?: UserRole;
}

const router = defineRouter<UserRole, User>({
  basePath: "/api",
  routes: [
    // Public route: opt out of authentication explicitly
    defineRoute({
      method: "GET",
      path: "/public",
      summary: "Public endpoint",
      authRequired: false,
      handler: () => Promise.resolve({ message: "This is public" }),
    }),

    // Authenticated route (the default)
    defineRoute({
      method: "GET",
      path: "/profile",
      summary: "Get user profile",
      handler: ({ user }) => {
        // user is guaranteed to exist here
        return Promise.resolve({ id: user.id, email: user.email });
      },
    }),

    // Admin-only route
    defineRoute({
      method: "DELETE",
      path: "/users/:id",
      summary: "Delete user (admin only)",
      allowedRoles: [UserRole.ADMIN],
      handler: async ({ params, supabaseClient }) => {
        // user.role is "admin"; supabaseClient runs as the user, so RLS applies
        const { error } = await supabaseClient
          .from("profiles")
          .delete()
          .eq("id", params.id);

        if (error) throw error;

        return { success: true };
      },
    }),
  ],
});

Deno.serve(router.handler);
```

Notes:

- The generics type the user: `defineRouter<Role, User>`. Without them `user` is
  `unknown`.
- Roles come from `app_metadata.role`, which only the server can set, e.g.
  `supabase.auth.admin.updateUserById(id, { app_metadata: { role: "admin" } })`
  with a secret key. To load users and roles from your own tables instead, pass
  `userLoader: (userId, supabaseClient) => ...` to `defineRouter`.
- Auth fails closed: an authenticated route needs a user (`401` otherwise), and
  `allowedRoles` rejects users without a matching role (`403`).
- In authenticated handlers `supabaseClient` is scoped to the user (RLS
  applies). On public routes it is the anonymous client, or `undefined` when
  `SUPABASE_URL` / a publishable key is not configured.

Test it:

```bash
# Public route (no auth needed)
curl http://localhost:54321/functions/v1/api/public
# Output: {"message":"This is public"}

# Protected route with a user's access token
curl http://localhost:54321/functions/v1/api/profile \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
# Output: {"id":"...","email":"user@example.com"}

# Without token -> 401
curl http://localhost:54321/functions/v1/api/profile
# Output: {"error":"Authorization header required"}

# Invalid or expired token -> 401
curl http://localhost:54321/functions/v1/api/profile \
  -H "Authorization: Bearer invalid"
# Output: {"error":"Invalid or expired token"}
```

From a frontend, `supabase.functions.invoke("api/profile", { method: "GET" })`
sends the signed-in user's token automatically.

## Adding Multiple Routes

Build a complete CRUD API:

```typescript
import {
  defineRoute,
  defineRouter,
  forbidden,
  notFound,
} from "@supabase-router/core";
import { z } from "zod";

enum UserRole {
  ADMIN = "admin",
  USER = "user",
}

interface User {
  id: string;
  email?: string;
  role?: UserRole;
}

const createItemSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  price: z.number().positive(),
});

const updateItemSchema = createItemSchema.partial();

const router = defineRouter<UserRole, User>({
  basePath: "/api",
  defaultTags: ["Items"], // optional OpenAPI tags for every route
  routes: [
    // List items (any signed-in user; RLS decides which rows are visible)
    defineRoute({
      method: "GET",
      path: "/items",
      summary: "List items",
      requestSchema: {
        query: z.object({
          page: z.coerce.number().int().min(1).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(10),
        }),
      },
      handler: async ({ query, supabaseClient }) => {
        // query is { page: number; limit: number } after parsing
        const offset = (query.page - 1) * query.limit;

        const { data, error } = await supabaseClient
          .from("items")
          .select("*")
          .range(offset, offset + query.limit - 1);

        if (error) throw error;

        return { items: data, page: query.page, limit: query.limit };
      },
    }),

    // Get a single item (public: no token needed)
    defineRoute({
      method: "GET",
      path: "/items/:id",
      summary: "Get item by ID",
      authRequired: false,
      handler: async ({ params, supabaseClient }) => {
        // On public routes supabaseClient is the anonymous client, or
        // undefined when SUPABASE_URL / a publishable key is not configured
        const { data, error } = await supabaseClient!
          .from("items")
          .select("*")
          .eq("id", params.id)
          .maybeSingle();

        if (error) throw error;
        if (!data) return notFound("Item not found");

        return { item: data };
      },
    }),

    // Create item
    defineRoute({
      method: "POST",
      path: "/items",
      summary: "Create item",
      successResponseCode: 201,
      requestSchema: {
        body: createItemSchema,
      },
      handler: async ({ body, user, supabaseClient }) => {
        const { data, error } = await supabaseClient
          .from("items")
          .insert({ ...body, user_id: user.id })
          .select()
          .single();

        if (error) throw error;

        return { item: data };
      },
    }),

    // Update item (owner or admin)
    defineRoute({
      method: "PUT",
      path: "/items/:id",
      summary: "Update item",
      requestSchema: {
        body: updateItemSchema,
      },
      handler: async ({ params, body, user, supabaseClient }) => {
        const { data: item } = await supabaseClient
          .from("items")
          .select("user_id")
          .eq("id", params.id)
          .maybeSingle();

        if (!item) return notFound("Item not found");
        if (item.user_id !== user.id && user.role !== UserRole.ADMIN) {
          return forbidden("Only the owner or an admin can update this item");
        }

        const { data, error } = await supabaseClient
          .from("items")
          .update(body)
          .eq("id", params.id)
          .select()
          .single();

        if (error) throw error;

        return { item: data };
      },
    }),

    // Delete item (admin only)
    defineRoute({
      method: "DELETE",
      path: "/items/:id",
      summary: "Delete item (admin only)",
      allowedRoles: [UserRole.ADMIN],
      handler: async ({ params, supabaseClient }) => {
        const { error } = await supabaseClient
          .from("items")
          .delete()
          .eq("id", params.id);

        if (error) throw error;

        return { success: true };
      },
    }),
  ],
});

Deno.serve(router.handler);
```

A plain object returned from a handler is sent as JSON with status 200 (or
`successResponseCode`). A wrong method on a known path returns `405` with an
`Allow` header; an unknown path returns `404`.

## Error Handling

Return (or throw) a `Response` to control the status code. The helpers build
JSON error responses:

```typescript
import {
  badRequest,
  defineRoute,
  defineRouter,
  notFound,
} from "@supabase-router/core";

const router = defineRouter({
  basePath: "/api",
  routes: [
    defineRoute({
      method: "GET",
      path: "/users/:id",
      handler: async ({ params, supabaseClient }) => {
        // Validate input
        if (!/^[0-9a-f-]{36}$/.test(params.id)) {
          return badRequest("Invalid user ID format");
        }

        const { data, error } = await supabaseClient
          .from("profiles")
          .select("*")
          .eq("id", params.id)
          .maybeSingle();

        if (error) throw error; // becomes a generic 500, details are logged
        if (!data) throw notFound("User not found"); // throwing works too

        return { user: data };
      },
    }),
  ],
});

Deno.serve(router.handler);
```

Returning a plain object such as `{ error: "Not found", status: 404 }` does
**not** set the status: it is sent as a `200` JSON body. Use the helpers.

Unhandled errors return
`500 {"error":"Internal server error","requestId":"..."}`; the details go to
`services.logger`, never to the client.

Available helpers (all return a `Response`; error bodies are
`{"error":"<message>"}`):

- `ok(data)` - 200 OK
- `created(data)` - 201 Created
- `noContent()` - 204 No Content
- `badRequest(message?, cause?)` - 400 Bad Request
- `unauthorized(message?, cause?)` - 401 Unauthorized
- `forbidden(message?, cause?)` - 403 Forbidden
- `notFound(message?, cause?)` - 404 Not Found
- `methodNotAllowed(message?, cause?)` - 405 Method Not Allowed
- `unprocessableEntity(message?, cause?)` - 422 Unprocessable Entity
- `internalServerError(message?, cause?)` - 500 Internal Server Error
- `createErrorResponseByEnv(error, isDevelopment)` - 500 with message and stack
  only in development

## Direct Database Access (Optional)

Need transactions or complex SQL? Enable a Drizzle client backed by the Supabase
transaction pooler (Supavisor, port `6543`). Add
`"drizzle-orm": "npm:drizzle-orm@^0.45.3"` to your imports for the `sql` tag.

```typescript
import {
  defineRoute,
  defineRouter,
  internalServerError,
} from "@supabase-router/core";
import { sql } from "drizzle-orm";

const router = defineRouter({
  basePath: "/api",
  database: {
    enableTransactionPooler: true,
    connectionStringEnv: "SUPABASE_DB_POOLER_URL", // the default
    maxConnections: 5,
    // disablePreparedStatements defaults to true (required by the pooler)
  },
  routes: [
    defineRoute({
      method: "POST",
      path: "/reports/weekly",
      allowedRoles: ["admin"],
      useDatabase: true,
      handler: async ({ db }) => {
        // Set whenever useDatabase is true; connection errors return 500 first
        if (!db) return internalServerError("Database unavailable");

        const rows = await db.transaction(async (tx) => {
          return await tx.execute(sql`select current_date as day`);
        });

        return { day: rows[0].day };
      },
    }),
  ],
});

Deno.serve(router.handler);
```

- Set `SUPABASE_DB_POOLER_URL` (e.g. with `supabase secrets set`) to the
  **Transaction pooler** connection string from the dashboard's Connect dialog.
- The client connects lazily on the first `useDatabase` request and is cached
  per instance. If you provide your own `getOrCreateDbClient` in the container,
  it may return the client or a promise of it.
- Transaction poolers drop connection startup parameters, so
  `statementTimeoutMs` has no effect through them (the router checks and logs a
  warning). Set the timeout on the database role instead:
  `ALTER ROLE <role> SET statement_timeout = '10s';` (the role from your
  connection string).
- Connection failures return `500 {"error":"Database connection error"}` and are
  logged; tune `maxConnections`, `idleTimeoutMs` and `connectionTimeoutMs` if
  needed.
- `db` runs as the role in the connection string (usually `postgres`, which
  bypasses RLS), not as the user, so check permissions in the route, e.g. with
  `allowedRoles`.

## Next Steps

### 1. Add Middleware

```typescript
import {
  defineRoute,
  defineRouter,
  loggingMiddleware,
  timingMiddleware,
} from "@supabase-router/core";

const router = defineRouter({
  basePath: "/api",
  // Global middlewares wrap the whole pipeline: they run before
  // authentication and body parsing
  middlewares: [loggingMiddleware(), timingMiddleware()],
  routes: [
    defineRoute({
      method: "GET",
      path: "/ping",
      authRequired: false,
      handler: () => Promise.resolve({ pong: true }),
    }),
  ],
});

Deno.serve(router.handler);
```

Route-level `middlewares` run right before the handler, after authentication and
validation. Other built-ins: `requestIdMiddleware`, `timeoutMiddleware`,
`bodySizeLimitMiddleware`, `errorHandlerMiddleware`. For rate limiting, copy
`examples/redis-rate-limit.ts` (Upstash Redis) into your project.

### 2. Generate API Documentation

Every router can produce an OpenAPI 3 document with `router.openapi()`:

```typescript
import { defineRoute, defineRouter } from "@supabase-router/core";

const router = defineRouter({
  basePath: "/api",
  openapi: {
    title: "Items API",
    version: "1.0.0",
    description: "Example API",
    servers: [{ url: "https://<project-ref>.supabase.co/functions/v1" }],
  },
  routes: [
    defineRoute({
      method: "GET",
      path: "/ping",
      authRequired: false,
      handler: () => Promise.resolve({ pong: true }),
    }),
  ],
});

// Serve the generated OpenAPI 3 document next to the API
Deno.serve((req) =>
  new URL(req.url).pathname === "/api/openapi.json"
    ? Promise.resolve(Response.json(router.openapi()))
    : router.handler(req)
);
```

Summaries, descriptions, tags, request schemas, `responseSchema` and security
requirements are taken from the route definitions.

A separate CLI package, `@supabase-router/cli` (`efr`), can generate docs from
your functions; it is not part of this library and is versioned independently:

```bash
deno install -g -Arf -n efr jsr:@supabase-router/cli
```

### 3. Keep Going

- [README.md](./README.md) - full feature overview and API reference
- [DEPENDENCY_INJECTION.md](./DEPENDENCY_INJECTION.md) - custom services and the
  service container
- [TESTING.md](./TESTING.md) - testing your routers without a Supabase project
- [`examples/`](./examples/) - runnable examples
