# Getting Started with Edge Function Router

Quick guide to building your first edge function with the router framework.

## Table of Contents

- [Installation](#installation)
- [Your First Route](#your-first-route)
- [Adding Validation](#adding-validation)
- [Adding Authentication](#adding-authentication)
- [Adding Multiple Routes](#adding-multiple-routes)
- [Error Handling](#error-handling)
- [Direct Database Access (Optional)](#direct-database-access-optional)
- [Next Steps](#next-steps)

## Installation

### From JSR (Recommended)

Add to your `deno.json`:

```json
{
  "imports": {
    "@router": "jsr:@supabase-router/core@^1.0.0",
    "zod": "npm:zod@3.23.8"
  }
}
```

### Or Use Direct Imports

```typescript
import {
  defineRoute,
  defineRouter,
} from "jsr:@supabase-router/core@1.0.0";
```

## Your First Route

Create a simple "Hello World" function:

```typescript
// supabase/functions/hello/index.ts
import { defineRoute, defineRouter } from "@router";

const router = defineRouter({
  basePath: "/hello",
  routes: [
    defineRoute({
      method: "GET",
      path: "/",
      summary: "Say hello",
      handler: async () => {
        return { message: "Hello, World!" };
      },
    }),
  ],
});

Deno.serve(router.handler);
```

> **Environment variables**
>
> The built-in authentication handler requires `SUPABASE_URL`,
> `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_ANON_KEY` to be present. The
> service-role key is used internally for token verification, while the anon key
> seeds user-scoped clients that keep Row Level Security enforced.

Test it:

```bash
# Start the function
npx supabase functions serve hello

# Call it
curl http://localhost:54321/functions/v1/hello
# Output: {"message":"Hello, World!"}
```

## Adding Validation

Add request validation with Zod:

```typescript
import { defineRoute, defineRouter } from "@router";
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
      requestSchema: {
        body: greetingSchema,
      },
      handler: async ({ body }) => {
        // body is typed as { name: string; title?: 'Mr' | 'Ms' | 'Dr' }
        const greeting = body.title
          ? `Hello, ${body.title} ${body.name}!`
          : `Hello, ${body.name}!`;

        return { message: greeting };
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

# Invalid request (name too short)
curl -X POST http://localhost:54321/functions/v1/hello/greet \
  -H "Content-Type: application/json" \
  -d '{"name":""}'
# Output: {"error":"Validation failed","details":[{"path":"name","message":"Name is required"}]}
```

## Adding Authentication

Protect routes with authentication:

```typescript
import { defineRoute, defineRouter } from "@router";
import { z } from "zod";

// Define your role enum
enum UserRole {
  ADMIN = "admin",
  USER = "user",
}

// Define your user type
interface User {
  id: string;
  email: string;
  role: UserRole;
}

const router = defineRouter<UserRole, User>({
  basePath: "/api",
  routes: [
    // Public route
    defineRoute({
      method: "GET",
      path: "/public",
      summary: "Public endpoint",
      handler: async () => {
        return { message: "This is public" };
      },
    }),

    // Authenticated route
    defineRoute({
      method: "GET",
      path: "/profile",
      summary: "Get user profile",
      authRequired: true,
      handler: async ({ user, supabaseClient, services }) => {
        // user is guaranteed to exist
        // supabaseClient respects RLS; request elevated access explicitly
        const serviceClient = services.getOrCreateServiceClient();
        return {
          id: user.id,
          email: user.email,
          canElevate: Boolean(serviceClient),
        };
      },
    }),

    // Admin-only route
    defineRoute({
      method: "DELETE",
      path: "/users/:id",
      summary: "Delete user (admin only)",
      authRequired: true,
      allowedRoles: [UserRole.ADMIN],
      handler: async ({ params, user, supabaseClient }) => {
        // user is guaranteed to be admin
        const { error } = await supabaseClient
          .from("users")
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

Handlers automatically receive typed `params`, `query`, `body`, and `user`
values derived from your Zod schemas and auth configuration—no extra generics or
casts required.

Test it:

```bash
# Public route (no auth needed)
curl http://localhost:54321/functions/v1/api/public
# Output: {"message":"This is public"}

# Protected route (needs auth token)
curl http://localhost:54321/functions/v1/api/profile \
  -H "Authorization: Bearer YOUR_TOKEN"
# Output: {"id":"...","email":"user@example.com"}

# Without token
curl http://localhost:54321/functions/v1/api/profile
# Output: {"error":"Authentication required"}
```

## Adding Multiple Routes

Build a complete CRUD API:

```typescript
import { defineRoute, defineRouter } from "@router";
import { z } from "zod";

enum UserRole {
  ADMIN = "admin",
  USER = "user",
}

interface User {
  id: string;
  email: string;
  role: UserRole;
}

const createItemSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  price: z.number().positive(),
});

const updateItemSchema = createItemSchema.partial();

const router = defineRouter<UserRole, User>({
  basePath: "/items",
  defaultTags: ["Items"],
  routes: [
    // List items
    defineRoute({
      method: "GET",
      path: "/",
      summary: "List all items",
      requestSchema: {
        query: z.object({
          page: z.string().optional(),
          limit: z.string().optional(),
        }),
      },
      handler: async ({ query, supabaseClient }) => {
        const page = parseInt(query.page || "1");
        const limit = parseInt(query.limit || "10");
        const offset = (page - 1) * limit;

        const { data, error } = await supabaseClient
          .from("items")
          .select("*")
          .range(offset, offset + limit - 1);

        if (error) throw error;

        return { items: data, page, limit };
      },
    }),

    // Get single item
    defineRoute({
      method: "GET",
      path: "/:id",
      summary: "Get item by ID",
      handler: async ({ params, supabaseClient }) => {
        const { data, error } = await supabaseClient
          .from("items")
          .select("*")
          .eq("id", params.id)
          .single();

        if (error) throw error;

        return { item: data };
      },
    }),

    // Create item (authenticated)
    defineRoute({
      method: "POST",
      path: "/",
      summary: "Create new item",
      authRequired: true,
      requestSchema: {
        body: createItemSchema,
      },
      handler: async ({ body, user, supabaseClient }) => {
        const { data, error } = await supabaseClient
          .from("items")
          .insert({
            ...body,
            user_id: user.id,
          })
          .select()
          .single();

        if (error) throw error;

        return { item: data };
      },
    }),

    // Update item (owner or admin)
    defineRoute({
      method: "PUT",
      path: "/:id",
      summary: "Update item",
      authRequired: true,
      requestSchema: {
        body: updateItemSchema,
      },
      handler: async ({ params, body, user, supabaseClient }) => {
        // Check ownership or admin
        const { data: item } = await supabaseClient
          .from("items")
          .select("user_id")
          .eq("id", params.id)
          .single();

        if (!item) {
          return { error: "Item not found", status: 404 };
        }

        if (item.user_id !== user.id && user.role !== UserRole.ADMIN) {
          return { error: "Forbidden", status: 403 };
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
      path: "/:id",
      summary: "Delete item (admin only)",
      authRequired: true,
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

## Error Handling

Use built-in error helpers:

```typescript
import {
  badRequest,
  defineRoute,
  defineRouter,
  notFound,
  unauthorized,
} from "@router";

const router = defineRouter({
  basePath: "/api",
  routes: [
    defineRoute({
      method: "GET",
      path: "/users/:id",
      handler: async ({ params, supabaseClient }) => {
        // Validate input
        if (!params.id.match(/^[0-9a-f-]+$/)) {
          return badRequest("Invalid user ID format");
        }

        // Fetch user
        const { data, error } = await supabaseClient
          .from("users")
          .select("*")
          .eq("id", params.id)
          .single();

        if (error) {
          if (error.code === "PGRST116") {
            return notFound("User not found");
          }
          throw error;
        }

        return { user: data };
      },
    }),
  ],
});
```

Available error helpers:

- `ok(data)` - 200 OK
- `created(data)` - 201 Created
- `noContent()` - 204 No Content
- `badRequest(message)` - 400 Bad Request
- `unauthorized(message)` - 401 Unauthorized
- `forbidden(message)` - 403 Forbidden
- `notFound(message)` - 404 Not Found
- `unprocessableEntity(message)` - 422 Unprocessable Entity
- `internalServerError(message)` - 500 Internal Server Error

## Direct Database Access (Optional)

Need transactions or complex SQL? You can enable a Drizzle client backed by the
Supabase transaction pooler.

```typescript
import { defineRoute, defineRouter } from "@router";
import { sql } from "drizzle-orm";

const router = defineRouter({
  basePath: "/api",
  database: {
    enableTransactionPooler: true,
    connectionStringEnv: "SUPABASE_DB_POOLER_URL",
    statementTimeoutMs: 10_000,
    disablePreparedStatements: true,
  },
  routes: [
    defineRoute({
      method: "POST",
      path: "/reports/weekly",
      useDatabase: true,
      handler: async ({ db }) => {
        if (!db) throw new Response("Database unavailable", { status: 503 });

        await db.transaction(async (tx) => {
          await tx.execute(sql`select current_date`);
        });

        return { success: true };
      },
    }),
  ],
});
```

Set `SUPABASE_DB_POOLER_URL` with the Transaction Pooler connection string from
the Supabase dashboard. Because PgBouncer runs in transaction mode, keep
`disablePreparedStatements: true`. Monitor for `"Database connection error"`
responses and tune `maxConnections`/timeouts if needed.

## Next Steps

### 1. Add Middleware

```typescript
import { loggingMiddleware, timingMiddleware } from '@router';

const router = defineRouter({
  basePath: '/api',
  middlewares: [
    loggingMiddleware(),
    timingMiddleware()
  ],
  routes: [...]
});
```

### 2. Generate Documentation

```bash
# Install CLI
deno install -Arf -n efr jsr:@supabase-router/cli@1.0.0

# Generate OpenAPI docs
efr doc-gen
```
