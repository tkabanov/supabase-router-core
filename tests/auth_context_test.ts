import { assertEquals } from "@std/assert";
import {
  type CallerInfo,
  createRouterKit,
  defineRoute,
  defineRouter,
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

const seen: CallerInfo[] = [];
const record = (ctx: { auth: CallerInfo }) => {
  seen.push(ctx.auth);
  return Promise.resolve({ kind: ctx.auth.kind });
};

const router = defineRouter({
  basePath: "/api",
  container: createTestContainer(USERS),
  routes: [
    defineRoute({
      method: "POST",
      path: "/sync",
      authentication: { bypassWithServiceRole: true },
      handler: record,
    }),
    defineRoute({
      method: "GET",
      path: "/feed",
      authentication: { bypassWithAnonRole: true },
      handler: record,
    }),
    defineRoute({
      method: "GET",
      path: "/optional",
      authentication: { requireUserAuth: false },
      handler: record,
    }),
  ],
});

const kindOf = async (req: Request) => (await router.handler(req)).json();

Deno.test("ctx.auth tells users, services and anonymous callers apart", async () => {
  seen.length = 0;
  assertEquals(
    await kindOf(request("/api/sync", { method: "POST", token: "user-token" })),
    { kind: "user" },
  );
  assertEquals(
    await kindOf(
      request("/api/sync", { method: "POST", token: "service-key" }),
    ),
    { kind: "service" },
  );
  assertEquals(
    await kindOf(request("/api/feed", { token: "anon-key" })),
    { kind: "anon" },
  );
  // requireUserAuth: false without a token is "anon", not "user"
  assertEquals(await kindOf(request("/api/optional")), { kind: "anon" });

  const [user, service, anon] = seen;
  assertEquals(user.kind === "user" && user.user, {
    user_metadata: {},
    is_anonymous: false,
    id: "u1",
    email: "u1@example.com",
    role: "admin",
  });
  assertEquals(service.user, undefined);
  assertEquals(anon.user, undefined);
});

Deno.test("custom auth handler data reaches ctx.auth.data; extra options reach the handler", async () => {
  const optionsSeen: unknown[] = [];
  const kit = createRouterKit<{
    user: { id: string };
    authOptions: { freshUser?: boolean };
    authData: { sessionId: string };
  }>();
  const kitRouter = kit.defineRouter({
    basePath: "/api",
    container: createTestContainer(),
    authHandler: (_req, options) => {
      optionsSeen.push(options.freshUser);
      return Promise.resolve({
        user: { id: "u9" },
        data: { sessionId: "s-1" },
      });
    },
    routes: [
      kit.defineRoute({
        method: "GET",
        path: "/me",
        authentication: { freshUser: true },
        handler: (ctx) =>
          Promise.resolve({
            id: ctx.user.id,
            session: ctx.auth.data?.sessionId,
          }),
      }),
    ],
  });
  const body = await (await kitRouter.handler(request("/api/me"))).json();
  assertEquals(body, { id: "u9", session: "s-1" });
  assertEquals(optionsSeen, [true]);
});

Deno.test("route middlewares see ctx.auth", async () => {
  let kind: string | undefined;
  const r = defineRouter({
    basePath: "/api",
    container: createTestContainer(USERS),
    routes: [
      defineRoute({
        method: "GET",
        path: "/me",
        middlewares: [(ctx, next) => {
          kind = ctx.auth?.kind;
          return next();
        }],
        handler: () => Promise.resolve({}),
      }),
    ],
  });
  await (await r.handler(request("/api/me", { token: "user-token" }))).body
    ?.cancel();
  assertEquals(kind, "user");
});
