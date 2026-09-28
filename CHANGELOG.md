# Changelog

## 2.0.0 — unreleased

### Supabase API keys and JWT signing keys

Supabase introduced publishable (`sb_publishable_...`) and secret
(`sb_secret_...`) API keys, which are not JWTs, and asymmetric JWT signing keys
(ES256/RS256). The legacy `anon` / `service_role` keys are deprecated by the end
of 2026. Both systems are supported:

- Keys are read from `SUPABASE_PUBLISHABLE_KEYS` / `SUPABASE_SECRET_KEYS` (JSON,
  auto-provisioned in hosted Edge Functions), then `SUPABASE_PUBLISHABLE_KEY` /
  `SUPABASE_SECRET_KEY` (local CLI), then legacy `SUPABASE_ANON_KEY` /
  `SUPABASE_SERVICE_ROLE_KEY`. `SUPABASE_SERVICE_ROLE_KEY` is no longer
  required unless a route uses a secret key.
- User tokens are verified with `auth.getClaims()`: locally against
  `SUPABASE_JWKS` / the JWKS endpoint for asymmetric keys, via the Auth server
  for legacy HS256 projects. New router option `tokenVerification:
  "auth-server"` keeps the previous `getUser()`-per-request behaviour. Clients
  without `getClaims` fall back to `getUser()`.
- Secret keys are accepted on the `apikey` header, as Supabase recommends; for
  migration they (and legacy `service_role` JWTs) are also accepted on
  `Authorization: Bearer`. Publishable/anon keys are accepted on
  either header with `bypassWithAnonRole`, and a valid user token always takes
  precedence over the publishable key supabase-js sends on every request.
- API keys used as Bearer tokens are never treated as users (no `sub` claim).
- The user object includes `is_anonymous` (Supabase anonymous sign-ins).
- Default CORS `Allow-Headers` include `x-retry-count`, `traceparent`,
  `tracestate` and `baggage`, which current supabase-js sends.
- OpenAPI: new `supabaseSecretKey` / `supabasePublishableKey` (`apikey` header)
  schemes; secret-key routes are documented with them. The legacy bearer
  schemes are marked deprecated.
- `createDefaultAuthHandler(container, { userLoader, tokenVerification })`
  replaces the positional `userLoader` argument. New exports:
  `resolveSupabaseKeys`, `SupabaseKeys`, `TokenVerification`,
  `DefaultAuthOptions`.

### Security

- **Default auth no longer trusts `user_metadata`.** The user object is built
  from `app_metadata` (server-controlled) plus `id`/`email`, or loaded via the
  new `userLoader` option. Previously any user could grant themselves a role
  with `auth.updateUser({ data: { role: "admin" } })` and could also override
  `id`/`email`.
- **Auth fails closed.** `requireUserAuth` now defaults to `true` for
  authenticated routes, and RBAC (`allowedRoles`) always requires a user.
  Previously an auth handler returning `{}` passed every check, including RBAC.
- **CORS preflight no longer allows every origin.** Route/router `CorsConfig`
  allowlists were merged over a `*` default, so disallowed origins still passed
  the preflight. Router-level `corsHeaders` is now applied (it was ignored),
  route-level `corsHeaders` accepts `CorsConfig`, and `Vary: Origin` is sent.
- Service role / anon keys are compared in constant time; the `Bearer` scheme
  is parsed strictly (case-insensitive).
- The anon-key bypass (`bypassWithAnonRole`) no longer counts as a trusted
  bypass: RBAC rejects it.
- Unhandled errors return a generic `500` with `requestId` instead of the raw
  error message; details go to `services.logger`. `errorHandlerMiddleware`
  and `createErrorResponseByEnv` only expose the message and stack trace when
  `isDevelopment` is true.
- `DEFAULT_SECURITY_HEADERS` sets `X-XSS-Protection: 0` (the legacy XSS auditor
  caused vulnerabilities; OWASP recommends disabling it). These headers are not
  applied automatically.

### Fixed

- Path parameters were URL-decoded twice (`/files/100%25` returned 400).
- Handlers now receive the parsed output of `params`/`query` schemas
  (e.g. `z.coerce.number()` yields a number, not a string).
- Handler `params`/`query`/`body` were typed as `any`; they are now inferred
  from `requestSchema`. `user` is no longer optional in authenticated handlers.
- Unknown method on a known path returns `405` with `Allow` (was `404`).
- `HEAD` requests are served by the matching `GET` route.
- A trailing slash is optional when matching (`basePath: "/hello"` with
  `path: "/"` now answers `/hello`, the path Edge Functions receive for the
  function root).
- Static segments take precedence over parameters (`/users/me` before
  `/users/:id`) regardless of declaration order.
- Malformed JSON bodies return `400 Malformed request body`; media types are
  matched exactly instead of by substring.
- Files stripped by a body schema are no longer re-added after validation.
- Error messages are no longer HTML-escaped (and `data:` etc. no longer removed)
  inside JSON responses.
- `statement_timeout` for the transaction pooler is sent as a connection
  parameter; the previous `SET ... = $1` always failed.
- `createContainer` accepts plain `Partial<ServiceContainer>` overrides; client
  caches are per container instead of module-global.
- Built-in `getOrCreateAnonClient` / `getOrCreateServiceClient` are rebound
  when a container is passed through `createContainer` again (including by
  `defineRouter`), so `env` / `supabaseClientFactory` overrides applied via
  spread are no longer silently ignored.
- `timeoutMiddleware` type-checks on current Deno.
- `statementTimeoutMs` is verified after connecting. Transaction poolers
  (Supabase Supavisor on port 6543, PgBouncer) silently drop connection startup
  parameters; the router now logs a warning with the `ALTER ROLE ... SET
  statement_timeout` fix instead of failing silently.
- Removed relative imports from JSDoc examples. The Supabase CLI scans comments
  for imports when bundling, so vendoring the library into
  `supabase/functions/_shared` made `supabase functions serve/deploy` fail.

### Changed (breaking)

- **Zod 4** is required (`zod@^4.6.5`). OpenAPI generation uses Zod's built-in
  `toJSONSchema`; `zod-to-json-schema` was removed.
- **Middleware order:** global middlewares now wrap the whole pipeline and run
  before auth and body parsing; route middlewares run right before the handler.
- OpenAPI schemas are inlined per operation (`components.schemas` is empty);
  previously all routes shared names like `RequestBody` and overwrote each
  other. Every path parameter is declared. `extractSchema(schema, direction)`
  replaces `extractSchema(schema, name)`; `getGlobalSchemas` and
  `clearSchemaCache` were removed.
- **Removed `rateLimitMiddleware`.** The in-memory limiter did not work on
  Edge Functions (state per short-lived instance), put every client without
  `x-forwarded-for` into one shared bucket (one client could block everyone),
  was bypassable by changing that header, and never evicted keys.
  `examples/redis-rate-limit.ts` now provides `rateLimit()` on top of
  `@upstash/ratelimit` (atomic sliding window); the non-functional
  `tokenBucketRateLimitMiddleware` placeholder was removed.
- New `openapi` router option (`title`, `version`, `description`, `servers`).
- `defaultTags` is optional. Routes remain authenticated by default: public
  routes need `authRequired: false`.
- `MiddlewareContext` includes `requestId`; `requestIdMiddleware` reuses it.
- `getOrCreateDbClient` may return a promise; `drizzle-orm` and `postgres` are
  loaded lazily only when the transaction pooler is enabled.
- The `requireServiceRole` warning is logged once via `services.logger` when the
  router is created, instead of `console.warn` in `defineRoute`.

### Added

- `matchRouteRaw`, `resolveCorsHeaders`, `assertValidCorsConfig`,
  `parseBearerToken`, `timingSafeEqual`, `PublicContext`, `OpenAPIConfig`, and a
  re-export of the `SupabaseClient` type.

### Tooling

- `deno.json` (replaces `jsr.json`) with pinned dependencies via an import map,
  and tasks: `check`, `lint`, `lint:complexity`, `test`, `ci`.
- ESLint (`deno task lint:complexity`) enforces cyclomatic complexity ≤ 10,
  `max-depth` 3, `max-params` 4, `max-nested-callbacks` 3 and
  `max-lines-per-function` 60.
- Unit/regression tests in `tests/` (`deno task test`).
- Integration tests in `tests/integration/` against a throwaway local Supabase
  stack (`deno task test:integration [--alg ES256|RS256]`, needs Docker and the
  Supabase CLI): real ES256/RS256 tokens, key rotation, HS256 fallback, RLS,
  secret keys, Supavisor, and the router running in the Edge Runtime.
- `deno doc --lint` clean for missing JSDoc; all types referenced by the public
  API are exported.
