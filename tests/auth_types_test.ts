// Type-level tests: checked by `deno check` (deno task check / ci).
// `@ts-expect-error` lines fail the check if the error disappears.
import { assertType, type IsExact } from "@std/testing/types";
import { z } from "zod";
import {
  type AuthKind,
  createRouterKit,
  defineRoute,
  defineRouter,
  type HandlerContext,
} from "../mod.ts";

type Role = "admin" | "user";
interface User {
  id: string;
  role: Role;
}

// Handlers only need to type-check; they are never called here
const ok = () => Promise.resolve({});

// ------------------------------------------------------- plain defineRoute

defineRoute<Role, User>({
  method: "GET",
  path: "/user-only",
  handler: (ctx) => {
    assertType<IsExact<typeof ctx.auth.kind, "user">>(true);
    assertType<IsExact<typeof ctx.user, User>>(true);
    return ok();
  },
});

defineRoute({
  method: "GET",
  path: "/inferred-user-only",
  handler: (ctx) => {
    assertType<IsExact<typeof ctx.auth.kind, "user">>(true);
    return ok();
  },
});

defineRoute({
  method: "POST",
  path: "/sync",
  authentication: { bypassWithServiceRole: true },
  handler: (ctx) => {
    assertType<IsExact<typeof ctx.auth.kind, "user" | "service">>(true);
    if (ctx.auth.kind === "user") {
      assertType<IsExact<typeof ctx.auth.user, unknown>>(true);
    } else {
      assertType<IsExact<typeof ctx.auth.user, undefined>>(true);
    }
    return ok();
  },
});

defineRoute({
  method: "POST",
  path: "/internal",
  authentication: { requireServiceRole: true },
  handler: (ctx) => {
    assertType<IsExact<typeof ctx.auth.kind, "service">>(true);
    assertType<IsExact<typeof ctx.user, undefined>>(true);
    return ok();
  },
});

defineRoute({
  method: "GET",
  path: "/feed",
  authentication: { bypassWithAnonRole: true },
  handler: (ctx) => {
    assertType<IsExact<typeof ctx.auth.kind, "user" | "anon">>(true);
    return ok();
  },
});

defineRoute({
  method: "GET",
  path: "/optional",
  authentication: { requireUserAuth: false },
  handler: (ctx) => {
    assertType<IsExact<typeof ctx.auth.kind, "user" | "anon">>(true);
    return ok();
  },
});

defineRoute({
  method: "GET",
  path: "/rbac-only",
  authentication: { requireRBAC: true, allowedRoles: ["admin"] },
  handler: (ctx) => {
    assertType<IsExact<typeof ctx.auth.kind, "user">>(true);
    return ok();
  },
});

defineRoute({
  method: "GET",
  path: "/health",
  authRequired: false,
  handler: (ctx) => {
    assertType<IsExact<typeof ctx.auth, undefined>>(true);
    return ok();
  },
});

// Explicit generic arguments cannot infer the literal: bypass flags must not
// silently keep `user: User`
defineRoute<Role, User>({
  method: "POST",
  path: "/explicit",
  // @ts-expect-error: true is not assignable to false
  authentication: { bypassWithServiceRole: true },
  handler: ok,
});

// Plain routers cannot default caller-kind flags (route types can't see them)
defineRouter({
  basePath: "/x",
  // @ts-expect-error: requireServiceRole is not a kind-neutral default
  defaultAuthentication: { requireServiceRole: true },
  routes: [],
});

// ---------------------------------------------------------- router kit

interface App {
  role: Role;
  user: User;
  authOptions: { freshUser?: boolean };
  authData: { sessionId: string };
}
const kit = createRouterKit<App>();

kit.defineRoute({
  method: "GET",
  path: "/me",
  allowedRoles: ["admin"],
  authentication: { freshUser: true },
  handler: (ctx) => {
    assertType<IsExact<typeof ctx.user, User>>(true);
    assertType<
      IsExact<typeof ctx.auth.data, { sessionId: string } | undefined>
    >(
      true,
    );
    return ok();
  },
});

kit.defineRoute({
  method: "GET",
  path: "/bad-role",
  // @ts-expect-error: not a Role
  allowedRoles: ["superuser"],
  handler: ok,
});

kit.defineRouter({
  basePath: "/api",
  authHandler: (_req, options) => {
    assertType<IsExact<typeof options.freshUser, boolean | undefined>>(true);
    return Promise.resolve({ data: { sessionId: "s" } });
  },
  routes: [],
});

const service = kit.withAuthDefaults({ requireServiceRole: true });

// Narrowing gives the typed user on mixed routes
kit.defineRoute({
  method: "POST",
  path: "/sync",
  authentication: { bypassWithServiceRole: true },
  handler: (ctx) => {
    assertType<IsExact<typeof ctx.user, User | undefined>>(true);
    // @ts-expect-error: may be a service call
    ctx.user.id;
    if (ctx.auth.kind === "user") {
      assertType<IsExact<typeof ctx.auth.user, User>>(true);
      return Promise.resolve({ owner: ctx.auth.user.id });
    }
    assertType<IsExact<typeof ctx.auth.kind, "service">>(true);
    return ok();
  },
});

service.defineRoute({
  method: "POST",
  path: "/run",
  handler: (ctx) => {
    assertType<IsExact<typeof ctx.auth.kind, "service">>(true);
    return ok();
  },
});

service.defineRoute({
  method: "GET",
  path: "/mine",
  authentication: { requireServiceRole: false },
  handler: (ctx) => {
    assertType<IsExact<typeof ctx.auth.kind, "user">>(true);
    assertType<IsExact<typeof ctx.user, User>>(true);
    return ok();
  },
});

// Handlers declared in another file
const itemSchema = { params: z.object({ id: z.string() }) };
const getItem = (ctx: HandlerContext<App, typeof itemSchema>) => {
  assertType<IsExact<typeof ctx.params, { id: string }>>(true);
  assertType<IsExact<typeof ctx.user, User>>(true);
  return Promise.resolve({ id: ctx.params.id, owner: ctx.user.id });
};

kit.defineRoute({
  method: "GET",
  path: "/items/:id",
  requestSchema: itemSchema,
  handler: getItem,
});

// Routes written inline in the routes array keep their own types
kit.defineRouter({
  basePath: "/inline",
  routes: [
    kit.defineRoute({
      method: "GET",
      path: "/me",
      handler: (ctx) => {
        assertType<IsExact<typeof ctx.user, User>>(true);
        assertType<IsExact<typeof ctx.auth.kind, "user">>(true);
        return ok();
      },
    }),
    defineRoute<Role, User>({
      method: "GET",
      path: "/plain",
      handler: (ctx) => {
        assertType<IsExact<typeof ctx.user, User>>(true);
        return ok();
      },
    }),
  ],
});

assertType<IsExact<AuthKind, "user" | "service" | "anon">>(true);

Deno.test("auth types type-check", () => {});
