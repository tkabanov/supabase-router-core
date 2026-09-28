import { assert, assertEquals } from "@std/assert";
import {
  createRouterKit,
  DEFAULT_CORS_ALLOWED_HEADERS,
  defineRoute,
  defineRouter,
  type Middleware,
  type RouteInfo,
  type RouterErrorInfo,
} from "../mod.ts";
import { createTestContainer, request } from "./helpers.ts";

const USERS = {
  "user-token": {
    id: "u1",
    email: "u1@example.com",
    app_metadata: { role: "admin" },
    user_metadata: {},
  },
};

// ------------------------------------------------ defaultAuthentication

const serviceRouter = () => {
  const container = createTestContainer(USERS);
  const service = createRouterKit<{ user: { id: string } }>()
    .withAuthDefaults({ requireServiceRole: true });
  const router = service.defineRouter({
    basePath: "/tasks",
    container,
    routes: [
      service.defineRoute({
        method: "POST",
        path: "/run",
        handler: () => Promise.resolve({ ran: true }),
      }),
      service.defineRoute({
        method: "POST",
        path: "/cleanup",
        authentication: {}, // does not reset the defaults
        handler: () => Promise.resolve({ cleaned: true }),
      }),
      service.defineRoute({
        method: "GET",
        path: "/mine",
        authentication: { requireServiceRole: false },
        handler: ({ user }) => Promise.resolve(user),
      }),
      service.defineRoute({
        method: "GET",
        path: "/health",
        authRequired: false,
        handler: () => Promise.resolve({ ok: true }),
      }),
    ],
  });
  return { router, container };
};

const status = async (res: Promise<Response>) => {
  const response = await res;
  await response.body?.cancel();
  return response.status;
};

Deno.test("defaultAuthentication applies to every authenticated route", async () => {
  const { router } = serviceRouter();
  for (const path of ["/tasks/run", "/tasks/cleanup"]) {
    assertEquals(
      await status(router.handler(request(path, { method: "POST" }))),
      401,
      path,
    );
    assertEquals(
      await status(
        router.handler(request(path, { method: "POST", token: "service-key" })),
      ),
      200,
      path,
    );
    // A user token is not enough
    assertEquals(
      await status(
        router.handler(request(path, { method: "POST", token: "user-token" })),
      ),
      401,
      path,
    );
  }
});

Deno.test("a route opts out of a default flag explicitly; public routes are unaffected", async () => {
  const { router } = serviceRouter();
  const mine = await router.handler(
    request("/tasks/mine", { token: "user-token" }),
  );
  assertEquals((await mine.json()).id, "u1");
  assertEquals(await status(router.handler(request("/tasks/health"))), 200);
});

Deno.test("requireServiceRole warning is logged once per router", () => {
  const { container } = serviceRouter();
  const warnings = container.logs.filter(([level]) => level === "warn");
  assertEquals(warnings.length, 1);
  const message = String(warnings[0][1]);
  assert(message.includes("POST /tasks/run"));
  assert(message.includes("POST /tasks/cleanup"));
  assert(!message.includes("/tasks/mine"));
  assert(!message.includes("/tasks/health"));
});

Deno.test("OpenAPI reflects the merged authentication", () => {
  const spec = serviceRouter().router.openapi();
  assertEquals(spec.paths["/tasks/run"].post.security, [
    { supabaseSecretKey: [] },
  ]);
  assertEquals(spec.paths["/tasks/mine"].get.security, [
    { supabaseBearerAuth: [] },
  ]);
});

Deno.test("allowedMethods is never taken from the defaults", async () => {
  const router = defineRouter({
    basePath: "/api",
    container: createTestContainer(USERS),
    // Not allowed by the type; make sure the runtime ignores it too
    defaultAuthentication: { allowedMethods: ["DELETE"] } as never,
    routes: [
      defineRoute({
        method: "GET",
        path: "/me",
        handler: ({ user }) => Promise.resolve(user),
      }),
    ],
  });
  assertEquals(
    await status(router.handler(request("/api/me", { token: "user-token" }))),
    200,
  );
});

// ------------------------------------------------ route info and match

const infoRouter = (middlewares: Middleware[] = [], extra = {}) =>
  defineRouter({
    basePath: "/api",
    defaultTags: ["API"],
    container: createTestContainer(USERS),
    middlewares,
    ...extra,
    routes: [
      defineRoute({
        method: "GET",
        path: "/users/:id",
        tags: ["Users"],
        authRequired: false,
        handler: ({ params }) => Promise.resolve(params),
      }),
      defineRoute({
        method: "POST",
        path: "/boom",
        handler: () => {
          throw new Error("secret detail");
        },
      }),
    ],
  });

Deno.test("global middlewares see the route template", async () => {
  let seen: RouteInfo | undefined;
  const router = infoRouter([(ctx, next) => {
    seen = ctx.route;
    return next();
  }]);
  await status(router.handler(request("/api/users/42")));
  assertEquals(seen, {
    method: "GET",
    path: "/api/users/:id",
    tags: ["API", "Users"],
  });
});

Deno.test("router.match uses the same matching as handler", () => {
  const router = infoRouter();
  const expected = {
    method: "GET",
    path: "/api/users/:id",
    tags: ["API", "Users"],
  };
  assertEquals(router.match(request("/api/users/42")), expected);
  assertEquals(router.match(request("/api/users/42/")), expected);
  assertEquals(
    router.match(request("/api/users/42", { method: "HEAD" })),
    expected,
  );
  assertEquals(
    router.match(request("/api/users/42", { method: "OPTIONS" })),
    null,
  );
  assertEquals(router.match(request("/api/nope")), null);
  assertEquals(
    router.match(request("/api/users/42", { method: "DELETE" })),
    null,
  );
});

// ------------------------------------------------------------ onError

Deno.test("onError receives the error with request, route and user", async () => {
  const calls: Array<[unknown, RouterErrorInfo]> = [];
  const router = infoRouter([], {
    onError: (error: unknown, info: RouterErrorInfo) => {
      calls.push([error, info]);
    },
  });
  const res = await router.handler(
    request("/api/boom", { method: "POST", token: "user-token" }),
  );
  assertEquals(res.status, 500);
  assertEquals(await res.json(), {
    error: "Internal server error",
    requestId: "req-1",
  });

  assertEquals(calls.length, 1);
  const [error, info] = calls[0];
  assertEquals((error as Error).message, "secret detail");
  assertEquals(info.requestId, "req-1");
  assertEquals(info.route?.path, "/api/boom");
  assertEquals((info.user as { id: string }).id, "u1");
  assertEquals(info.req.method, "POST");
});

Deno.test("onError can replace the response; CORS headers are still added", async () => {
  const router = infoRouter([], {
    onError: () => Response.json({ error: "tracked" }, { status: 503 }),
  });
  const res = await router.handler(
    request("/api/boom", { method: "POST", token: "user-token" }),
  );
  assertEquals(res.status, 503);
  assertEquals(await res.json(), { error: "tracked" });
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
});

Deno.test("a failing onError hook falls back to the generic 500", async () => {
  const router = infoRouter([], {
    onError: () => {
      throw new Error("hook broke");
    },
  });
  const res = await router.handler(
    request("/api/boom", { method: "POST", token: "user-token" }),
  );
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error, "Internal server error");
});

Deno.test("onError is not called for thrown Responses or handled errors", async () => {
  let calls = 0;
  const router = infoRouter([], { onError: () => void calls++ });
  await status(router.handler(request("/api/nope")));
  await status(router.handler(request("/api/boom", { method: "POST" }))); // 401
  assertEquals(calls, 0);
});

Deno.test("errors before authentication report no user", async () => {
  const infos: RouterErrorInfo[] = [];
  const router = infoRouter([() => {
    throw new Error("middleware failed");
  }], {
    onError: (_: unknown, info: RouterErrorInfo) => void infos.push(info),
  });
  await status(router.handler(request("/api/users/1")));
  assertEquals(infos[0].user, undefined);
  assertEquals(infos[0].route?.path, "/api/users/:id");
});

Deno.test("DEFAULT_CORS_ALLOWED_HEADERS can be extended", async () => {
  const router = defineRouter({
    basePath: "/api",
    container: createTestContainer(),
    corsHeaders: {
      allowedOrigins: "*",
      allowedHeaders: [...DEFAULT_CORS_ALLOWED_HEADERS, "x-custom"],
    },
    routes: [
      defineRoute({
        method: "GET",
        path: "/x",
        authRequired: false,
        handler: () => Promise.resolve({}),
      }),
    ],
  });
  const res = await router.handler(request("/api/x", { method: "OPTIONS" }));
  const allowed = res.headers.get("access-control-allow-headers")!;
  assert(allowed.includes("apikey"));
  assert(allowed.includes("x-custom"));
});

Deno.test("plain defaultAuthentication applies kind-neutral options (RBAC)", async () => {
  const router = defineRouter({
    basePath: "/admin",
    container: createTestContainer({
      ...USERS,
      "plain-token": {
        id: "u2",
        email: "u2@example.com",
        app_metadata: { role: "user" },
        user_metadata: {},
      },
    }),
    defaultAuthentication: { requireRBAC: true, allowedRoles: ["admin"] },
    routes: [
      defineRoute({
        method: "GET",
        path: "/stats",
        handler: () => Promise.resolve({ ok: true }),
      }),
    ],
  });
  assertEquals(
    await status(
      router.handler(request("/admin/stats", { token: "user-token" })),
    ),
    200,
  );
  assertEquals(
    await status(
      router.handler(request("/admin/stats", { token: "plain-token" })),
    ),
    403,
  );
});
