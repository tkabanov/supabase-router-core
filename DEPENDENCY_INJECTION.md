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
import { createContainer, ServiceContainer } from '@supabase-router/core';

// Create container with default services
const container = createContainer();

// Pass to router
const router = defineRouter({
  container,
  routes: [...]
});
```

### Accessing Services

Services are available in every route handler via the `services` property:

```typescript
defineRoute({
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
  handler: async ({ services }) => {
    // Log informational message
    services.logger.log("User login attempt", "userId:", "123");

    // Log warning
    services.logger.warn("Rate limit approaching", "current:", 95);

    // Log error
    services.logger.error("Database connection failed", err);

    return { success: true };
  },
});
```

**Interface:**

```typescript
interface Logger {
  log: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}
```

### 2. ID Generator

Generate unique identifiers:

```typescript
defineRoute({
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
  generate: () => string;
}
```

### 3. Environment Provider

Access environment variables safely:

```typescript
defineRoute({
  handler: async ({ services }) => {
    // Get environment variable
    const apiKey = services.env.get("API_KEY");

    // Get with default value
    const timeout = services.env.get("TIMEOUT") || "30";

    // Require environment variable (throws if missing)
    const requiredKey = services.env.require("REQUIRED_KEY");

    if (!apiKey) {
      return badRequest("API_KEY not configured");
    }

    return { success: true };
  },
});
```

**Interface:**

```typescript
interface EnvironmentProvider {
  get: (key: string) => string | undefined;
  require: (key: string) => string; // Throws if key not found
}
```

### 4. Supabase Client Factory

Create Supabase clients (used internally by auth):

```typescript
defineRoute({
  handler: async ({ services, supabaseClient }) => {
    // Usually you'll use the auto-injected supabaseClient
    // But you can create custom clients if needed:

    // Create client with URL and key
    const customClient = services.supabaseClientFactory.create(
      "https://custom.supabase.co",
      "custom-anon-key",
    );

    // Create client with user token (for user-scoped access)
    const userClient = services.supabaseClientFactory.createWithToken(
      "https://custom.supabase.co",
      "anon-key",
      "user-access-token",
    );

    return { success: true };
  },
});
```

### 5. Cached Supabase Clients

The container provides cached client helpers for performance:

```typescript
defineRoute({
  handler: async ({ services }) => {
    // Get or create cached anonymous client
    // Automatically uses SUPABASE_URL and SUPABASE_ANON_KEY
    const anonClient = services.getOrCreateAnonClient();

    // Get or create cached service-role client
    // Automatically uses SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
    const serviceClient = services.getOrCreateServiceClient();

    // Get or create database client (if transaction pooler enabled)
    const dbClient = services.getOrCreateDbClient?.();

    return { success: true };
  },
});
```

**Note:** These methods cache clients at module level to avoid creating new clients on every request (5-8ms performance improvement).

**Serverless Environment Behavior:**
- ✅ **Warm instances**: Cache works across multiple requests within the same instance
- ❌ **Cold starts**: Cache is reset when a new instance is initialized
- 💡 **Best practice**: Create container at module level (not per-request) for maximum cache effectiveness

```typescript
// ✅ Good - container created once at module level
const container = createContainer({...});
const router = defineRouter({ container, routes: [...] });

// ❌ Bad - container created per request (cache doesn't help)
Deno.serve(async (req) => {
  const container = createContainer({...}); // New cache per request
  // ...
});
```

### 6. Database Client (Optional)

If you enable the transaction pooler in your router configuration, the container provides a database client:

```typescript
const router = defineRouter({
  basePath: '/api',
  database: {
    enableTransactionPooler: true,
    connectionStringEnv: 'SUPABASE_DB_POOLER_URL',
  },
  routes: [
    defineRoute({
      method: 'POST',
      path: '/data',
      useDatabase: true,
      handler: async ({ db, services }) => {
        // db is available when useDatabase: true
        // You can also access it via services if needed
        const dbClient = services.getOrCreateDbClient?.();
        
        if (!db || !dbClient) {
          return { error: 'Database unavailable' };
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

**Note:** `getOrCreateDbClient` is optional (`?`) because it's only available when the transaction pooler is enabled.

**Interface:**

```typescript
interface SupabaseClientFactory {
  create: (url: string, key: string) => SupabaseClient;
  createWithToken: (url: string, anonKey: string, token: string) => SupabaseClient;
}
```

## Custom Services

Extend the container with your own services:

### Step 1: Define Service Interface

```typescript
// services/email.ts
export interface EmailService {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
  sendTemplate(to: string, template: string, data: any): Promise<void>;
}
```

### Step 2: Implement Service

```typescript
// services/sendgrid.ts
import { EmailService } from "./email.ts";

export class SendGridService implements EmailService {
  constructor(private apiKey: string) {}

  async sendEmail(to: string, subject: string, body: string) {
    // SendGrid implementation
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

  async sendTemplate(to: string, template: string, data: any) {
    // Template implementation
  }
}
```

### Step 3: Extend Container Type

```typescript
// container.ts
import { ServiceContainer } from "@supabase-router/core";
import { EmailService } from "./services/email.ts";

export interface AppServices extends ServiceContainer {
  emailService: EmailService;
  paymentService: PaymentService;
  analyticsService: AnalyticsService;
}
```

### Step 4: Create Container

```typescript
// container.ts
import { createContainer } from "@supabase-router/core";
import { SendGridService } from "./services/sendgrid.ts";

export const createAppContainer = (): AppServices => {
  const baseContainer = createContainer();

  return {
    ...baseContainer,
    emailService: new SendGridService(
      Deno.env.get("SENDGRID_API_KEY")!,
    ),
    paymentService: new StripeService(
      Deno.env.get("STRIPE_API_KEY")!,
    ),
    analyticsService: new AnalyticsService(),
  };
};
```

### Step 5: Use in Routes

```typescript
import { defineRoute, defineRouter } from "@supabase-router/core";
import { AppServices, createAppContainer } from "./container.ts";

const router = defineRouter({
  basePath: "/api",
  container: createAppContainer(),
  routes: [
    defineRoute({
      method: "POST",
      path: "/register",
      requestSchema: {
        body: z.object({
          email: z.string().email(),
          name: z.string(),
        }),
      },
      handler: async ({ body, services }) => {
        // Cast to access custom services
        const appServices = services as AppServices;

        // Use email service
        await appServices.emailService.sendEmail(
          body.email,
          "Welcome!",
          `Hello ${body.name}, welcome to our platform!`,
        );

        // Use analytics service
        appServices.analyticsService.track("user_registered", {
          email: body.email,
        });

        return { success: true };
      },
    }),
  ],
});
```

## Testing with DI

The DI system makes testing incredibly easy:

### Basic Test Setup

```typescript
import { createContainer } from "@supabase-router/core";

Deno.test("registration - sends welcome email", async () => {
  // Create test container with mock email service
  const mockEmailService = {
    sendEmail: async (to: string, subject: string, body: string) => {
      // Track that email was sent
      console.log(`Mock: Email to ${to}`);
    },
    sendTemplate: async () => {},
  };

  const testContainer = {
    ...createContainer(),
    emailService: mockEmailService,
  };

  const router = defineRouter({
    container: testContainer,
    routes: [registrationRoute],
  });

  const response = await router.handler(request);
  assertEquals(response.status, 200);
});
```

### Silent Logger for Tests

```typescript
import { createContainer } from "@supabase-router/core";

const createSilentTestContainer = () => ({
  ...createContainer(),
  logger: {
    log: () => {},
    error: () => {},
    warn: () => {},
  },
});
```

### Spy Pattern

```typescript
Deno.test('tracks analytics event', async () => {
  let trackedEvent: string | null = null;
  
  const mockAnalytics = {
    track: (event: string, data: any) => {
      trackedEvent = event;
    }
  };
  
  const container = {
    ...createContainer(),
    analyticsService: mockAnalytics
  };
  
  const router = defineRouter({ container, routes: [...] });
  await router.handler(request);
  
  assertEquals(trackedEvent, 'user_registered');
});
```

## Advanced Patterns

### Lazy Initialization

```typescript
export const createAppContainer = (): AppServices => {
  let emailService: EmailService | null = null;

  return {
    ...createContainer(),
    get emailService() {
      if (!emailService) {
        emailService = new SendGridService(
          Deno.env.get("SENDGRID_API_KEY")!,
        );
      }
      return emailService;
    },
  };
};
```

### Factory Pattern

```typescript
interface DatabaseService {
  getConnection(): Promise<Connection>;
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
      this.email.send(userId, message),
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
  private cache = new Map<string, any>();

  static getInstance() {
    if (!CacheService.instance) {
      CacheService.instance = new CacheService();
    }
    return CacheService.instance;
  }

  get(key: string) {
    return this.cache.get(key);
  }
  set(key: string, value: any) {
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

  return {
    ...createContainer(),
    emailService: new SendGridService(apiKey),
  };
};
```

### 6. Type Safety

Use TypeScript to enforce correct service usage:

```typescript
// Good
interface AppServices extends ServiceContainer {
  emailService: EmailService; // Type-safe
}

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
import { createContainer, ServiceContainer } from "@supabase-router/core";

export interface EmailService {
  sendWelcomeEmail(email: string, name: string): Promise<void>;
}

export interface AnalyticsService {
  trackEvent(event: string, properties: Record<string, any>): void;
}

export interface AppServices extends ServiceContainer {
  emailService: EmailService;
  analyticsService: AnalyticsService;
}

// Production implementation
export const createAppContainer = (): AppServices => ({
  ...createContainer(),
  emailService: {
    sendWelcomeEmail: async (email, name) => {
      // Real SendGrid implementation
    },
  },
  analyticsService: {
    trackEvent: (event, properties) => {
      // Real analytics implementation
    },
  },
});

// Test implementation
export const createTestContainer = (): AppServices => ({
  ...createContainer(),
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

// index.ts
import { defineRoute, defineRouter } from "@supabase-router/core";
import { z } from "zod";
import { AppServices, createAppContainer } from "./services.ts";

const router = defineRouter({
  basePath: "/api",
  container: createAppContainer(),
  routes: [
    defineRoute({
      method: "POST",
      path: "/register",
      requestSchema: {
        body: z.object({
          email: z.string().email(),
          name: z.string(),
          password: z.string().min(8),
        }),
      },
      handler: async ({ body, services, supabaseClient }) => {
        const appServices = services as AppServices;

        // Create user
        const { data: user, error } = await supabaseClient.auth.signUp({
          email: body.email,
          password: body.password,
        });

        if (error) throw error;

        // Send welcome email
        await appServices.emailService.sendWelcomeEmail(
          body.email,
          body.name,
        );

        // Track analytics
        appServices.analyticsService.trackEvent("user_registered", {
          email: body.email,
          timestamp: new Date().toISOString(),
        });

        return { success: true, userId: user.user?.id };
      },
    }),
  ],
});

if (import.meta.main) {
  Deno.serve(router.handler);
}
```

## See Also

- [Testing Guide](./TESTING.md) - Using DI in tests
- [Examples](./examples/di-example.ts) - DI examples
- [README](./README.md) - Main documentation
