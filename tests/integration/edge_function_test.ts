// The router deployed as an Edge Function in the real edge runtime
// (supabase/functions/router-it), called through the local API gateway.
import { assertEquals } from "@std/assert";
import {
  createSignedInUser,
  functionsUrl,
  publicClient,
  stack,
} from "./support.ts";

const admin = await createSignedInUser("edge-admin", "admin");
const plain = await createSignedInUser("edge-user", "user");

const invokeStatus = async (
  client: typeof admin.client,
  name: string,
  method: "GET" | "POST",
): Promise<{ status?: number; data: unknown }> => {
  const { data, error, response } = await client.functions.invoke(name, {
    method,
  });
  const failed = error as { context?: Response } | null;
  return { status: (response ?? failed?.context)?.status, data };
};

Deno.test("edge runtime provides the new-style env the router reads", async () => {
  const res = await fetch(`${functionsUrl}/router-it/env`);
  assertEquals(res.status, 200);
  const env = await res.json();
  assertEquals(env.SUPABASE_PUBLISHABLE_KEYS, "json:default");
  assertEquals(env.SUPABASE_SECRET_KEYS, "json:default");
  assertEquals(env.SUPABASE_JWKS, "json:keys");
});

Deno.test("supabase-js functions.invoke with a signed-in user", async () => {
  const me = await invokeStatus(admin.client, "router-it/me", "GET");
  assertEquals(me.status, 200);
  assertEquals((me.data as { role: string }).role, "admin");

  assertEquals(
    (await invokeStatus(admin.client, "router-it/admin", "POST")).status,
    200,
  );
  assertEquals(
    (await invokeStatus(plain.client, "router-it/admin", "POST")).status,
    403,
  );
});

Deno.test("signed-out supabase-js client gets 401", async () => {
  assertEquals(
    (await invokeStatus(publicClient(), "router-it/me", "GET")).status,
    401,
  );
});

Deno.test("server-to-server call with the secret key on apikey", async () => {
  const ok = await fetch(`${functionsUrl}/router-it/internal`, {
    headers: { apikey: stack.secretKey },
  });
  assertEquals(ok.status, 200);
  assertEquals(typeof (await ok.json()).count, "number");

  const denied = await fetch(`${functionsUrl}/router-it/internal`, {
    headers: { apikey: stack.publishableKey },
  });
  assertEquals(denied.status, 401);
  await denied.body?.cancel();
});

Deno.test("router answers OPTIONS with the headers supabase-js sends", async () => {
  // The LOCAL gateway (Kong) answers real CORS preflights itself, so they
  // never reach the function locally; a plain OPTIONS request does.
  const res = await fetch(`${functionsUrl}/router-it/me`, {
    method: "OPTIONS",
  });
  assertEquals(res.status, 204);
  const allowed = res.headers.get("access-control-allow-headers")!;
  for (
    const header of [
      "authorization",
      "apikey",
      "x-client-info",
      "x-retry-count",
    ]
  ) {
    assertEquals(allowed.includes(header), true, header);
  }
});
