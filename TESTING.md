# Testing

How to test routers built with `@supabase-router/core`, and how the library
tests itself.

## Table of Contents

- [Testing Your Routers](#testing-your-routers)
- [The Library's Own Tests](#the-librarys-own-tests)
- [Integration Tests (Real Supabase)](#integration-tests-real-supabase)
- [Continuous Integration](#continuous-integration)
- [Resources](#resources)

## Testing Your Routers

`router.handler` is a plain `(req: Request) => Promise<Response>` function, so
routes can be tested in-process with `Deno.test`, without a server or a Supabase
project. Replace the external dependencies through the service container:

- `env` - Supabase URL and keys (fake values are fine)
- `supabaseClientFactory` - returns a fake Supabase client
- `logger`, `idGenerator` - silent / deterministic
- your own services (mailer, payments, ...)

### Example

Keep the router in its own module so tests can pass a container:

```typescript
// supabase/functions/api/router.ts
import {
  defineRoute,
  defineRouter,
  type ServiceContainer,
} from "@supabase-router/core";
import { z } from "zod";

export interface Mailer {
  send(to: string, subject: string): Promise<void>;
}

export interface AppServices extends ServiceContainer {
  mailer: Mailer;
}

interface User {
  id: string;
  email?: string;
  role?: "admin" | "user";
}

export function createRouter(container?: Partial<AppServices>) {
  return defineRouter<"admin" | "user", User, AppServices>({
    basePath: "/api",
    container,
    routes: [
      defineRoute({
        method: "GET",
        path: "/me",
        handler: ({ user }) =>
          Promise.resolve({ id: user.id, role: user.role }),
      }),
      defineRoute({
        method: "POST",
        path: "/invite",
        allowedRoles: ["admin"],
        requestSchema: { body: z.object({ email: z.email() }) },
        handler: async ({ body, services }) => {
          await services.mailer.send(body.email, "You are invited");
          return { invited: body.email };
        },
      }),
    ],
  });
}
```

`index.ts` then only does
`Deno.serve(createRouter({ mailer: realMailer }).handler)`.

The test fakes `auth.getClaims`, which the default auth handler uses to verify
access tokens. The claims mirror a real Supabase access token: `sub`, `email`
and `app_metadata` (where the role lives).

```typescript
// supabase/functions/api/router_test.ts
import { assertEquals } from "@std/assert";
import { createContainer, type SupabaseClient } from "@supabase-router/core";
import { type AppServices, createRouter } from "./router.ts";

// Tokens the fake Auth accepts, with the claims a real access token carries
const TOKENS: Record<string, Record<string, unknown>> = {
  "admin-token": {
    sub: "u-admin",
    email: "admin@example.com",
    app_metadata: { role: "admin" },
  },
  "user-token": {
    sub: "u-user",
    email: "user@example.com",
    app_metadata: { role: "user" },
  },
};

// The default auth handler verifies tokens with auth.getClaims()
const fakeSupabase = () =>
  ({
    auth: {
      getClaims: (token: string) =>
        Promise.resolve(
          TOKENS[token]
            ? { data: { claims: TOKENS[token] }, error: null }
            : { data: null, error: new Error("invalid JWT") },
        ),
    },
  }) as unknown as SupabaseClient;

const ENV: Record<string, string> = {
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
};

function setup() {
  const sent: string[] = [];
  const container = createContainer<Pick<AppServices, "mailer">>({
    env: { get: (key) => ENV[key], require: (key) => ENV[key] },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    idGenerator: { generate: () => "req-1" },
    supabaseClientFactory: {
      create: () => fakeSupabase(),
      createWithToken: () => fakeSupabase(),
    },
    mailer: {
      send: (to) => {
        sent.push(to);
        return Promise.resolve();
      },
    },
  });
  return { router: createRouter(container), sent };
}

const call = (path: string, token?: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

Deno.test("GET /me returns the user from the token", async () => {
  const { router } = setup();
  const res = await router.handler(call("/api/me", "user-token"));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { id: "u-user", role: "user" });
});

Deno.test("missing and invalid tokens get 401", async () => {
  const { router } = setup();
  const missing = await router.handler(call("/api/me"));
  assertEquals(missing.status, 401);
  assertEquals(await missing.json(), {
    error: "Authorization header required",
  });

  const invalid = await router.handler(call("/api/me", "nope"));
  assertEquals(await invalid.json(), { error: "Invalid or expired token" });
});

Deno.test("only admins can invite", async () => {
  const { router, sent } = setup();
  const body = { email: "new@example.com" };

  const denied = await router.handler(call("/api/invite", "user-token", body));
  assertEquals(denied.status, 403);
  await denied.body?.cancel();

  const ok = await router.handler(call("/api/invite", "admin-token", body));
  assertEquals(ok.status, 200);
  assertEquals(sent, ["new@example.com"]);
});

Deno.test("invalid body is rejected with details", async () => {
  const { router } = setup();
  const res = await router.handler(
    call("/api/invite", "admin-token", { email: "not-an-email" }),
  );
  assertEquals(res.status, 400);
  const { error, details } = await res.json();
  assertEquals(error, "Validation failed");
  assertEquals(details[0].path, ["email"]);
});
```

Add `"@std/assert": "jsr:@std/assert@^1"` to your imports and run
`deno test supabase/functions/api/`.

### Tips

- **`getUser` instead of `getClaims`.** If the fake client has no
  `auth.getClaims`, or the router uses `tokenVerification: "auth-server"`, the
  router calls `auth.getUser(token)` instead. Return
  `{ data: { user: { id, email, app_metadata, user_metadata } }, error: null }`
  for valid tokens and `{ data: { user: null }, error }` otherwise.
- **Which client is used where.** `supabaseClientFactory.create(url, key)`
  builds the anonymous client (token verification, public routes) and the
  secret-key client; `createWithToken(url, key, token)` builds the user-scoped
  `supabaseClient` of authenticated handlers and the client passed to
  `userLoader`. Give the fake the query methods your handlers call (`from`,
  `select`, `eq`, ...).
- **Secret-key routes** (`requireServiceRole` / `bypassWithServiceRole`): add
  `SUPABASE_SECRET_KEY` to the fake env and send it in the `apikey` header.
- **Database routes** (`useDatabase: true`): pass
  `getOrCreateDbClient: () => fakeDb` (it may also return a promise) to
  `createContainer`; the pooler is then never contacted.
- **Request IDs.** The router draws one ID per request from `idGenerator`
  (`ctx.requestId`) before your handler runs; take that into account when a
  handler also generates IDs.

A longer example with custom services is in
[`examples/testing-example.ts`](./examples/testing-example.ts).

## The Library's Own Tests

### Layout

```
tests/
├── helpers.ts                 # createTestContainer, request, env fixtures
├── auth_test.ts               # roles from app_metadata, userLoader, fail-closed
│                              # auth/RBAC, anon & service-role bypass
├── supabase_keys_test.ts      # key resolution, getClaims/JWKS, auth-server mode,
│                              # secret key on apikey, legacy keys, getUser fallback
├── router_test.ts             # matching, 404/405/HEAD, parsed params/query,
│                              # middleware order, errors, body validation, database
├── cors_openapi_test.ts       # CORS allowlists and preflight, OpenAPI output
├── errors_test.ts             # errorHandlerMiddleware, createErrorResponseByEnv
├── doc_comments_test.ts       # no relative imports inside comments (Supabase
│                              # CLI bundling)
├── auth_context_test.ts       # ctx.auth kinds at runtime, auth data, custom
│                              # auth options
├── auth_types_test.ts         # type-level: ctx.auth / ctx.user per route
│                              # options, router kit, HandlerContext
├── router_features_test.ts    # defaultAuthentication, withAuthDefaults,
│                              # ctx.route, router.match, onError
├── rate_limit_example_test.ts # examples/redis-rate-limit.ts with a fake limiter
└── integration/               # real Supabase stack, see below
```

`examples/testing-example.ts` also runs as part of `deno task test`.

`auth_types_test.ts` asserts types rather than behaviour: `assertType<IsExact<...>>`
and `// @ts-expect-error` lines are verified by `deno task check` (part of
`deno task ci`); an `@ts-expect-error` whose error disappears fails the check.

`tests/helpers.ts` provides:

- `createTestContainer(users?, overrides?, env?)` - container whose Supabase
  clients are fakes. `users` maps a bearer token to a Supabase user
  (`{ id, email, app_metadata, user_metadata }`) returned by both `getClaims`
  and `getUser`. The returned container also records `logs` and auth `calls`.
- `request(path, { token, ...init })` - builds a `Request` for
  `http://localhost<path>` with an optional bearer token.
- `LEGACY_ENV` / `NEW_KEYS_ENV` - env with legacy keys or with the new
  `SUPABASE_PUBLISHABLE_KEYS` / `SUPABASE_SECRET_KEYS` / `SUPABASE_JWKS` JSON.

### Tasks

| Task                         | What it does                                                               |
| ---------------------------- | -------------------------------------------------------------------------- |
| `deno task test`             | Unit tests (`tests/*_test.ts`) and `examples/testing-example.ts`           |
| `deno task test:watch`       | Unit tests in watch mode                                                   |
| `deno task test:coverage`    | Unit tests, collecting coverage into `coverage/`                           |
| `deno task coverage`         | Writes an LCOV report to `coverage/lcov.info`                              |
| `deno task coverage:html`    | Writes an HTML report to `coverage/html/` (does not open a browser)        |
| `deno task check`            | Type-checks `mod.ts`, `examples/`, unit and integration tests              |
| `deno task lint`             | `deno lint` plus `lint:complexity`                                         |
| `deno task lint:complexity`  | ESLint complexity rules (below)                                            |
| `deno task test:integration` | Integration tests against a local Supabase stack (Docker)                  |
| `deno task ci`               | `deno fmt --check`, `deno lint`, ESLint complexity, type check, unit tests |

Run a single file or test:

```bash
deno test -A tests/router_test.ts
deno test -A tests/*_test.ts --filter "HEAD"
```

### Complexity Rules

`deno task lint:complexity` runs ESLint (configured in `eslint.config.js`) only
for rules that `deno lint` lacks:

- cyclomatic `complexity` ≤ 10
- `max-depth` 3
- `max-params` 4
- `max-nested-callbacks` 3
- `max-lines-per-function` 60 (blank lines and comments not counted)

Files in `tests/` and `examples/` are exempt from the last two.

## Integration Tests (Real Supabase)

The unit tests use fakes. `tests/integration/` checks the same behaviour against
a real local Supabase stack: GoTrue (Auth), PostgREST with RLS, Postgres,
Supavisor and the edge runtime.

```bash
deno task test:integration              # active signing key ES256 (default)
deno task test:integration --alg RS256  # active signing key RS256
deno task test:integration --keep       # leave the stack running afterwards
```

Requirements: Docker and the Supabase CLI. To use another CLI build, set
`SUPABASE_CLI`, e.g. `SUPABASE_CLI="npx -y supabase@beta"`.

`tests/integration/run.ts`:

1. Generates the JWT signing keys: an active key with `--alg`, plus a "previous"
   key of the other algorithm that is published for verification only, as after
   a key rotation. GoTrue accepts only one private signing key, so the previous
   key is written without its private part; its private JWK is kept in
   `.generated/` so the tests can sign tokens with it.
2. Vendors the library into `supabase/functions/_shared/router` and writes the
   function's `deno.json` (the edge runtime only mounts `supabase/`).
3. Starts a stack as project `supabase-router-it` on ports 553xx (API `55321`,
   database `55322`, pooler `55329`), without Studio, Storage, Realtime and
   other unused services, so it does not clash with a stack on the default
   ports.
4. Serves the `router-it` fixture function (`verify_jwt = false`) and waits for
   it.
5. Runs `tests/integration/*_test.ts`, passing the stack's URLs and keys via
   env.
6. Stops the stack (unless `--keep`; then stop it later with
   `supabase stop --no-backup` from `tests/integration/`).

What the suites cover (most run the router in-process against the stack;
`edge_function_test.ts` goes through the API gateway to the deployed function):

- `auth_test.ts` - tokens signed with the active algorithm carry `app_metadata`;
  local verification with `SUPABASE_JWKS` and via the JWKS endpoint; role
  escalation via `user_metadata` is rejected; the user-scoped client enforces
  RLS; forged, garbage and API-key Bearer tokens are rejected; the secret key on
  `apikey` reaches the admin API; headers as sent by supabase-js; legacy
  anon/service_role keys; after sign-out, `claims` mode accepts the token until
  it expires while `auth-server` mode rejects it.
- `signing_keys_test.ts` - tokens signed by the previous (verify-only) key are
  accepted, tokens signed by a key missing from the JWKS are rejected, legacy
  HS256 tokens are verified by the Auth server.
- `database_test.ts` - the transaction pooler client works through Supavisor,
  where the dropped `statement_timeout` is reported as a warning, and over a
  direct connection, where it applies.
- `edge_function_test.ts` - the edge runtime provisions the new-style env
  (`SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`, `SUPABASE_JWKS`);
  `supabase.functions.invoke` with a signed-in user (200, RBAC 403) and signed
  out (401); server-to-server calls with the secret key; `OPTIONS` responses
  include the headers supabase-js sends.

The local API gateway answers real CORS preflights itself, so they never reach
the function. Preflight allowlists are therefore only covered by the unit tests
(`cors_openapi_test.ts`).

Generated artifacts (`.generated/`, `supabase/signing_keys.json`,
`supabase/functions/_shared/`, `supabase/functions/router-it/deno.json`,
`supabase/.temp/`, `supabase/.branches/`) are gitignored.

The integration suite is not part of `deno task ci`.

## Continuous Integration

Two workflows live in `.github/workflows/`:

- `ci.yml` runs `deno task ci` and `deno publish --dry-run` on every push to
  `main` and on pull requests.
- `publish.yml` publishes to JSR when a GitHub release is published (the tag
  must be `v` + the `version` in `deno.json`), or manually from the Actions
  tab. It authenticates with GitHub OIDC, so no token is stored; the package
  must be linked to this repository once in its settings on jsr.io.

Integration tests are not part of CI because they need Docker and the Supabase
CLI; run `deno task test:integration` locally before a release.

### Releasing

1. Bump `version` in `deno.json` and add the release section to
   `CHANGELOG.md`; merge to `main`.
2. Create a GitHub release with the tag `v<version>` (e.g. `v2.1.0`).
3. `publish.yml` runs CI and publishes the version to JSR.

## Resources

- [Deno testing](https://docs.deno.com/runtime/fundamentals/testing/)
- [`@std/assert`](https://jsr.io/@std/assert)
- [DEPENDENCY_INJECTION.md](./DEPENDENCY_INJECTION.md) - the service container
- [`examples/testing-example.ts`](./examples/testing-example.ts)
