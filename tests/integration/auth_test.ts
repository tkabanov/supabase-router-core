// Default auth handler against the real Auth server, PostgREST and RLS
import { assert, assertEquals } from "@std/assert";
import {
  adminClient,
  createSignedInUser,
  decodeJwtPart,
  recordAuthRequests,
  signIn,
  stack,
} from "./support.ts";
import {
  callJson,
  fetchJwks,
  legacyEnv,
  makeRouter,
  newKeysEnv,
} from "./router_fixture.ts";

const jwks = await fetchJwks();
const admin = await createSignedInUser("admin", "admin");
const plain = await createSignedInUser("plain", "user");

// Privilege escalation attempt through self-editable user_metadata
await plain.client.auth.updateUser({
  data: { role: "admin", id: admin.id, email: admin.email },
});
const escalated = await signIn(plain.email);

const { error: insertError } = await adminClient().from("notes").insert([
  { user_id: admin.id, body: "admin note" },
  { user_id: plain.id, body: "plain note" },
]);
if (insertError) throw insertError;

Deno.test(`access tokens are signed with ${stack.alg} and carry app_metadata`, () => {
  const [header, payload] = admin.token.split(".").map((part, i) =>
    i < 2 ? decodeJwtPart(part) : {}
  );
  assertEquals(header.alg, stack.alg);
  assert(header.kid);
  assertEquals((payload.app_metadata as { role: string }).role, "admin");
  assertEquals(payload.role, "authenticated");
});

Deno.test("user token is verified locally with SUPABASE_JWKS", async () => {
  const { router } = makeRouter(newKeysEnv(jwks));
  let result!: Awaited<ReturnType<typeof callJson>>;
  const authRequests = await recordAuthRequests(async () => {
    result = await callJson(router, "/api/me", { token: admin.token });
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.id, admin.id);
  assertEquals(result.body.email, admin.email);
  assertEquals(result.body.role, "admin");
  assertEquals(result.body.is_anonymous, false);
  assertEquals(authRequests, []);
});

Deno.test("without SUPABASE_JWKS the JWKS endpoint is used", async () => {
  const { router } = makeRouter(newKeysEnv());
  let status = 0;
  const authRequests = await recordAuthRequests(async () => {
    status = (await callJson(router, "/api/me", { token: admin.token }))
      .status;
  });
  assertEquals(status, 200);
  assertEquals(authRequests, ["/auth/v1/.well-known/jwks.json"]);
});

Deno.test("role escalation via user_metadata is rejected", async () => {
  const { router } = makeRouter(newKeysEnv(jwks));
  const me = await callJson(router, "/api/me", { token: escalated.token });
  assertEquals(me.body.id, plain.id);
  assertEquals(me.body.email, plain.email);
  assertEquals(me.body.role, "user");
  assertEquals((me.body.user_metadata as { role: string }).role, "admin");

  const escalatedCall = await callJson(router, "/api/admin", {
    method: "POST",
    token: escalated.token,
  });
  assertEquals(escalatedCall.status, 403);

  const adminCall = await callJson(router, "/api/admin", {
    method: "POST",
    token: admin.token,
  });
  assertEquals(adminCall.status, 200);
});

Deno.test("user-scoped client enforces RLS", async () => {
  const { router } = makeRouter(newKeysEnv(jwks));
  const adminNotes = await callJson(router, "/api/notes", {
    token: admin.token,
  });
  assertEquals(adminNotes.body, [{ body: "admin note" }]);
  const plainNotes = await callJson(router, "/api/notes", {
    token: plain.token,
  });
  assertEquals(plainNotes.body, [{ body: "plain note" }]);
});

Deno.test("forged, garbage and API-key Bearer tokens are rejected", async () => {
  const { router } = makeRouter(newKeysEnv(jwks));
  const [header, payload, signature] = admin.token.split(".");
  const forgedPayload = btoa(
    JSON.stringify({ ...decodeJwtPart(payload), sub: plain.id }),
  ).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

  for (
    const token of [
      `${header}.${forgedPayload}.${signature}`,
      "not-a-jwt",
      stack.publishableKey,
      stack.secretKey,
    ]
  ) {
    const res = await callJson(router, "/api/me", { token });
    assertEquals(res.status, 401, token.slice(0, 16));
  }
});

Deno.test("secret key on the apikey header reaches the admin API", async () => {
  const { router } = makeRouter(newKeysEnv(jwks));
  const ok = await callJson(router, "/api/internal/users", {
    apikey: stack.secretKey,
  });
  assertEquals(ok.status, 200);
  assert((ok.body.count as number) >= 2);

  for (
    const init of [{ apikey: stack.publishableKey }, { token: admin.token }]
  ) {
    assertEquals(
      (await callJson(router, "/api/internal/users", init)).status,
      401,
    );
  }
});

Deno.test("supabase-js headers: publishable apikey plus session or key", async () => {
  const { router } = makeRouter(newKeysEnv(jwks));
  const signedIn = await callJson(router, "/api/feed", {
    apikey: stack.publishableKey,
    token: admin.token,
  });
  assertEquals(signedIn.body, { user: admin.id });

  const anonymous = await callJson(router, "/api/feed", {
    apikey: stack.publishableKey,
    token: stack.publishableKey,
  });
  assertEquals(anonymous.body, { user: null });
});

Deno.test("legacy keys: user auth, RLS, service_role Bearer, anon key", async () => {
  const { router } = makeRouter(legacyEnv());
  assertEquals(
    (await callJson(router, "/api/me", { token: admin.token })).body.role,
    "admin",
  );
  assertEquals(
    (await callJson(router, "/api/notes", { token: plain.token })).body,
    [{ body: "plain note" }],
  );
  assertEquals(
    (await callJson(router, "/api/internal/users", {
      token: stack.legacyServiceRoleKey,
    })).status,
    200,
  );
  assertEquals(
    (await callJson(router, "/api/feed", { token: stack.legacyAnonKey }))
      .body,
    { user: null },
  );
  // The legacy anon key is a valid JWT, but not a user
  assertEquals(
    (await callJson(router, "/api/me", { token: stack.legacyAnonKey }))
      .status,
    401,
  );
});

Deno.test("sign-out: claims mode accepts until expiry, auth-server rejects", async () => {
  const session = await signIn(plain.email);
  const { error } = await session.client.auth.signOut({ scope: "global" });
  assertEquals(error, null);

  const claims = makeRouter(newKeysEnv(jwks)).router;
  assertEquals(
    (await callJson(claims, "/api/me", { token: session.token })).status,
    200,
  );

  const strict = makeRouter(newKeysEnv(jwks), {
    tokenVerification: "auth-server",
  }).router;
  assertEquals(
    (await callJson(strict, "/api/me", { token: session.token })).status,
    401,
  );
});
