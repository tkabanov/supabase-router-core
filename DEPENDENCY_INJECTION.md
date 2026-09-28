# Dependency Injection Guide

Complete guide to the dependency injection (DI) system in Edge Function Router.

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
- [Built-in Services](#built-in-services)
- [Custom Services](#custom-services)
- [Testing with DI](#testing-with-di)
- [Advanced Patterns](#advanced-patterns)
- [Best Practices](#best-practices)

## Overview

The router includes a lightweight dependency injection system that makes your
code more testable and maintainable.

### Why Dependency Injection?

1. **Testability**: Easily mock services in tests
2. **Flexibility**: Swap implementations without changing code
3. **Maintainability**: Centralized service configuration
4. **Type Safety**: Full TypeScript support

## Core Concepts

### Service Container

The container holds all your services and provides them to route handlers:

```typescript
import { createContainer, defineRouter } from "@supabase-router/core";

// Create container with default services
const container = createContainer();

// Pass to router
const router = defineRouter({
  basePath: "/api",
  container,
  routes: [/* ... */],
});
```

`createContainer(overrides)` fills in every built-in service you do not
provide. Pass all overrides and custom services **to `createContainer`**:

```typescript
const container = createContainer({
  logger: customLogger, // override a built-in service
  emailService: new SendGridService(apiKey), // add a custom service
});
```

> **Pass overrides to `createContainer`** instead of spreading a container
> (`{ ...createContainer(), env: testEnv }`). A plain spread copies the built-in
> `getOrCreateAnonClient` / `getOrCreateServiceClient`, which still read the
> original container's `env` and `supabaseClientFactory`. `createContainer` (and
> `defineRouter`, which calls it) rebinds them, so a spread object only behaves
> correctly once it has gone through one of those.

### Accessing Services

Services are available in every route handler via the `services` property:

```typescript
defineRoute({
  method: "GET",
  path: "/ids",
  handler: async ({ services }) => {
    services.logger.log("Processing request");
    const id = services.idGenerator.generate();
    return { id };
  },
});
```

## Built-in Services

The router provides core services out of the box:

### 1. Logger

Logging functionality for debugging and monitoring:

```typescript
defineRoute({
  method: "POST",
  path: "/login",
  handler: async ({ services }) => {
    // Log informational message
    services.logger.log("User login attempt", "userId:", "123");

    // Log warning
    services.logger.warn("Rate limit approaching", "current:", 95);

    // Log error
    services.logger.error("Database connection failed", new Error("timeout"));

    return { success: true };
  },
});
```

**Interface:**

```typescript
interface Logger {
  log(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}
```

### 2. ID Generator

Generate unique identifiers:

```typescript
defineRoute({
  method: "POST",
  path: "/items",
  handler: async ({ services }) => {
    // Generate UUID
    const id = services.idGenerator.generate();

    return { id }; // "550e8400-e29b-41d4-a716-446655440000"
  },
});
```

**Interface:**

```typescript
interface IdGenerator {
  generate(): string;
}
```

### 3. Environment Provider

Access environment variables safely:

```typescript
defineRoute({
  method: "GET",
  path: "/config",
  handler: async ({ services }) => {
    // Get environment variable
    const apiKey = services.env.get("API_KEY");

    // Get with default value
    const timeout = services.env.get("TIMEOUT") ?? "30";

    // Require environment variable (throws if missing)
    const requiredKey = services.env.require("REQUIRED_KEY");

    if (!apiKey) {
      return badRequest("API_KEY not configured");
    }

    return { success: true, timeout, hasKey: !!requiredKey };
  },
});
```

**Interface:**

```typescript
interface EnvironmentProvider {
  get(key: string): string | undefined;
  require(key: string): string; // Throws if key not found
}
```

### 4. Supabase Client Factory

Create Supabase clients (used internally by auth and the cached clients):

```typescript
defineRoute({
  method: "GET",
  path: "/custom-client",
  handler: async ({ services }) => {
    // Usually you'll use the auto-injected supabaseClient
    // But you can create custom clients if needed:

    // Create client with URL and key
    const customClient = services.supabaseClientFactory.create(
      "https://custom.supabase.co",
      "sb_publishable_...",
    );

    // Create client with user token (for user-scoped access)
    const userClient = services.supabaseClientFactory.createWithToken(
      "https://custom.supabase.co",
      "sb_publishable_...",
      "user-access-token",
    );

    return { success: !!customClient && !!userClient };
  },
});
```

**Interface:**

```typescript
interface SupabaseClientFactory {
  create(url: string, key: string): SupabaseClient;
  createWithToken(
    url: string,
    publishableKey: string,
    token: string,
  ): SupabaseClient;
}
```

### 5. Cached Supabase Clients

The container provides cached client helpers for performance:

```typescript
defineRoute({
  method: "GET",
  path: "/clients",
  handler: async ({ services }) => {
    // Cached client for the publishable key (respects RLS)
    // (SUPABASE_PUBLISHABLE_KEYS → SUPABASE_PUBLISHABLE_KEY → legacy SUPABASE_ANON_KEY)
    const anonClient = services.getOrCreateAnonClient();

    // Cached admin client for the secret key (bypasses RLS)
    // (SUPABASE_SECRET_KEYS → SUPABASE_SECRET_KEY → legacy SUPABASE_SERVICE_ROLE_KEY)
    const serviceClient = services.getOrCreateServiceClient();

    // Database client (only if the transaction pooler is enabled; may be async)
    const dbClient = await services.getOrCreateDbClient?.();

    return { success: !!anonClient && !!serviceClient, hasDb: !!dbClient };
  },
});
```

Both helpers read `SUPABASE_URL` and the keys through `services.env` and create
clients with `services.supabaseClientFactory`, so overriding those two services
in `createContainer` also changes the cached clients. They throw if the URL or
key is missing.

**Note:** Clients are cached **per container** (not globally) to avoid creating
new clients on every request (5-8ms performance improvement). A cached client is
recreated if the resolved URL or key changes.

**Serverless Environment Behavior:**

- **Warm instances**: Cache works across multiple requests within the same
  instance
- **Cold starts**: Cache is reset when a new instance is initialized
- **Best practice**: Create the container once at module level (not
  per-request) so every request reuses the same cache

```typescript
// Good - container created once at module level
const container = createContainer({ logger: customLogger });
const router = defineRouter({ basePath: "/api", container, routes });

// Bad - container created per request (new cache every time)
Deno.serve((req) => {
  const container = createContainer({ logger: customLogger }); // New cache per request
  return defineRouter({ basePath: "/api", container, routes }).handler(req);
});
```

### 6. Database Client (Optional)

If you enable the transaction pooler in your router configuration, the
container provides a database client:

```typescript
const router = defineRouter({
  basePath: "/api",
  database: {
    enableTransactionPooler: true,
    connectionStringEnv: "SUPABASE_DB_POOLER_URL",
  },
  routes: [
    defineRoute({
      method: "POST",
      path: "/data",
      useDatabase: true,
      handler: async ({ db }) => {
        // db is available when useDatabase: true
        // (also reachable via `await services.getOrCreateDbClient?.()`)
        if (!db) {
          return internalServerError("Database unavailable");
        }

        await db.transaction(async (tx) => {
          // Use transaction
        });

        return { success: true };
      },
    }),
  ],
});
```

**Note:** `getOrCreateDbClient` is optional (`?`) because it's only available
when the transaction pooler is enabled. It may return a promise, so always
`await` it.

## Custom Services

Extend the container with your own services:

### Step 1: Define Service Interfaces

```typescript
// services/email.ts
export interface EmailService {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
  sendTemplate(
    to: string,
    template: string,
    data: Record<string, unknown>,
  ): Promise<void>;
}

// services/analytics.ts
export interface AnalyticsService {
  track(event: string, properties?: Record<string, unknown>): void;
}
```

### Step 2: Implement Service

```typescript
// services/sendgrid.ts
import type { EmailService } from "./email.ts";

export class SendGridService implements EmailService {
  constructor(private apiKey: string) {}

  async sendEmail(to: string, subject: string, body: string) {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: "noreply@example.com" },
        subject,
        content: [{ type: "text/plain", value: body }],
      }),
    });

    if (!response.ok) {
      throw new Error("Failed to send email");
    }
  }

  async sendTemplate(
    to: string,
    template: string,
    data: Record<string, unknown>,
  ) {
    // Template implementation
  }
}
```

### Step 3: Extend Container Type

```typescript
// container.ts
import type { ServiceContainer } from "@supabase-router/core";
import type { EmailService } from "./services/email.ts";
import type { AnalyticsService } from "./services/analytics.ts";

export interface AppServices extends ServiceContainer {
  emailService: EmailService;
  analyticsService: AnalyticsService;
}
```

### Step 4: Create Container

```typescript
// container.ts
import { createContainer } from "@supabase-router/core";
import { SendGridService } from "./services/sendgrid.ts";

export const createAppContainer = (): AppServices =>
  createContainer({
    emailService: new SendGridService(Deno.env.get("SENDGRID_API_KEY")!),
    analyticsService: {
      track: (event: string, properties?: Record<string, unknown>) =>
        console.log(event, properties),
    },
  });
```

`createContainer` returns `ServiceContainer & typeof overrides`, so it is
assignable to `AppServices` without a cast. Annotate callback parameters in the
overrides: the type is inferred from the argument, not from the return type.

### Step 5: Use in Routes

Pass `AppServices` as the third generic of `defineRouter` and `services` is
fully typed in every inline `defineRoute` (no casts needed):

```typescript
import { defineRoute, defineRouter } from "@supabase-router/core";
import { z } from "zod";
import { type AppServices, createAppContainer } from "./container.ts";

const router = defineRouter<AppRole, AppUser, AppServices>({
  basePath: "/api",
  container: createAppContainer(),
  routes: [
    defineRoute({
      method: "POST",
      path: "/register",
      authRequired: false, // routes are authenticated by default
      requestSchema: {
        body: z.object({
          email: z.email(),
          name: z.string(),
        }),
      },
      handler: async ({ body, services }) => {
        // services.emailService is typed as EmailService
        await services.emailService.sendEmail(
          body.email,
          "Welcome!",
          `Hello ${body.name}, welcome to our platform!`,
        );

        services.analyticsService.track("user_registered", {
          email: body.email,
        });

        return { success: true };
      },
    }),
  ],
});
```

## Testing with DI

The DI system makes testing easy. Export a function that builds the router from
a container, so tests can pass a container with mocks. Keep the routes inline
in `defineRouter<..., AppServices>` so `services` stays typed:

```typescript
// app.ts
export const createApp = (container: AppServices) =>
  defineRouter<AppRole, AppUser, AppServices>({
    basePath: "/api",
    container,
    routes: [
      // the inline defineRoute(...) calls from Step 5
    ],
  });

// index.ts
Deno.serve(createApp(createAppContainer()).handler);
```

### Basic Test Setup

```typescript
import { assertEquals } from "@std/assert";
import { createContainer } from "@supabase-router/core";
import { createApp } from "./app.ts";

Deno.test("registration - sends welcome email", async () => {
  const sent: string[] = [];

  // Pass mocks to createContainer (never spread a container)
  const testContainer = createContainer({
    emailService: {
      sendEmail: async (to: string) => {
        sent.push(to);
      },
      sendTemplate: async () => {},
    },
    analyticsService: { track: () => {} },
  });

  const router = createApp(testContainer);

  const response = await router.handler(
    new Request("http://localhost/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", name: "New" }),
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(sent, ["new@example.com"]);
});
```

### Mocking Supabase and Auth

Override `env` and `supabaseClientFactory` to control the cached clients and
the default auth handler. The default handler verifies tokens with
`auth.getClaims()` (it falls back to `auth.getUser()` when `getClaims` is
missing, or with `tokenVerification: "auth-server"`), so mocks should implement
`getClaims`:

```typescript
import type { SupabaseClient } from "@supabase-router/core";

const mockClient = {
  auth: {
    getClaims: async (token: string) =>
      token === "valid-token"
        ? {
          data: {
            claims: {
              sub: "user-123",
              email: "test@example.com",
              app_metadata: { role: "admin" },
              user_metadata: { name: "Test User" },
            },
          },
          error: null,
        }
        : { data: null, error: { message: "Invalid JWT" } },
  },
} as unknown as SupabaseClient;

const testEnv: Record<string, string> = {
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
};

const testContainer = createContainer({
  emailService: mockEmailService,
  analyticsService: { track: () => {} },
  env: {
    get: (key: string) => testEnv[key],
    require: (key: string) => testEnv[key],
  },
  supabaseClientFactory: {
    create: () => mockClient,
    createWithToken: () => mockClient,
  },
});
```

The default auth handler builds `user` from `id`, `email` and the
server-controlled `app_metadata` (e.g. `role`), or from your `userLoader`.
Roles are never read from `user_metadata`, which users can edit themselves.

### Silent Logger for Tests

```typescript
import { createContainer } from "@supabase-router/core";

const createSilentTestContainer = () =>
  createContainer({
    logger: {
      log: () => {},
      error: () => {},
      warn: () => {},
    },
  });
```

### Spy Pattern

```typescript
Deno.test("tracks analytics event", async () => {
  let trackedEvent: string | null = null;

  const container = createContainer({
    emailService: mockEmailService,
    analyticsService: {
      track: (event: string) => {
        trackedEvent = event;
      },
    },
  });

  const router = createApp(container);
  await router.handler(registerRequest);

  assertEquals(trackedEvent, "user_registered");
});
```

## Advanced Patterns

### Lazy Initialization

Containers are copied with object spread (by `createContainer` and again by
`defineRouter`), so a `get` accessor on a service is evaluated immediately. For
lazy initialization, expose a function instead:

```typescript
interface LazyAppServices extends ServiceContainer {
  getEmailService(): EmailService;
}

let emailService: EmailService | null = null;

export const createLazyAppContainer = (): LazyAppServices =>
  createContainer({
    getEmailService: () =>
      emailService ??= new SendGridService(Deno.env.get("SENDGRID_API_KEY")!),
  });

// In a handler: await services.getEmailService().sendEmail(...)
```

### Factory Pattern

```typescript
interface DatabaseService {
  getConnection(schema?: string): Promise<Connection>;
}

class DatabaseFactory implements DatabaseService {
  private connections = new Map<string, Connection>();

  async getConnection(schema: string = "public") {
    if (!this.connections.has(schema)) {
      const conn = await createConnection(schema);
      this.connections.set(schema, conn);
    }
    return this.connections.get(schema)!;
  }
}
```

### Service Composition

```typescript
class CompositeNotificationService {
  constructor(
    private email: EmailService,
    private sms: SMSService,
    private push: PushService,
  ) {}

  async notifyUser(userId: string, message: string) {
    await Promise.all([
      this.email.sendEmail(userId, "Notification", message),
      this.sms.send(userId, message),
      this.push.send(userId, message),
    ]);
  }
}
```

### Singleton Pattern

```typescript
class CacheService {
  private static instance: CacheService;
  private cache = new Map<string, unknown>();

  static getInstance() {
    if (!CacheService.instance) {
      CacheService.instance = new CacheService();
    }
    return CacheService.instance;
  }

  get(key: string) {
    return this.cache.get(key);
  }
  set(key: string, value: unknown) {
    this.cache.set(key, value);
  }
}
```

## Best Practices

### 1. Define Interfaces

Always define interfaces for your services:

```typescript
// Good
interface EmailService {
  sendEmail(to: string, subject: string): Promise<void>;
}

// Bad
class EmailService {
  async sendEmail(to: string, subject: string) { ... }
}
```

### 2. Keep Services Focused

Each service should have a single responsibility:

```typescript
// Good
interface EmailService { ... }
interface SMSService { ... }
interface PushService { ... }

// Bad
interface NotificationService {
  sendEmail(...): Promise<void>;
  sendSMS(...): Promise<void>;
  sendPush(...): Promise<void>;
}
```

### 3. Use Constructor Injection

Pass dependencies through constructors:

```typescript
// Good
class UserService {
  constructor(
    private email: EmailService,
    private db: DatabaseService,
  ) {}
}

// Bad
class UserService {
  private email = new EmailService(); // Hard-coded dependency
}
```

### 4. Mock in Tests

Always use mocks for external dependencies:

```typescript
// Good
const mockEmail = {
  sendEmail: async () => {/* mock */},
};

// Bad
// Using real EmailService in tests
```

### 5. Validate Configuration

Validate required environment variables at startup:

```typescript
export const createAppContainer = (): AppServices => {
  const apiKey = Deno.env.get("SENDGRID_API_KEY");
  if (!apiKey) {
    throw new Error("SENDGRID_API_KEY is required");
  }

  return createContainer({
    emailService: new SendGridService(apiKey),
    analyticsService: new ConsoleAnalyticsService(),
  });
};
```

### 6. Type Safety

Use TypeScript to enforce correct service usage:

```typescript
// Good
interface AppServices extends ServiceContainer {
  emailService: EmailService; // Type-safe
}
defineRouter<AppRole, AppUser, AppServices>({ ... }); // typed `services`

// Bad
const services: any = { ... }; // Loses type safety
```

### 7. Avoid Global State

Don't use global variables, use the container:

```typescript
// Bad
let globalEmailService: EmailService;

// Good
interface AppServices extends ServiceContainer {
  emailService: EmailService;
}
```

## Real-World Example

Complete example of a registration system with DI:

```typescript
// services.ts
import { createContainer, type ServiceContainer } from "@supabase-router/core";

export interface EmailService {
  sendWelcomeEmail(email: string, name: string): Promise<void>;
}

export interface AnalyticsService {
  trackEvent(event: string, properties: Record<string, unknown>): void;
}

export interface AppServices extends ServiceContainer {
  emailService: EmailService;
  analyticsService: AnalyticsService;
}

// Production implementation
export const createAppContainer = (): AppServices =>
  createContainer({
    emailService: {
      sendWelcomeEmail: async (email: string, name: string) => {
        // Real SendGrid implementation
      },
    },
    analyticsService: {
      trackEvent: (event: string, properties: Record<string, unknown>) => {
        // Real analytics implementation
      },
    },
  });

// Test implementation
export const createTestContainer = (): AppServices =>
  createContainer({
    logger: {
      log: () => {},
      error: () => {},
      warn: () => {},
    },
    emailService: {
      sendWelcomeEmail: async () => {
        console.log("Mock: Email sent");
      },
    },
    analyticsService: {
      trackEvent: () => {
        console.log("Mock: Event tracked");
      },
    },
  });

// app.ts
import {
  badRequest,
  defineRoute,
  defineRouter,
  internalServerError,
} from "@supabase-router/core";
import { z } from "zod";
import { type AppServices, createAppContainer } from "./services.ts";

type AppRole = "admin" | "user";

interface AppUser {
  id: string;
  email: string;
  role?: AppRole; // from app_metadata or userLoader, never user_metadata
}

export const createApp = (container: AppServices) =>
  defineRouter<AppRole, AppUser, AppServices>({
    basePath: "/api",
    container,
    routes: [
      defineRoute({
        method: "POST",
        path: "/register",
        authRequired: false, // public: no token required
        requestSchema: {
          body: z.object({
            email: z.email(),
            name: z.string(),
            password: z.string().min(8),
          }),
        },
        handler: async ({ body, services, supabaseClient }) => {
          // Optional on public routes (set when SUPABASE_URL and a
          // publishable key are configured)
          if (!supabaseClient) {
            return internalServerError("Supabase is not configured");
          }

          const { data, error } = await supabaseClient.auth.signUp({
            email: body.email,
            password: body.password,
          });

          if (error) {
            return badRequest(error.message);
          }

          await services.emailService.sendWelcomeEmail(body.email, body.name);

          services.analyticsService.trackEvent("user_registered", {
            email: body.email,
            timestamp: new Date().toISOString(),
          });

          return { success: true, userId: data.user?.id };
        },
      }),
    ],
  });

// index.ts - container created once at module level
const router = createApp(createAppContainer());

if (import.meta.main) {
  Deno.serve(router.handler);
}
```

## See Also

- [Testing Guide](./TESTING.md) - Using DI in tests
- [Examples](./examples/di-example.ts) - DI examples
- [README](./README.md) - Main documentation
