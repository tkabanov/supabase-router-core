import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import {
  createContainer,
  defineRoute,
  defineRouter,
  type Middleware,
} from "../mod.ts";
import { createTestContainer, request } from "./helpers.ts";

const publicRoute = <T>(
  method: string,
  path: string,
  handler: (ctx: { params: unknown; query: unknown; body: unknown }) => T,
) =>
  defineRoute({
    method,
    path,
    authRequired: false,
    handler: (ctx) => Promise.resolve(handler(ctx)),
  });

Deno.test("path params are decoded exactly once", async () => {
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(),
    routes: [publicRoute("GET", "/files/:name", ({ params }) => params)],
  });
  const res = await router.handler(request("/api/files/100%25"));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { name: "100%" });

  const traversal = await router.handler(request("/api/files/..%2Fetc"));
  assertEquals(traversal.status, 400);
});

Deno.test("handlers receive parsed params and query", async () => {
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(),
    routes: [
      defineRoute({
        method: "GET",
        path: "/items/:id",
        authRequired: false,
        requestSchema: {
          params: z.object({ id: z.coerce.number() }),
          query: z.object({ page: z.coerce.number().default(1) }),
        },
        handler: ({ params, query }) =>
          Promise.resolve({ id: params.id, page: query.page }),
      }),
    ],
  });
  const res = await router.handler(request("/api/items/42"));
  assertEquals(await res.json(), { id: 42, page: 1 });

  const invalid = await router.handler(request("/api/items/abc"));
  assertEquals(invalid.status, 400);
  const body = await invalid.json();
  assertEquals(body.error, "Path parameter validation failed");
  assertEquals(body.details[0].path, ["id"]);
});

Deno.test("static segments win over params regardless of declaration order", async () => {
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(),
    routes: [
      publicRoute("GET", "/users/:id", () => "by-id"),
      publicRoute("GET", "/users/me", () => "me"),
    ],
  });
  const res = await router.handler(request("/api/users/me"));
  assertEquals(await res.json(), "me");
});

Deno.test("wrong method returns 405 with Allow; unknown path returns 404", async () => {
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(),
    routes: [publicRoute("GET", "/items", () => [])],
  });
  const wrongMethod = await router.handler(
    request("/api/items", { method: "DELETE" }),
  );
  assertEquals(wrongMethod.status, 405);
  assertStringIncludes(wrongMethod.headers.get("allow")!, "GET");
  assertEquals(wrongMethod.headers.get("content-type"), "application/json");

  const missing = await router.handler(request("/api/nope"));
  assertEquals(missing.status, 404);
  assertEquals(missing.headers.get("content-type"), "application/json");
});

Deno.test("HEAD is served by the GET route without a body", async () => {
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(),
    routes: [publicRoute("GET", "/items", () => [1, 2])],
  });
  const res = await router.handler(request("/api/items", { method: "HEAD" }));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "");
});

Deno.test("global middlewares run before auth and body parsing", async () => {
  const order: string[] = [];
  const limiter: Middleware = () => {
    order.push("limiter");
    return Promise.resolve(new Response("slow down", { status: 429 }));
  };
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(),
    authHandler: () => {
      order.push("auth");
      return Promise.resolve({});
    },
    middlewares: [limiter],
    routes: [
      defineRoute({
        method: "POST",
        path: "/login",
        requestSchema: { body: z.object({ password: z.string() }) },
        handler: () => Promise.resolve({}),
      }),
    ],
  });
  const res = await router.handler(
    request("/api/login", { method: "POST", body: "{not json" }),
  );
  assertEquals(res.status, 429);
  assertEquals(order, ["limiter"]);
});

Deno.test("route middlewares see the authenticated user and parsed body", async () => {
  let seen: unknown;
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(),
    authHandler: () => Promise.resolve({ user: { id: "u1" } }),
    routes: [
      defineRoute({
        method: "POST",
        path: "/items",
        requestSchema: { body: z.object({ name: z.string() }) },
        middlewares: [(ctx, next) => {
          seen = { user: ctx.user, body: ctx.body };
          return next();
        }],
        handler: () => Promise.resolve({}),
      }),
    ],
  });
  await router.handler(
    request("/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    }),
  );
  assertEquals(seen, { user: { id: "u1" }, body: { name: "x" } });
});

Deno.test("unexpected errors become a generic 500 with CORS and are logged", async () => {
  const container = createTestContainer();
  const failing: Middleware = () => {
    throw new Error("secret connection string postgres://...");
  };
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container,
    middlewares: [failing],
    routes: [publicRoute("GET", "/items", () => [])],
  });
  const res = await router.handler(request("/api/items"));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), {
    error: "Internal server error",
    requestId: "req-1",
  });
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertEquals(container.logs[0][0], "error");
});

Deno.test("thrown error helpers produce their status", async () => {
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(),
    routes: [
      defineRoute({
        method: "GET",
        path: "/missing",
        authRequired: false,
        handler: (ctx) => {
          (ctx as unknown as { throwNotFound: () => never }).throwNotFound();
          return Promise.resolve({});
        },
      }),
    ],
  });
  const res = await router.handler(request("/api/missing"));
  assertEquals(res.status, 404);
});

Deno.test("body validation: malformed JSON, wrong media type, stripped files", async () => {
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(),
    routes: [
      defineRoute({
        method: "POST",
        path: "/upload",
        authRequired: false,
        supportedContentTypes: ["multipart/form-data", "application/json"],
        requestSchema: { body: z.object({ title: z.string() }) },
        handler: ({ body }) => Promise.resolve({ keys: Object.keys(body) }),
      }),
    ],
  });

  const malformed = await router.handler(
    request("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
  );
  assertEquals(malformed.status, 400);

  const xml = await router.handler(
    request("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/xml" },
      body: "<a/>",
    }),
  );
  assertEquals(xml.status, 415);

  const form = new FormData();
  form.set("title", "hello");
  form.set("extra", new File(["x"], "x.txt"));
  const multipart = await router.handler(
    request("/api/upload", { method: "POST", body: form }),
  );
  assertEquals(await multipart.json(), { keys: ["title"] });
});

Deno.test("error messages are not HTML-escaped inside JSON", async () => {
  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer(),
    routes: [
      defineRoute({
        method: "GET",
        path: "/bad",
        authRequired: false,
        handler: (ctx) => {
          (ctx as unknown as { throwBadRequest: (m: string) => never })
            .throwBadRequest('Use a/b or "quoted" data: values');
          return Promise.resolve({});
        },
      }),
    ],
  });
  const res = await router.handler(request("/api/bad"));
  assertEquals((await res.json()).error, 'Use a/b or "quoted" data: values');
});

Deno.test("database: missing pooler URL is a logged 500, custom client is awaited", async () => {
  const container = createTestContainer();
  const pooled = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container,
    database: { enableTransactionPooler: true },
    routes: [
      defineRoute({
        method: "GET",
        path: "/db",
        authRequired: false,
        useDatabase: true,
        handler: () => Promise.resolve({}),
      }),
    ],
  });
  const res = await pooled.handler(request("/api/db"));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "Database connection error" });
  assertEquals(container.logs[0][0], "error");

  const fakeDb = { fake: true } as never;
  const custom = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container: createTestContainer({}, {
      getOrCreateDbClient: () => Promise.resolve(fakeDb),
    }),
    routes: [
      defineRoute({
        method: "GET",
        path: "/db",
        authRequired: false,
        useDatabase: true,
        handler: ({ db }) => Promise.resolve({ db }),
      }),
    ],
  });
  const ok = await custom.handler(request("/api/db"));
  assertEquals(await ok.json(), { db: { fake: true } });
});

Deno.test("createContainer rebinds built-in client getters when re-wrapped or spread", () => {
  const made: string[] = [];
  const factory = (label: string) => ({
    create: (_url: string, key: string) => {
      made.push(`${label}:${key}`);
      return {} as never;
    },
    createWithToken: () => ({}) as never,
  });
  const envOf = (key: string) => ({
    get: (k: string) =>
      ({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: key })[k],
    require: (k: string) => k,
  });

  const base = createContainer({
    env: envOf("a"),
    supabaseClientFactory: factory("base"),
  });
  // Spread with a new env and factory: the new ones must be used
  createContainer({
    ...base,
    env: envOf("b"),
    supabaseClientFactory: factory("spread"),
  })
    .getOrCreateAnonClient();
  // A user-provided getter is still respected
  const custom = createContainer({
    getOrCreateAnonClient: () => ({ custom: true }) as never,
  });
  assertEquals(
    (createContainer({ ...custom }).getOrCreateAnonClient() as unknown as {
      custom: boolean;
    }).custom,
    true,
  );
  assertEquals(made, ["spread:b"]);
});

Deno.test("trailing slash is optional on both sides", async () => {
  const router = defineRouter({
    basePath: "/hello",
    container: createTestContainer(),
    routes: [
      publicRoute("GET", "/", () => "root"),
      publicRoute("GET", "/items", () => "items"),
    ],
  });
  for (const path of ["/hello", "/hello/", "/hello/items", "/hello/items/"]) {
    const res = await router.handler(request(path));
    assertEquals(res.status, 200, path);
    await res.body?.cancel();
  }
  const other = await router.handler(request("/hellox"));
  assertEquals(other.status, 404);
  await other.body?.cancel();
});
