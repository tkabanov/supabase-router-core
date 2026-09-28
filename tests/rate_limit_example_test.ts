import { assertEquals } from "@std/assert";
import { defineRoute, defineRouter } from "../mod.ts";
import { rateLimit, type RateLimiter } from "../examples/redis-rate-limit.ts";
import { createTestContainer, request } from "./helpers.ts";

/** In-memory stand-in with the @upstash/ratelimit `limit()` contract */
const fakeLimiter = (max: number, seen: string[] = []): RateLimiter => {
  const counts = new Map<string, number>();
  return {
    limit: (id) => {
      seen.push(id);
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      return Promise.resolve({
        success: count <= max,
        limit: max,
        remaining: Math.max(0, max - count),
        reset: Date.now() + 5_000,
      });
    },
  };
};

const makeRouter = (limiter: RateLimiter, failOpen?: boolean) =>
  defineRouter({
    basePath: "/api",
    container: createTestContainer(),
    authHandler: (req) =>
      Promise.resolve({ user: { id: req.headers.get("x-user") ?? "anon" } }),
    routes: [
      defineRoute({
        method: "POST",
        path: "/messages",
        middlewares: [
          rateLimit({
            limiter,
            key: (ctx) => (ctx.user as { id: string }).id,
            failOpen,
          }),
        ],
        handler: () => Promise.resolve({ sent: true }),
      }),
    ],
  });

const post = (user: string) =>
  request("/api/messages", { method: "POST", headers: { "x-user": user } });

Deno.test("route-level limiter counts per authenticated user", async () => {
  const seen: string[] = [];
  const router = makeRouter(fakeLimiter(2, seen));

  const statuses = [];
  for (const user of ["alice", "alice", "alice", "bob"]) {
    const res = await router.handler(post(user));
    statuses.push(res.status);
    await res.body?.cancel();
  }

  assertEquals(statuses, [200, 200, 429, 200]);
  assertEquals(seen, ["alice", "alice", "alice", "bob"]);
});

Deno.test("429 carries Retry-After and rate limit headers", async () => {
  const router = makeRouter(fakeLimiter(0));
  const res = await router.handler(post("alice"));
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("x-ratelimit-limit"), "0");
  assertEquals(Number(res.headers.get("retry-after")) >= 1, true);
  await res.body?.cancel();
});

Deno.test("limiter outage: fail open by default, 503 when failOpen is false", async () => {
  const broken: RateLimiter = {
    limit: () => Promise.reject(new Error("down")),
  };

  const open = await makeRouter(broken).handler(post("alice"));
  assertEquals(open.status, 200);
  await open.body?.cancel();

  const closed = await makeRouter(broken, false).handler(post("alice"));
  assertEquals(closed.status, 503);
  await closed.body?.cancel();
});
