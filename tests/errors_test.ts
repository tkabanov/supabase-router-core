import { assertEquals } from "@std/assert";
import {
  createErrorResponseByEnv,
  defineRoute,
  defineRouter,
  errorHandlerMiddleware,
} from "../mod.ts";
import { createTestContainer, request } from "./helpers.ts";

const failingRouter = (isDevelopment: boolean) =>
  defineRouter({
    basePath: "/api",
    container: createTestContainer(),
    middlewares: [errorHandlerMiddleware(isDevelopment)],
    routes: [
      defineRoute({
        method: "GET",
        path: "/boom",
        authRequired: false,
        handler: () => {
          throw new Error("password=hunter2 at db.internal:5432");
        },
      }),
    ],
  });

Deno.test("errorHandlerMiddleware hides error details in production", async () => {
  const res = await failingRouter(false).handler(request("/api/boom"));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "Internal server error" });
});

Deno.test("errorHandlerMiddleware exposes message and stack in development", async () => {
  const body = await (await failingRouter(true).handler(request("/api/boom")))
    .json();
  assertEquals(body.error, "password=hunter2 at db.internal:5432");
  assertEquals(typeof body.stack, "string");
});

Deno.test("createErrorResponseByEnv only includes details in development", async () => {
  const error = new Error("secret detail");
  assertEquals(await createErrorResponseByEnv(error, false).json(), {
    error: "Internal server error",
  });
  assertEquals(
    (await createErrorResponseByEnv(error, true).json()).error,
    "secret detail",
  );
});
