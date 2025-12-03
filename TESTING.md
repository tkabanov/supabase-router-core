# Testing Guide

Comprehensive guide to testing your edge functions built with the router
framework.

## Table of Contents

- [Running Tests](#running-tests)
- [Test Structure](#test-structure)
- [Writing Tests](#writing-tests)
- [Test Helpers](#test-helpers)
- [Database-Enabled Routes](#database-enabled-routes)
- [Coverage](#coverage)
- [Best Practices](#best-practices)

## Running Tests

### Quick Start

```bash
# Run all tests
deno task test

# Watch mode (auto-rerun on changes)
deno task test:watch

# Run specific test category
deno task test:unit
deno task test:integration
deno task test:e2e

# With coverage
deno task test:coverage

# Generate coverage reports
deno task coverage        # LCOV format
deno task coverage:html   # HTML report
```

### Test Categories

The router includes three types of tests:

1. **Unit Tests** (70%) - Test individual modules in isolation
2. **Integration Tests** (20%) - Test component interactions
3. **E2E Tests** (10%) - Test complete workflows

## Test Structure

```
__tests__/
├── helpers/              # Reusable test utilities
│   ├── mock-supabase.ts # Supabase client mock
│   ├── test-containers.ts # DI container factories
│   ├── request-builder.ts # HTTP request builder
│   ├── test-utils.ts    # Assertion helpers
│   └── fixtures.ts      # Test data
├── unit/                 # Unit tests
│   ├── security/        # Security module (CRITICAL)
│   ├── authentication/  # Auth module (CRITICAL)
│   ├── validation/      # Validation (CRITICAL)
│   ├── routing/         # Route matching
│   ├── middleware/      # Middleware
│   ├── errors/          # Error handling
│   ├── core/            # Core functionality
│   └── docs/            # OpenAPI generation
├── integration/          # Integration tests
│   ├── router.test.ts
│   ├── authentication-flow.test.ts
│   └── di-container.test.ts
└── e2e/                  # End-to-end tests
    ├── crud-flow.test.ts
    └── security-scenarios.test.ts
```

## Writing Tests

### Unit Test Pattern

Test individual functions in isolation:

```typescript
import { assertEquals, assertRejects } from "jsr:@std/testing@0.224.0/asserts";
import { sanitizePathParam } from "../../security/sanitizer.ts";

Deno.test("sanitizePathParam - blocks path traversal", () => {
  // Arrange
  const maliciousInput = "../../../etc/passwd";

  // Act & Assert
  assertRejects(
    () => sanitizePathParam(maliciousInput),
    Error,
    "Invalid path parameter",
  );
});

Deno.test("sanitizePathParam - allows valid input", () => {
  const validInput = "user-123";
  const result = sanitizePathParam(validInput);
  assertEquals(result, "user-123");
});
```

### Integration Test Pattern

Test multiple components working together:

```typescript
import { defineRoute, defineRouter } from "../../router.ts";
import { createSilentTestContainer } from "../helpers/test-containers.ts";
import { z } from "zod";

Deno.test("Router - handles authenticated request", async () => {
  // Arrange
  const container = createSilentTestContainer();
  const router = defineRouter({
    container,
    basePath: "/api",
    routes: [
      defineRoute({
        method: "GET",
        path: "/profile",
        authRequired: true,
        handler: async ({ user }) => {
          return { userId: user.id };
        },
      }),
    ],
  });

  // Act
  const response = await router.handler(
    new Request("http://localhost/api/profile", {
      headers: { "Authorization": "Bearer valid-token" },
    }),
  );

  // Assert
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.userId, "test-user-id");
});
```

### E2E Test Pattern

Test complete user workflows:

```typescript
Deno.test("E2E - Complete CRUD workflow", async () => {
  const container = createTestContainer();
  const router = defineRouter({ container, routes: crudRoutes });

  // Step 1: Create
  const createReq = new Request("http://localhost/api/items", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token",
    },
    body: JSON.stringify({ name: "Test Item" }),
  });
  const createRes = await router.handler(createReq);
  assertEquals(createRes.status, 201);
  const created = await createRes.json();

  // Step 2: Read
  const readReq = new Request(`http://localhost/api/items/${created.id}`);
  const readRes = await router.handler(readReq);
  assertEquals(readRes.status, 200);

  // Step 3: Update
  const updateReq = new Request(`http://localhost/api/items/${created.id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token",
    },
    body: JSON.stringify({ name: "Updated Item" }),
  });
  const updateRes = await router.handler(updateReq);
  assertEquals(updateRes.status, 200);

  // Step 4: Delete
  const deleteReq = new Request(`http://localhost/api/items/${created.id}`, {
    method: "DELETE",
    headers: { "Authorization": "Bearer admin-token" },
  });
  const deleteRes = await router.handler(deleteReq);
  assertEquals(deleteRes.status, 204);
});
```

## Test Helpers

### Mock Supabase Client

```typescript
import { createMockSupabaseClient } from "../helpers/mock-supabase.ts";

const mockClient = createMockSupabaseClient({
  from: () => ({
    select: () => ({ data: [{ id: 1 }], error: null }),
    insert: () => ({ data: { id: 1 }, error: null }),
  }),
});
```

### Test Containers

```typescript
import {
  createSilentTestContainer,
  createTestContainer,
} from "../helpers/test-containers.ts";

// Silent logger for clean test output
const silentContainer = createSilentTestContainer();

// Full container with custom services
const container = createTestContainer({
  emailService: mockEmailService,
});
```

### Request Builder

```typescript
import { RequestBuilder } from "../helpers/request-builder.ts";

const request = new RequestBuilder()
  .url("http://localhost/api/users")
  .method("POST")
  .json({ name: "John" })
  .auth("Bearer token")
  .build();
```

### Test Fixtures

```typescript
import { createTestItem, createTestUser } from "../helpers/fixtures.ts";

const testUser = createTestUser({ role: "admin" });
const testItem = createTestItem({ name: "Test" });
```

## Database-Enabled Routes

Routes that opt into `useDatabase: true` expect a Drizzle client. Provide a mock
through the container to avoid opening real connections:

```typescript
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { defineRoute, defineRouter } from "@router";
import { assertEquals } from "jsr:@std/testing@0.224.0/asserts";

const fakeDb = {
  transaction: async <T>(
    callback: (tx: PostgresJsDatabase) => Promise<T>,
  ): Promise<T> => await callback(fakeDb as PostgresJsDatabase),
  execute: async () => ({ rows: [] }),
} as unknown as PostgresJsDatabase;

const router = defineRouter({
  basePath: "/api",
  container: {
    getOrCreateDbClient: () => fakeDb,
  },
  routes: [
    defineRoute({
      method: "POST",
      path: "/db",
      useDatabase: true,
      handler: async ({ db }) => {
        assertEquals(db, fakeDb);
        return { ok: true };
      },
    }),
  ],
});
```

To test failure scenarios, omit the connection string (or point to an invalid
value) and assert that the handler responds with `status === 500` and
`error === "Database connection error"`.

## Coverage

### Coverage Targets

| Module          | Target | Priority |
| --------------- | ------ | -------- |
| security/       | 95%+   | CRITICAL |
| authentication/ | 90%+   | CRITICAL |
| validation/     | 90%+   | CRITICAL |
| routing/        | 85%+   | High     |
| router.ts       | 85%+   | High     |
| middleware/     | 80%+   | Medium   |

### Generate Coverage Reports

```bash
# Run tests with coverage
deno task test:coverage

# Generate LCOV report
deno task coverage

# Generate HTML report (opens in browser)
deno task coverage:html
```

### View Coverage

```bash
# Terminal output
deno coverage coverage

# HTML report
open coverage/html/index.html
```

## Best Practices

### 1. Test Naming

Use descriptive names that explain what is being tested:

```typescript
// Bad
Deno.test('test1', () => { ... });

// Good
Deno.test('sanitizePathParam - blocks path traversal attacks', () => { ... });
```

### 2. Arrange-Act-Assert Pattern

```typescript
Deno.test("example", async () => {
  // Arrange: Set up test data and dependencies
  const input = "test-input";
  const expected = "test-output";

  // Act: Execute the code being tested
  const result = functionUnderTest(input);

  // Assert: Verify the results
  assertEquals(result, expected);
});
```

### 3. Test One Thing

Each test should verify one specific behavior:

```typescript
// Bad: Testing multiple things
Deno.test('user operations', async () => {
  await createUser();
  await updateUser();
  await deleteUser();
});

// Good: Separate tests
Deno.test('createUser - creates user successfully', async () => { ... });
Deno.test('updateUser - updates user successfully', async () => { ... });
Deno.test('deleteUser - deletes user successfully', async () => { ... });
```

### 4. Use Test Containers

Always use test containers for dependency injection:

```typescript
// Good: Using test container
const container = createSilentTestContainer();
const router = defineRouter({ container, routes: [...] });
```

### 5. Clean Up Resources

```typescript
Deno.test("resource test", async () => {
  const resource = await createResource();

  try {
    // Test code
  } finally {
    await resource.cleanup();
  }
});
```

### 6. Test Error Cases

Don't just test the happy path:

```typescript
Deno.test("handler - returns 400 for invalid input", async () => {
  const response = await router.handler(invalidRequest);
  assertEquals(response.status, 400);
});

Deno.test("handler - returns 401 for missing auth", async () => {
  const response = await router.handler(unauthenticatedRequest);
  assertEquals(response.status, 401);
});
```

### 7. Mock External Dependencies

```typescript
const mockEmailService = {
  sendEmail: async (to: string, subject: string) => {
    // Mock implementation - don't send real emails in tests
    console.log(`Mock: Email to ${to}`);
  },
};

const container = createTestContainer({
  emailService: mockEmailService,
});
```

### 8. Use Fixtures for Complex Data

```typescript
// fixtures.ts
export const createTestUser = (overrides = {}) => ({
  id: "test-user-id",
  email: "test@example.com",
  role: "user",
  ...overrides,
});

// test.ts
const admin = createTestUser({ role: "admin" });
const regularUser = createTestUser();
```

## Testing Your Application

When building applications with the router:

```typescript
import { createSilentTestContainer } from "../_shared/router/__tests__/helpers/test-containers.ts";
import { defineRoute, defineRouter } from "../_shared/router/mod.ts";

Deno.test("my function - works correctly", async () => {
  const router = defineRouter({
    container: createSilentTestContainer(),
    routes: [
      // Your routes
    ],
  });

  const response = await router.handler(request);
  assertEquals(response.status, 200);
});
```

## Continuous Integration

### GitHub Actions Example

```yaml
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: denoland/setup-deno@v1
      - name: Run tests
        run: deno task test:coverage
      - name: Generate coverage
        run: deno task coverage
      - name: Upload coverage
        uses: codecov/codecov-action@v3
```

## Debugging Tests

### Run Single Test

```bash
deno test __tests__/unit/security/sanitizer.test.ts
```

### Run with Verbose Output

```bash
deno test --allow-all --trace-ops __tests__/
```

### Use Debugger

```typescript
Deno.test("debug example", () => {
  debugger; // Set breakpoint here
  const result = functionUnderTest();
  assertEquals(result, expected);
});
```

Then run with:

```bash
deno test --inspect-brk __tests__/your-test.ts
```

## Additional Resources

- [Deno Testing Documentation](https://deno.land/manual/testing)
- [std/testing Assertions](https://deno.land/std/testing/asserts.ts)
- [Test Helpers README](./__tests__/README.md)
- [Example Tests](./examples/testing-example.ts)

## Contributing Tests

When contributing to the router:

1. Write tests for all new features
2. Update tests when changing behavior
3. Ensure coverage targets are met
4. Follow the existing test patterns
5. Add test helpers for common patterns

See [CONTRIBUTING.md](./CONTRIBUTING.md) for more details.
