import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  defineRoute,
  defineRouter,
  resolveCorsHeaders,
  timingSafeEqual,
} from "../mod.ts";
import { createTestContainer, request } from "./helpers.ts";

const cors = { allowedOrigins: ["https://good.example"] };

const makeRouter = () =>
  defineRouter({
    basePath: "/api",
    defaultTags: ["API"],
    container: createTestContainer(),
    corsHeaders: cors,
    routes: [
      defineRoute({
        method: "POST",
        path: "/items",
        authRequired: false,
        handler: () => Promise.resolve({}),
      }),
      defineRoute({
        method: "GET",
        path: "/public",
        authRequired: false,
        corsHeaders: { allowedOrigins: "*" },
        handler: () => Promise.resolve({}),
      }),
    ],
  });

const preflight = (path: string, origin: string, method = "POST") =>
  request(path, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": method },
  });

Deno.test("preflight from a disallowed origin gets no Allow-Origin", async () => {
  const router = makeRouter();
  const evil = await router.handler(
    preflight("/api/items", "https://evil.example"),
  );
  assertEquals(evil.status, 204);
  assertEquals(evil.headers.get("access-control-allow-origin"), null);
  assertEquals(evil.headers.get("vary"), "Origin");

  const good = await router.handler(
    preflight("/api/items", "https://good.example"),
  );
  assertEquals(
    good.headers.get("access-control-allow-origin"),
    "https://good.example",
  );
  assertEquals(
    good.headers.get("access-control-allow-methods"),
    "POST, OPTIONS",
  );
});

Deno.test("router-level CORS applies to responses; route-level overrides it", async () => {
  const router = makeRouter();
  const res = await router.handler(
    request("/api/items", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    }),
  );
  assertEquals(res.headers.get("access-control-allow-origin"), null);

  const open = await router.handler(
    request("/api/public", { headers: { origin: "https://evil.example" } }),
  );
  assertEquals(open.headers.get("access-control-allow-origin"), "*");
});

Deno.test("wildcard origin with credentials is rejected at startup", () => {
  assertThrows(() =>
    defineRouter({
      basePath: "/api",
      defaultTags: [],
      container: createTestContainer(),
      routes: [
        defineRoute({
          method: "GET",
          path: "/x",
          authRequired: false,
          corsHeaders: { allowedOrigins: "*", credentials: true },
          handler: () => Promise.resolve({}),
        }),
      ],
    })
  );
});

Deno.test("resolveCorsHeaders defaults to permissive headers", () => {
  const headers = resolveCorsHeaders(null, undefined, ["GET", "OPTIONS"]);
  assertEquals(headers["Access-Control-Allow-Origin"], "*");
  assertEquals(headers["Access-Control-Allow-Methods"], "GET, OPTIONS");
});

Deno.test("timingSafeEqual", () => {
  assertEquals(timingSafeEqual("abc", "abc"), true);
  assertEquals(timingSafeEqual("abc", "abd"), false);
  assertEquals(timingSafeEqual("abc", "abcd"), false);
  assertEquals(timingSafeEqual("", ""), true);
});

Deno.test("OpenAPI: per-route inline schemas, declared path params, metadata", () => {
  const router = defineRouter({
    basePath: "/api",
    defaultTags: ["API"],
    container: createTestContainer(),
    openapi: { title: "Shop", version: "2.1.0" },
    routes: [
      defineRoute({
        method: "POST",
        path: "/users/:id",
        requestSchema: { body: z.object({ name: z.string() }) },
        handler: () => Promise.resolve({}),
      }),
      defineRoute({
        method: "POST",
        path: "/orders",
        requestSchema: { body: z.object({ total: z.number() }) },
        handler: () => Promise.resolve({}),
      }),
    ],
  });
  const spec = router.openapi();
  assertEquals(spec.info, { title: "Shop", version: "2.1.0" });

  const user = spec.paths["/api/users/{id}"].post;
  assertEquals(user.parameters, [
    { in: "path", name: "id", required: true, schema: { type: "string" } },
  ]);
  const userBody = user.requestBody!.content["application/json"].schema;
  assertEquals(Object.keys(userBody.properties as object), ["name"]);

  const orderBody = spec.paths["/api/orders"].post.requestBody!
    .content["application/json"].schema;
  assertEquals(Object.keys(orderBody.properties as object), ["total"]);

  // No shared definitions that could collide between routes
  assertEquals(spec.components.schemas, {});
  assertEquals(JSON.stringify(spec).includes("#/definitions"), false);
});
