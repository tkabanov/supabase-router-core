/**
 * Testing Example with Dependency Injection
 *
 * This example demonstrates how to write tests for your routes using mocked services
 * from the dependency injection container.
 */

import { assertEquals, assertExists } from "jsr:@std/testing@0.224.0/asserts";
import { createContainer, defineRoute, defineRouter } from "../mod.ts";
import type { ServiceContainer, SupabaseClient } from "../mod.ts";
import { z } from "npm:zod";

const noopAsync = () => Promise.resolve();

// ============================================================================
// Test Setup: Custom Services
// ============================================================================

interface EmailService {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
  getSentEmails(): Array<{ to: string; subject: string; body: string }>;
}

interface NotificationService {
  sendNotification(userId: string, message: string): Promise<void>;
  getNotifications(userId: string): string[];
}

// ============================================================================
// Mock Implementations for Testing
// ============================================================================

class MockEmailService implements EmailService {
  private sentEmails: Array<{ to: string; subject: string; body: string }> = [];

  sendEmail(to: string, subject: string, body: string): Promise<void> {
    this.sentEmails.push({ to, subject, body });
    return Promise.resolve();
  }

  getSentEmails() {
    return this.sentEmails;
  }

  reset() {
    this.sentEmails = [];
  }
}

class MockNotificationService implements NotificationService {
  private notifications: Map<string, string[]> = new Map();

  sendNotification(userId: string, message: string): Promise<void> {
    const existing = this.notifications.get(userId) || [];
    existing.push(message);
    this.notifications.set(userId, existing);
    return Promise.resolve();
  }

  getNotifications(userId: string): string[] {
    return this.notifications.get(userId) || [];
  }

  reset() {
    this.notifications.clear();
  }
}

// Mock Supabase client
const createMockSupabaseClient = (): SupabaseClient =>
  ({
    auth: {
      getUser: async (token: string) => {
        await noopAsync();
        if (token === "valid-token") {
          return {
            data: {
              user: {
                id: "test-user-123",
                email: "test@example.com",
                user_metadata: {
                  role: "user",
                  name: "Test User",
                },
              },
            },
            error: null,
          };
        }
        return {
          data: null,
          error: { message: "Invalid token" },
        };
      },
    },
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => {
            await noopAsync();
            return {
              data: { id: "test-user-123", email: "test@example.com" },
              error: null,
            };
          },
        }),
      }),
      insert: async (data: Record<string, unknown>) => {
        await noopAsync();
        return {
          data,
          error: null,
        };
      },
    }),
  }) as unknown as SupabaseClient;

// ============================================================================
// Extended Service Container with Custom Services
// ============================================================================

interface TestServices extends ServiceContainer {
  emailService: EmailService;
  notificationService: NotificationService;
}

// ============================================================================
// Create Test Router
// ============================================================================

enum UserRole {
  ADMIN = "admin",
  USER = "user",
}

interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

const userSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
});

function createTestRouter(testServices: TestServices) {
  return defineRouter<UserRole, User>({
    basePath: "/api",
    defaultTags: ["Test API"],
    container: testServices,

    routes: [
      defineRoute({
        method: "POST",
        path: "/users",
        summary: "Create user",
        authRequired: false,
        requestSchema: {
          body: userSchema,
        },
        handler: async ({ body, services }) => {
          const customServices = services as TestServices;
          const userId = services.idGenerator.generate();

          // Send welcome email
          await customServices.emailService.sendEmail(
            body.email,
            "Welcome!",
            `Hello ${body.name}, welcome to our app!`,
          );

          // Send notification
          await customServices.notificationService.sendNotification(
            userId,
            "Account created successfully",
          );

          return {
            id: userId,
            email: body.email,
            name: body.name,
          };
        },
      }),

      defineRoute({
        method: "GET",
        path: "/users/:id",
        summary: "Get user",
        authRequired: true,
        handler: async ({ params, user, services }) => {
          await noopAsync();
          services.logger.log(`Fetching user ${params.id}`);

          return {
            id: params.id,
            email: user.email,
            name: user.name,
          };
        },
      }),
    ],
  });
}

// ============================================================================
// Tests
// ============================================================================

Deno.test("Router DI - Create user sends email", async () => {
  // Arrange
  const mockEmailService = new MockEmailService();
  const mockNotificationService = new MockNotificationService();

  const testServices: TestServices = createContainer({
    emailService: mockEmailService,
    notificationService: mockNotificationService,
    logger: {
      log: () => {},
      error: () => {},
      warn: () => {},
    },
    idGenerator: {
      generate: () => "test-id-123",
    },
    supabaseClientFactory: {
      create: () => createMockSupabaseClient(),
      createWithToken: () => createMockSupabaseClient(),
    },
    env: {
      get: (key: string) => {
        if (key === "SUPABASE_URL") return "http://localhost:54321";
        if (key === "SUPABASE_SERVICE_ROLE_KEY") return "test-key";
        return undefined;
      },
      require: (_key: string) => "test-value",
    },
  }) as TestServices;

  const router = createTestRouter(testServices);

  // Act
  const request = new Request("http://localhost/api/users", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: "newuser@example.com",
      name: "New User",
    }),
  });

  const response = await router.handler(request);

  // Assert
  assertEquals(response.status, 200);

  const data = await response.json();
  assertEquals(data.id, "test-id-123");
  assertEquals(data.email, "newuser@example.com");
  assertEquals(data.name, "New User");

  // Verify email was sent
  const sentEmails = mockEmailService.getSentEmails();
  assertEquals(sentEmails.length, 1);
  assertEquals(sentEmails[0].to, "newuser@example.com");
  assertEquals(sentEmails[0].subject, "Welcome!");

  // Verify notification was sent
  const notifications = mockNotificationService.getNotifications("test-id-123");
  assertEquals(notifications.length, 1);
  assertEquals(notifications[0], "Account created successfully");
});

Deno.test("Router DI - Authenticated route with mocked auth", async () => {
  // Arrange
  const mockEmailService = new MockEmailService();
  const mockNotificationService = new MockNotificationService();

  const loggedMessages: string[] = [];

  const testServices: TestServices = createContainer({
    emailService: mockEmailService,
    notificationService: mockNotificationService,
    logger: {
      log: (msg: string) => {
        loggedMessages.push(msg);
      },
      error: () => {},
      warn: () => {},
    },
    idGenerator: {
      generate: () => "test-request-id",
    },
    supabaseClientFactory: {
      create: () => createMockSupabaseClient(),
      createWithToken: () => createMockSupabaseClient(),
    },
    env: {
      get: (key: string) => {
        if (key === "SUPABASE_URL") return "http://localhost:54321";
        if (key === "SUPABASE_SERVICE_ROLE_KEY") return "test-key";
        return undefined;
      },
      require: (_key: string) => "test-value",
    },
  }) as TestServices;

  const router = createTestRouter(testServices);

  // Act
  const request = new Request("http://localhost/api/users/user-123", {
    method: "GET",
    headers: {
      "Authorization": "Bearer valid-token",
    },
  });

  const response = await router.handler(request);

  // Assert
  assertEquals(response.status, 200);

  const data = await response.json();
  assertEquals(data.id, "user-123");
  assertExists(data.email);

  // Verify logger was called
  assertEquals(loggedMessages.length > 0, true);
  assertEquals(
    loggedMessages.some((msg) => msg.includes("Fetching user")),
    true,
  );
});

Deno.test("Router DI - Validation error with custom logger", async () => {
  // Arrange
  const errorMessages: string[] = [];

  const testServices: TestServices = createContainer({
    emailService: new MockEmailService(),
    notificationService: new MockNotificationService(),
    logger: {
      log: () => {},
      error: (msg: string) => {
        errorMessages.push(msg);
      },
      warn: () => {},
    },
    idGenerator: {
      generate: () => "test-id",
    },
    supabaseClientFactory: {
      create: () => createMockSupabaseClient(),
      createWithToken: () => createMockSupabaseClient(),
    },
    env: {
      get: () => "test-value",
      require: () => "test-value",
    },
  }) as TestServices;

  const router = createTestRouter(testServices);

  // Act - Invalid email
  const request = new Request("http://localhost/api/users", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: "invalid-email",
      name: "Test",
    }),
  });

  const response = await router.handler(request);

  // Assert
  assertEquals(response.status, 400);

  const data = await response.json();
  assertEquals(data.error, "Validation failed");
});

Deno.test("Router DI - Custom ID generator", async () => {
  // Arrange
  let idCounter = 0;
  const customIdGenerator = {
    generate: () => `custom-id-${++idCounter}`,
  };

  const testServices: TestServices = createContainer({
    emailService: new MockEmailService(),
    notificationService: new MockNotificationService(),
    idGenerator: customIdGenerator,
    logger: {
      log: () => {},
      error: () => {},
      warn: () => {},
    },
    supabaseClientFactory: {
      create: () => createMockSupabaseClient(),
      createWithToken: () => createMockSupabaseClient(),
    },
    env: {
      get: () => undefined,
      require: () => "test-value",
    },
  }) as TestServices;

  const router = createTestRouter(testServices);

  // Act - Create first user
  const request1 = new Request("http://localhost/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "user1@example.com", name: "User 1" }),
  });

  const response1 = await router.handler(request1);
  const data1 = await response1.json();

  // Act - Create second user
  const request2 = new Request("http://localhost/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "user2@example.com", name: "User 2" }),
  });

  const response2 = await router.handler(request2);
  const data2 = await response2.json();

  // Assert - Custom IDs are used
  assertEquals(data1.id, "custom-id-1");
  assertEquals(data2.id, "custom-id-2");
});

// ============================================================================
// Example: Integration Test Pattern
// ============================================================================

Deno.test("Integration - User registration flow", async () => {
  // Arrange
  const mockEmailService = new MockEmailService();
  const mockNotificationService = new MockNotificationService();

  const testServices: TestServices = createContainer({
    emailService: mockEmailService,
    notificationService: mockNotificationService,
    logger: {
      log: console.log,
      error: console.error,
      warn: console.warn,
    },
    idGenerator: {
      generate: () => crypto.randomUUID(),
    },
    supabaseClientFactory: {
      create: () => createMockSupabaseClient(),
      createWithToken: () => createMockSupabaseClient(),
    },
    env: {
      get: (key: string) => {
        const env: Record<string, string> = {
          "SUPABASE_URL": "http://localhost:54321",
          "SUPABASE_SERVICE_ROLE_KEY": "test-key",
        };
        return env[key];
      },
      require: (_key: string) => "test-value",
    },
  }) as TestServices;

  const router = createTestRouter(testServices);

  // Act - Register new user
  const registerRequest = new Request("http://localhost/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "integration@example.com",
      name: "Integration Test User",
    }),
  });

  const registerResponse = await router.handler(registerRequest);
  const userData = await registerResponse.json();

  // Assert registration
  assertEquals(registerResponse.status, 200);
  assertExists(userData.id);

  // Verify side effects
  const emails = mockEmailService.getSentEmails();
  assertEquals(emails.length, 1);
  assertEquals(emails[0].to, "integration@example.com");

  const notifications = mockNotificationService.getNotifications(userData.id);
  assertEquals(notifications.length, 1);
});

console.log("All tests use dependency injection for easy mocking!");
