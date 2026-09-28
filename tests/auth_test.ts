import { assertEquals } from "@std/assert";
import { defineRoute, defineRouter, parseBearerToken } from "../mod.ts";
import { createTestContainer, request } from "./helpers.ts";

const USERS = {
  "admin-token": {
    id: "u-admin",
    email: "admin@example.com",
    app_metadata: { role: "admin" },
    user_metadata: {},
  },
  // Tried to escalate via self-editable user_metadata
  "sneaky-token": {
    id: "u-sneaky",
    email: "sneaky@example.com",
    app_metadata: { role: "user" },
    user_metadata: { role: "admin", id: "u-admin", email: "admin@example.com" },
  },
};

const adminRoute = defineRoute({
  method: "POST",
  path: "/admin",
  allowedRoles: ["admin"],
  handler: ({ user }) => Promise.resolve({ user }),
});

const makeRouter = (extra: Parameters<typeof defineRouter>[0] = {
  basePath: "/api",
  defaultTags: [],
  routes: [],
}) =>
  defineRouter({
    ...extra,
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(USERS),
    routes: [adminRoute, ...extra.routes],
  });

Deno.test("role comes from app_metadata, not user-editable user_metadata", async () => {
  const router = makeRouter();

  const sneaky = await router.handler(
    request("/api/admin", { method: "POST", token: "sneaky-token" }),
  );
  assertEquals(sneaky.status, 403);

  const admin = await router.handler(
    request("/api/admin", { method: "POST", token: "admin-token" }),
  );
  assertEquals(admin.status, 200);
  const { user } = await admin.json();
  assertEquals(user.id, "u-admin");
  assertEquals(user.role, "admin");
});

Deno.test("user_metadata cannot override id or email", async () => {
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(USERS),
    routes: [
      defineRoute({
        method: "GET",
        path: "/me",
        handler: ({ user }) => Promise.resolve(user),
      }),
    ],
  });
  const res = await router.handler(
    request("/api/me", { token: "sneaky-token" }),
  );
  const user = await res.json();
  assertEquals(user.id, "u-sneaky");
  assertEquals(user.email, "sneaky@example.com");
  assertEquals(user.role, "user");
  assertEquals(user.user_metadata.role, "admin");
});

Deno.test("userLoader provides the user when configured", async () => {
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(USERS),
    userLoader: (id) => Promise.resolve({ id, role: "admin" }),
    routes: [adminRoute],
  });
  const res = await router.handler(
    request("/api/admin", { method: "POST", token: "sneaky-token" }),
  );
  assertEquals(res.status, 200);
});

Deno.test("RBAC fails closed when a custom auth handler returns no user", async () => {
  let called = false;
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(),
    authHandler: () => Promise.resolve({}),
    routes: [
      defineRoute({
        method: "POST",
        path: "/admin",
        allowedRoles: ["admin"],
        handler: () => {
          called = true;
          return Promise.resolve({});
        },
      }),
    ],
  });
  const res = await router.handler(request("/api/admin", { method: "POST" }));
  assertEquals(res.status, 401);
  assertEquals(called, false);
});

Deno.test("authenticated route without user is rejected by default", async () => {
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(),
    authHandler: () => Promise.resolve({}),
    routes: [
      defineRoute({
        method: "GET",
        path: "/private",
        handler: () => Promise.resolve({}),
      }),
    ],
  });
  const res = await router.handler(request("/api/private"));
  assertEquals(res.status, 401);
});

Deno.test("requireUserAuth: false makes auth optional but RBAC still needs a user", async () => {
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(USERS),
    routes: [
      defineRoute({
        method: "GET",
        path: "/optional",
        authentication: { requireUserAuth: false },
        handler: ({ user }) => Promise.resolve({ user: user ?? null }),
      }),
      defineRoute({
        method: "GET",
        path: "/optional-admin",
        authentication: { requireUserAuth: false },
        allowedRoles: ["admin"],
        handler: () => Promise.resolve({}),
      }),
    ],
  });

  const anonymous = await router.handler(request("/api/optional"));
  assertEquals(anonymous.status, 200);
  assertEquals((await anonymous.json()).user, null);

  const withUser = await router.handler(
    request("/api/optional", { token: "admin-token" }),
  );
  assertEquals((await withUser.json()).user.id, "u-admin");

  const rbac = await router.handler(request("/api/optional-admin"));
  assertEquals(rbac.status, 401);
});

Deno.test("anon key bypass never satisfies RBAC", async () => {
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(),
    routes: [
      defineRoute({
        method: "GET",
        path: "/anon",
        authentication: { bypassWithAnonRole: true },
        handler: () => Promise.resolve({ ok: true }),
      }),
      defineRoute({
        method: "GET",
        path: "/anon-admin",
        authentication: { bypassWithAnonRole: true },
        allowedRoles: ["admin"],
        handler: () => Promise.resolve({ ok: true }),
      }),
    ],
  });
  const ok = await router.handler(request("/api/anon", { token: "anon-key" }));
  assertEquals(ok.status, 200);
  const denied = await router.handler(
    request("/api/anon-admin", { token: "anon-key" }),
  );
  assertEquals(denied.status, 401);
});

Deno.test("service role key only works on routes that opt in", async () => {
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(),
    routes: [
      defineRoute({
        method: "POST",
        path: "/internal",
        authentication: { requireServiceRole: true },
        handler: ({ serviceRoleClient }) =>
          Promise.resolve({ hasServiceClient: !!serviceRoleClient }),
      }),
      defineRoute({
        method: "GET",
        path: "/private",
        handler: () => Promise.resolve({}),
      }),
    ],
  });

  const internal = await router.handler(
    request("/api/internal", { method: "POST", token: "service-key" }),
  );
  assertEquals(await internal.json(), { hasServiceClient: true });

  const wrongKey = await router.handler(
    request("/api/internal", { method: "POST", token: "anon-key" }),
  );
  assertEquals(wrongKey.status, 401);

  const notOptedIn = await router.handler(
    request("/api/private", { token: "service-key" }),
  );
  assertEquals(notOptedIn.status, 401);
});

Deno.test("parseBearerToken is strict and case-insensitive", () => {
  assertEquals(parseBearerToken("Bearer abc"), "abc");
  assertEquals(parseBearerToken("bearer abc"), "abc");
  assertEquals(parseBearerToken("abc"), null);
  assertEquals(parseBearerToken("Basic abc"), null);
  assertEquals(parseBearerToken("Bearer "), null);
  assertEquals(parseBearerToken(null), null);
});
