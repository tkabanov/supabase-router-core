import { assertEquals, assertStringIncludes } from "@std/assert";
import { defineRoute, defineRouter, resolveSupabaseKeys } from "../mod.ts";
import {
  createTestContainer,
  LEGACY_ENV,
  NEW_KEYS_ENV,
  request,
} from "./helpers.ts";

const USERS = {
  "user-jwt": {
    id: "u1",
    email: "u1@example.com",
    app_metadata: { role: "admin" },
    user_metadata: {},
  },
};

const envOf = (vars: Record<string, string>) => ({
  get: (k: string) => vars[k],
  require: (k: string) => vars[k],
});

Deno.test("resolveSupabaseKeys: new JSON keys first, then single, then legacy", () => {
  const keys = resolveSupabaseKeys(envOf({
    ...NEW_KEYS_ENV,
    SUPABASE_SECRET_KEY: "sb_secret_local",
    SUPABASE_SERVICE_ROLE_KEY: "legacy-service",
  }));
  assertEquals(keys.primaryPublishableKey, "sb_publishable_default");
  assertEquals(keys.publishableKeys, [
    "sb_publishable_default",
    "sb_publishable_mobile",
  ]);
  assertEquals(keys.secretKeys, [
    "sb_secret_default",
    "sb_secret_local",
    "legacy-service",
  ]);
  assertEquals(keys.jwks?.keys[0].kid, "k1");

  const legacy = resolveSupabaseKeys(envOf(LEGACY_ENV));
  assertEquals(legacy.primaryPublishableKey, "anon-key");
  assertEquals(legacy.primarySecretKey, "service-key");
  assertEquals(legacy.jwks, undefined);
});

const makeRouter = (env = NEW_KEYS_ENV, tokenVerification?: "auth-server") => {
  const container = createTestContainer(USERS, {}, env);
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container,
    tokenVerification,
    routes: [
      defineRoute({
        method: "GET",
        path: "/me",
        handler: ({ user }) => Promise.resolve(user),
      }),
      defineRoute({
        method: "POST",
        path: "/internal",
        authentication: { requireServiceRole: true },
        handler: () => Promise.resolve({ internal: true }),
      }),
      defineRoute({
        method: "GET",
        path: "/feed",
        authentication: { bypassWithAnonRole: true },
        handler: ({ user }) =>
          Promise.resolve({
            user: (user as { id?: string } | undefined)?.id ?? null,
          }),
      }),
    ],
  });
  return { router, container };
};

Deno.test("user JWT is verified locally with getClaims and SUPABASE_JWKS", async () => {
  const { router, container } = makeRouter();
  const res = await router.handler(request("/api/me", { token: "user-jwt" }));
  assertEquals(res.status, 200);
  const user = await res.json();
  assertEquals(user.id, "u1");
  assertEquals(user.role, "admin");
  assertEquals(user.is_anonymous, false);

  const [method, , options] = container.calls[0];
  assertEquals(method, "getClaims");
  assertEquals(options, { jwks: { keys: [{ kid: "k1", kty: "EC" }] } });
});

Deno.test("tokenVerification: auth-server uses getUser", async () => {
  const { router, container } = makeRouter(NEW_KEYS_ENV, "auth-server");
  const res = await router.handler(request("/api/me", { token: "user-jwt" }));
  assertEquals((await res.json()).id, "u1");
  assertEquals(container.calls[0][0], "getUser");
});

Deno.test("secret key is accepted on the apikey header", async () => {
  const { router } = makeRouter();
  const res = await router.handler(
    request("/api/internal", {
      method: "POST",
      headers: { apikey: "sb_secret_default" },
    }),
  );
  assertEquals(res.status, 200);

  const publishable = await router.handler(
    request("/api/internal", {
      method: "POST",
      headers: { apikey: "sb_publishable_default" },
    }),
  );
  assertEquals(publishable.status, 401);
  assertStringIncludes((await publishable.json()).error, "Secret key");
});

Deno.test("legacy service_role key still works as a Bearer token", async () => {
  const { router } = makeRouter(LEGACY_ENV);
  const res = await router.handler(
    request("/api/internal", { method: "POST", token: "service-key" }),
  );
  assertEquals(res.status, 200);
});

Deno.test("publishable key in apikey never hides a signed-in user", async () => {
  const { router } = makeRouter();
  // What supabase-js sends for a signed-in user
  const signedIn = await router.handler(
    request("/api/feed", {
      token: "user-jwt",
      headers: { apikey: "sb_publishable_default" },
    }),
  );
  assertEquals(await signedIn.json(), { user: "u1" });

  // What supabase-js sends without a session
  const anonymous = await router.handler(
    request("/api/feed", {
      token: "sb_publishable_default",
      headers: { apikey: "sb_publishable_default" },
    }),
  );
  assertEquals(await anonymous.json(), { user: null });

  const noKey = await router.handler(request("/api/feed"));
  assertEquals(noKey.status, 401);
});

Deno.test("API keys used as Bearer tokens are not users", async () => {
  const { router } = makeRouter();
  const res = await router.handler(
    request("/api/me", { token: "sb_secret_default" }),
  );
  assertEquals(res.status, 401);
});

Deno.test("default CORS allows headers sent by current supabase-js", async () => {
  const { router } = makeRouter();
  const res = await router.handler(
    request("/api/me", {
      method: "OPTIONS",
      headers: { origin: "https://app.example" },
    }),
  );
  const allowed = res.headers.get("access-control-allow-headers")!;
  for (const header of ["apikey", "x-retry-count", "traceparent", "baggage"]) {
    assertStringIncludes(allowed, header);
  }
});

Deno.test("OpenAPI documents secret-key routes with the apikey scheme", () => {
  const { router } = makeRouter();
  const spec = router.openapi();
  assertEquals(spec.paths["/api/internal"].post.security, [
    { supabaseSecretKey: [] },
  ]);
  assertEquals(spec.paths["/api/feed"].get.security, [
    { supabaseBearerAuth: [] },
    { supabasePublishableKey: [] },
  ]);
  assertEquals(spec.components.securitySchemes.supabaseSecretKey, {
    type: "apiKey",
    in: "header",
    name: "apikey",
    description:
      "Supabase secret key (`sb_secret_...`). Server-to-server only; bypasses RLS.",
  });
});

Deno.test("clients without getClaims (older SDKs, test mocks) fall back to getUser", async () => {
  const container = createTestContainer(USERS, {}, LEGACY_ENV);
  const createClient = container.supabaseClientFactory.create;
  container.supabaseClientFactory = {
    ...container.supabaseClientFactory,
    create: (url, key) => {
      const client = createClient(url, key);
      const { getUser } = client.auth;
      return { auth: { getUser } } as unknown as typeof client;
    },
  };
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container,
    routes: [
      defineRoute({
        method: "GET",
        path: "/me",
        handler: ({ user }) => Promise.resolve(user),
      }),
    ],
  });
  const res = await router.handler(request("/api/me", { token: "user-jwt" }));
  assertEquals((await res.json()).id, "u1");
  assertEquals(container.calls[0][0], "getUser");
});
