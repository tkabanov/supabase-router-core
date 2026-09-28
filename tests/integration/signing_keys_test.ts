// JWT signing key rotation and the legacy HS256 shared secret
import { assert, assertEquals } from "@std/assert";
import {
  createSignedInUser,
  readPreviousKey,
  recordAuthRequests,
  resignToken,
  resignTokenHs256,
  stack,
  untrustedKey,
} from "./support.ts";
import {
  callJson,
  fetchJwks,
  legacyEnv,
  makeRouter,
  newKeysEnv,
} from "./router_fixture.ts";

const jwks = await fetchJwks();
const user = await createSignedInUser("rotation", "admin");

Deno.test("rotation: token signed by the previous (verify-only) key is accepted", async () => {
  const previous = await readPreviousKey();
  assert(
    jwks.keys.some((k) => k.kid === previous.kid),
    "previous key must still be published in the JWKS",
  );
  const token = await resignToken(user.token, previous);

  for (const env of [newKeysEnv(jwks), newKeysEnv()]) {
    const res = await callJson(makeRouter(env).router, "/api/me", { token });
    assertEquals(res.status, 200);
    assertEquals(res.body.id, user.id);
  }
});

Deno.test("rotation: token signed by a key missing from the JWKS is rejected", async () => {
  const token = await resignToken(user.token, await untrustedKey());
  for (const env of [newKeysEnv(jwks), newKeysEnv()]) {
    const res = await callJson(makeRouter(env).router, "/api/me", { token });
    assertEquals(res.status, 401);
  }
});

for (
  const [label, env] of [
    ["legacy keys", legacyEnv()],
    ["new keys", newKeysEnv(jwks)],
  ] as const
) {
  Deno.test(`HS256 (${label}): verified by the Auth server`, async () => {
    const token = await resignTokenHs256(user.token, stack.jwtSecret);
    const tampered = `${token.slice(0, -4)}AAAA`;
    const { router } = makeRouter(env);

    const statuses: number[] = [];
    const authRequests = await recordAuthRequests(async () => {
      statuses.push((await callJson(router, "/api/me", { token })).status);
      statuses.push(
        (await callJson(router, "/api/admin", { method: "POST", token }))
          .status,
      );
      statuses.push(
        (await callJson(router, "/api/me", { token: tampered })).status,
      );
    });

    assertEquals(statuses, [200, 200, 401]);
    assertEquals(authRequests, [
      "/auth/v1/user",
      "/auth/v1/user",
      "/auth/v1/user",
    ]);
  });
}
