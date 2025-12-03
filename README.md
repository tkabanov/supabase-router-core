# supabase-router

[![JSR](https://jsr.io/badges/@supabase-router/core)](https://jsr.io/@supabase-router/core)
[![JSR Score](https://jsr.io/badges/@supabase-router/core/score)](https://jsr.io/@supabase-router/core)

Type-safe routing framework for Edge Functions (Supabase, Deno Deploy,
Cloudflare Workers) with automatic authentication, DTO validation, and OpenAPI
documentation generation.

## Features

- **Security hardening** - Built-in protection against OWASP Top 10
  vulnerabilities
- **Generic types** - Bring your own role system and user type
- **Automatic validation** - Zod-based DTO validation with beautiful error
  messages
- **Built-in authentication** - Automatic auth with flexible RBAC
- **OpenAPI generation** - Auto-generated API documentation
- **Middleware support** - Composable request/response middleware
- **Type-safe handlers** - Full type inference from schemas to handlers
- **Dependency injection** - Easy testing and service injection
- **Lightweight core** - Minimal runtime deps with optional Drizzle-based DB access

## Installation

### From JSR (Recommended)

```typescript
// Direct import
import {
  defineRoute,
  defineRouter,
} from "jsr:@supabase-router/core@1.0.0";
```

Or add to `deno.json`:

```json
{
  "imports": {
    "@router": "jsr:@supabase-router/core@^1.0.0"
  }
}
```

Then import:

```typescript
import { defineRoute, defineRouter } from "@router";
```

### Local Development

```typescript
// Import from local path
import { defineRoute, defineRouter } from "../_shared/router/mod.ts";
```

## Quick Start

### 1. Define your types

```typescript
// roles.ts
export enum ProjectRoles {
  ADMIN = "admin",
  USER = "user",
  GUEST = "guest",
}

// types.ts
export interface MyUser {
  id: string;
  email: string;
  role: ProjectRoles;
  companyId: number;
}
```

### 2. Create a router

```typescript
import { defineRoute, defineRouter } from "@supabase-router/core";
import { z } from "zod";
import { MyUser, ProjectRoles } from "./types.ts";

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.email(),
  role: z.nativeEnum(ProjectRoles),
});

const router = defineRouter<ProjectRoles, MyUser>({
  basePath: "/api/v1",
  defaultTags: ["API"],

  // Custom authentication handler
  authHandler: async (req: Request, options: AuthOptions<MyRoles>) => {
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    // Your auth logic here
    return { user, supabaseClient };
  },

  routes: [
    defineRoute({
      method: "POST",
      path: "/users",
      summary: "Create user (admin only)",
      description: "Creates a new user in the system",

      // Automatic authentication + RBAC
      authRequired: true,
      allowedRoles: [ProjectRoles.ADMIN],

      // Automatic validation
      requestSchema: {
        body: createUserSchema,
      },

      // Fully typed handler
      handler: async ({ body, user, supabaseClient }) => {
        // body is typed as z.infer<typeof createUserSchema>
        // user is typed as MyUser
        // user.role is guaranteed to be ProjectRoles.ADMIN

        const newUser = await createUser(supabaseClient, body);
        return { success: true, user: newUser };
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

```bash
efr doc-gen
```

## Core Concepts

### Routes

Routes are defined with `defineRoute()` and provide full type safety:

```typescript
defineRoute({
  method: 'GET',              // HTTP method
  path: '/users/:id',         // Path with parameters
  summary: 'Get user',        // OpenAPI summary
  description: '...',         // OpenAPI description
  authRequired: true,         // Enable authentication
  allowedRoles: [Roles.ADMIN], // RBAC
  
  requestSchema: {
    params: z.object({ id: z.string() }),
    query: z.object({ include: z.string().optional() }),
    body: z.object({ ... })
  },
  
  responseSchema: z.object({ ... }),
  
  handler: async (ctx) => {
    // ctx.params.id is typed as string
    // ctx.query.include is typed as string | undefined
    // ctx.body is typed according to schema
    return { ... };
  }
})
```

The router infers full types for `params`, `query`, `body`, and `user`
automatically from your Zod schemas and authentication settings, so handler
destructuring works without manual annotations.

### Authentication

The router includes **built-in Supabase authentication** - you don't need to
provide a custom `authHandler` unless you have special requirements!

#### Built-in Authentication (Default)

If you don't provide an `authHandler`, the router automatically uses Supabase
Auth:

```typescript
const router = defineRouter({
  basePath: "/api",
  // No authHandler needed!
  routes: [
    defineRoute({
      method: "GET",
      path: "/profile",
      authRequired: true, // Automatically validates Bearer token
      handler: async ({ user, supabaseClient, services }) => {
        // supabaseClient is user-scoped and respects RLS
        // Access service-role capabilities explicitly when needed
        const serviceClient = services.getOrCreateServiceClient();
        return {
          userId: user.id,
          serviceClientAvailable: Boolean(serviceClient),
        };
      },
    }),
  ],
});
```

**Requirements:**

- Environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
  `SUPABASE_ANON_KEY`
- Users must have `role` field in `user_metadata` for RBAC
- Send requests with: `Authorization: Bearer <user_access_token>`

**What it does:**

1. Validates Bearer token using Supabase Auth API (service-role client is used
   internally only for verification)
2. Extracts user data from JWT
3. Checks RBAC if `allowedRoles` specified
4. Provides `user` and a user-scoped `supabaseClient` to handlers (RLS active)

#### Custom Authentication

For custom logic, provide an `authHandler`:

```typescript
const router = defineRouter<MyRoles, MyUser>({
  basePath: '/api',
  
  // Custom auth handler
  authHandler: async (req: Request, options: AuthOptions<MyRoles>) => {
    // Implement your auth logic
    const token = req.headers.get('Authorization');
    
    if (options.requireServiceRole) {
      // Check for service role
    }
    
    if (options.requireUserAuth) {
      const user = await validateUser(token);
      const client = createClient(...);
      return { user, supabaseClient: client };
    }
    
    return {}; // No auth
  },
  
  routes: [...]
});
```

#### Service Role and Anon Key

⚠️ **SECURITY WARNING**: `requireServiceRole` should **NEVER** be used for frontend-accessible endpoints.
Service role key bypasses Row Level Security (RLS) and has full database access.
Only use this for internal/admin operations or server-to-server communication.

The default auth handler supports service role and anon key bypass while keeping
request handlers RLS-first:

```typescript
// Service role endpoint (internal use ONLY - never expose to frontend!)
defineRoute({
  authentication: {
    requireServiceRole: true,
    requireUserAuth: false,
  },
  handler: async ({ serviceRoleClient }) => {
    // Only accessible with service role key
    // Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
    // serviceRoleClient is already elevated
    // ⚠️ WARNING: This endpoint will log a security warning when defined
  },
});

// Bypass with service role OR user token
defineRoute({
  authentication: {
    bypassWithServiceRole: true,
    requireUserAuth: true,
  },
  handler: async ({ user, supabaseClient, serviceRoleClient }) => {
    // Accessible with either service role OR user token
    // user-scoped supabaseClient maintains RLS, serviceRoleClient is available
    // only when a service token was provided.
  },
});
```

#### Per-route auth configuration

```typescript
defineRoute({
  authRequired: true,
  authentication: {
    allowedMethods: ["POST", "PUT"],
    requireUserAuth: true,
    requireRBAC: true,
    allowedRoles: [Roles.ADMIN, Roles.MODERATOR],
  },
  handler: async ({ user }) => {
    // user is guaranteed to exist and have required role
  },
});
```

### Validation

Automatic DTO validation with Zod:

```typescript
defineRoute({
  requestSchema: {
    body: z.object({
      email: z.string().email(),
      age: z.number().min(18),
    }),
  },
  handler: async ({ body }) => {
    // body is typed and validated
    // If validation fails, returns 400 with details
  },
});
```

#### Multi-content-type support

```typescript
defineRoute({
  requestSchema: {
    body: {
      "application/json": jsonSchema,
      "multipart/form-data": formDataSchema,
    },
  },
  handler: async ({ body }) => {
    // body is parsed based on Content-Type
  },
});
```

#### Disable validation (for custom logic)

```typescript
defineRoute({
  disableDTOValidation: true,
  handler: async ({ req }) => {
    // Parse and validate manually
    const body = await req.json();
    // ...
  },
});
```

### Middleware

Middleware can be applied globally or per-route:

```typescript
import { loggingMiddleware, timingMiddleware } from '@supabase-router/core';

const router = defineRouter({
  basePath: '/api',
  
  // Global middlewares
  middlewares: [
    loggingMiddleware({ logBody: false }),
    timingMiddleware()
  ],
  
  routes: [...]
});
```

Middleware contexts now expose `user`, `supabaseClient`, and
`serviceRoleClient` (when available), so permission-aware logic can run without
manual casts.

#### Rate Limiting

**WARNING: Production Rate Limiting**

The built-in `rateLimitMiddleware()` uses in-memory storage and **DOES NOT
WORK** in serverless environments with auto-scaling. It's only suitable for
local development.

For production, use one of these solutions:

1. **Cloudflare Rate Limiting** (Recommended if available)
   - Automatic, no code needed
   - Configure in Cloudflare dashboard

2. **Redis-based Rate Limiting** (For Supabase Edge Functions)

```typescript
import { Redis } from '@upstash/redis';
import { redisRateLimitMiddleware } from '../_shared/router/examples/redis-rate-limit.ts';

const redis = new Redis({
  url: Deno.env.get('UPSTASH_REDIS_URL')!,
  token: Deno.env.get('UPSTASH_REDIS_TOKEN')!,
});

const router = defineRouter({
  middlewares: [
    redisRateLimitMiddleware({
      redis,
      maxRequests: 100,
      windowMs: 60000, // 1 minute
    }),
  ],
  routes: [...]
});
```

See `examples/redis-rate-limit.ts` for complete implementation and setup
instructions.

#### Custom middleware

```typescript
const authMiddleware: Middleware = async (ctx, next) => {
  console.log(`Request: ${ctx.req.method} ${ctx.req.url}`);

  const response = await next();

  console.log(`Response: ${response.status}`);
  return response;
};
```

### Error Handling

Built-in error responses with sanitization:

```typescript
import { badRequest, notFound, unauthorized } from "@supabase-router/core";

defineRoute({
  handler: async ({ body }) => {
    if (!body.email) {
      return badRequest("Email is required");
    }

    const user = await findUser(body.email);
    if (!user) {
      return notFound("User not found");
    }

    return { user };
  },
});
```

### CORS

Configure CORS globally or per-route:

```typescript
const router = defineRouter({
  basePath: '/api',
  
  // Global CORS
  corsHeaders: {
    allowedOrigins: ['https://example.com', 'https://app.example.com'],
    allowedMethods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
  },
  
  routes: [
    defineRoute({
      path: '/public',
      
      // Route-specific CORS
      corsHeaders: {
        allowedOrigins: '*'
      },
      
      handler: async () => { ... }
    })
  ]
});
```

## Dependency Injection

The router includes a lightweight dependency injection system for better
testability and flexibility.

### Built-in Services

Every handler has access to core services via the `services` property:

```typescript
defineRoute({
  handler: async ({ services }) => {
    // Logger
    services.logger.log("Processing request");

    // ID Generator
    const id = services.idGenerator.generate();

    // Environment Variables
    const apiKey = services.env.get("API_KEY");

    // Supabase Client Factory (used internally)
    const client = services.supabaseClientFactory.create(url, key);

    return { id };
  },
});
```

### Custom Services

Inject your own services (email, payment, analytics, etc.):

```typescript
import { createContainer } from '@supabase-router/core';

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

// 5. Pass to router
const router = defineRouter({
  basePath: '/api',
  container, // Inject custom services
  routes: [...]
});

// 6. Use in handlers
defineRoute({
  handler: async ({ services }) => {
    const appServices = services as AppServices;
    await appServices.emailService.sendEmail('user@example.com', 'Welcome!');
  }
})
```

### Testing with Mocks

The main benefit is easy testing:

```typescript
import { createContainer } from '@supabase-router/core';

const testContainer = createContainer({
  // Mock email service
  emailService: {
    sendEmail: async (to, subject) => {
      console.log(`[TEST] Email to ${to}`);
    }
  },
  
  // Silent logger for tests
  logger: {
    log: () => {},
    error: () => {},
    warn: () => {}
  }
});

const router = defineRouter({
  basePath: '/api',
  container: testContainer,
  routes: [...]
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
  basePath: '/api',
  database: {
    enableTransactionPooler: true,
    connectionStringEnv: 'SUPABASE_DB_POOLER_URL',
    maxConnections: 4,
    statementTimeoutMs: 10_000,
    disablePreparedStatements: true, // Required for PgBouncer transaction mode
  },
  routes: [...]
});
```

Supply a connection string for the transaction pooler (from the Supabase
dashboard) via `SUPABASE_DB_POOLER_URL`. The router lazily initialises a shared
`postgres` driver + Drizzle instance and reuses it across requests.

### Using the client in routes

Routes opt in individually:

```typescript
defineRoute({
  method: 'POST',
  path: '/reports/weekly',
  useDatabase: true,
  handler: async ({ db }) => {
    if (!db) throw new Response('Database unavailable', { status: 503 });

    await db.transaction(async (tx) => {
      // Replace with your queries / ORM calls
      await tx.execute(sql`select current_date`);
    });

    return { success: true };
  },
});
```

The `ctx.db` property is only populated when `useDatabase: true`. Middlewares
receive the same `db` reference, enabling cross-cutting concerns such as
auditing.

### Safety checklist

- Prefer the transaction pooler for stateless workloads; avoid long-lived
  transactions.
- Keep `disablePreparedStatements: true` unless you know the pooler supports
  session-level prepared statements.
- Choose conservative timeouts (`statementTimeoutMs`, `connectionTimeoutMs`) to
  prevent runaway queries from occupying the pool.
- Scope the database credentials to the minimum privileges required by these
  handlers.
- Log and monitor pool saturation (5xx responses with `"Database connection
  error"`) to tune `maxConnections`.
- The optional `drizzle-orm` and `postgres` dependencies are MIT licensed—
  include their license notices if you redistribute bundled assets.

## Security Features

- Path traversal protection
- Prototype pollution protection
- XSS protection in error messages
- CORS security (no wildcard with credentials)
- Header injection protection
- Safe regex (no ReDoS)
- Input sanitization
- File upload size limits
- Security headers (X-Content-Type-Options, X-Frame-Options, etc.)

## OpenAPI Documentation

### Generate documentation

```bash
efr doc-gen
```

### Configuration

Create `openapi.config.ts` in your project root:

```typescript
export default {
  input: {
    include: ["supabase/functions/**/index.ts"],
    exclude: ["**/doc/**", "**/_shared/**"],
  },
  output: {
    path: "supabase/functions/openapi/schema.ts",
    format: "typescript", // or 'json', 'yaml'
  },
  spec: {
    openapi: "3.0.0",
    info: {
      title: "My API",
      version: "1.0.0",
      description: "API Documentation",
      contact: {
        name: "API Support",
        email: "support@example.com",
      },
    },
    servers: [
      { url: "http://localhost:54321/functions/v1", description: "Local" },
      { url: "https://api.prod.com/functions/v1", description: "Production" },
    ],
  },
};
```

### Access documentation

The generated schema can be used with Swagger UI, Redoc, or other OpenAPI tools:

```typescript
// doc/index.ts
import { schema } from "../openapi/schema.ts";

Deno.serve((req) => {
  const url = new URL(req.url);

  if (url.searchParams.get("json")) {
    return new Response(JSON.stringify(schema), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Render with Redoc
  return new Response(
    `
    <!DOCTYPE html>
    <html>
      <head>
        <title>API Docs</title>
        <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
      </head>
      <body>
        <div id="redoc"></div>
        <script>
          Redoc.init(${
      JSON.stringify(schema)
    }, {}, document.getElementById("redoc"))
        </script>
      </body>
    </html>
  `,
    { headers: { "Content-Type": "text/html" } },
  );
});
```

## Function Generator

Quickly create new functions from templates:

```bash
# Interactive mode
efr generate

# Or specify template directly
efr generate --name my-api --template authenticated
```

Available templates:

- **basic** - Public endpoints with validation
- **authenticated** - With Supabase auth and RBAC
- **crud** - Full Create/Read/Update/Delete API

See [CLI Documentation](../router-cli/CLI_README.md) for more details.

## Testing

The package includes comprehensive test coverage with 80%+ for critical modules.

```bash
# Run all tests
deno task test

# Watch mode
deno task test:watch

# Run by category
deno task test:unit
deno task test:integration
deno task test:e2e

# With coverage
deno task test:coverage
deno task coverage        # Generate LCOV report
deno task coverage:html   # Generate HTML report
```

**Test Structure:**

- **Unit tests** (70%) - Security, auth, validation, routing
- **Integration tests** (20%) - Full router, auth flow, DI
- **E2E tests** (10%) - CRUD workflows, security scenarios

See [TESTING.md](./TESTING.md) for complete testing guide.

**For your application:**

```typescript
import { createSilentTestContainer } from '../_shared/router/__tests__/helpers/test-containers.ts';

Deno.test('my endpoint works', async () => {
  const router = defineRouter({
    container: createSilentTestContainer(),
    routes: [...],
  });
  
  const response = await router.handler(request);
  assertEquals(response.status, 200);
});
```

## License

MIT

## Contributing

Contributions are welcome! Please read the contributing guidelines first.

## Support

For issues, questions, or contributions, please open an issue on GitHub.
