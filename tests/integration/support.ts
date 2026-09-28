// Shared helpers for integration tests. These tests talk to a real local
// Supabase stack started by tests/integration/run.ts
// (`deno task test:integration`), which passes connection details via env.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const read = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(
      `${name} is not set. Run integration tests with \`deno task test:integration\`.`,
    );
  }
  return value;
};

/** Connection details of the local stack (from `supabase status -o env`) */
export const stack = {
  apiUrl: read("API_URL"),
  dbUrl: read("DB_URL"),
  poolerUrl: read("POOLER_URL"),
  publishableKey: read("PUBLISHABLE_KEY"),
  secretKey: read("SECRET_KEY"),
  legacyAnonKey: read("ANON_KEY"),
  legacyServiceRoleKey: read("SERVICE_ROLE_KEY"),
  jwtSecret: read("JWT_SECRET"),
  /** Algorithm of the active signing key (ES256 or RS256) */
  alg: read("EXPECTED_ALG"),
  /** Private JWK of the previous, verify-only signing key (rotation tests) */
  previousKeyPath: read("PREVIOUS_KEY_PATH"),
};

export const functionsUrl = `${stack.apiUrl}/functions/v1`;

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false },
};

export const adminClient = (): SupabaseClient =>
  createClient(stack.apiUrl, stack.secretKey, clientOptions);

export const publicClient = (): SupabaseClient =>
  createClient(stack.apiUrl, stack.publishableKey, clientOptions);

const PASSWORD = "Integration-Passw0rd!";

export interface TestUser {
  id: string;
  email: string;
  client: SupabaseClient;
  token: string;
}

/** Create a confirmed user (role in app_metadata) and sign them in */
export async function createSignedInUser(
  label: string,
  role: string,
): Promise<TestUser> {
  const email = `${label}-${crypto.randomUUID()}@example.com`;
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { role },
  });
  if (error) throw error;
  return { id: data.user.id, email, ...(await signIn(email)) };
}

export async function signIn(
  email: string,
): Promise<{ client: SupabaseClient; token: string }> {
  const client = publicClient();
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (error) throw error;
  return { client, token: data.session!.access_token };
}

// ------------------------------------------------------------------ JWTs

const encoder = new TextEncoder();

export const base64url = (input: Uint8Array | string): string =>
  btoa(
    typeof input === "string" ? input : String.fromCharCode(...input),
  ).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export const decodeJwtPart = (part: string): Record<string, unknown> =>
  JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));

const SIGNING_ALGORITHMS = {
  ES256: {
    importAlg: { name: "ECDSA", namedCurve: "P-256" },
    signAlg: { name: "ECDSA", hash: "SHA-256" },
  },
  RS256: {
    importAlg: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    signAlg: { name: "RSASSA-PKCS1-v1_5" },
  },
} as const;

type PrivateJwk = JsonWebKey & { kid: string; alg: "ES256" | "RS256" };

/**
 * Re-sign the payload of a real access token with another private key, as if
 * it had been issued with that key (e.g. before a key rotation).
 */
export async function resignToken(
  token: string,
  jwk: PrivateJwk,
): Promise<string> {
  const { importAlg, signAlg } = SIGNING_ALGORITHMS[jwk.alg];
  const { kid, alg, key_ops: _ops, ...keyData } = jwk;
  const key = await crypto.subtle.importKey(
    "jwk",
    keyData,
    importAlg,
    false,
    ["sign"],
  );
  const header = base64url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const signingInput = `${header}.${token.split(".")[1]}`;
  const signature = await crypto.subtle.sign(
    signAlg,
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

/** Re-sign a token with the legacy shared secret (HS256) */
export async function resignTokenHs256(
  token: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const signingInput = `${header}.${token.split(".")[1]}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

/** Private JWK of a freshly generated ES256 key that no one trusts */
export async function untrustedKey(): Promise<PrivateJwk> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { ...jwk, kid: crypto.randomUUID(), alg: "ES256" };
}

export async function readPreviousKey(): Promise<PrivateJwk> {
  return JSON.parse(await Deno.readTextFile(stack.previousKeyPath));
}

/** Record which Auth server endpoints are called while `fn` runs */
export async function recordAuthRequests(
  fn: () => Promise<void>,
): Promise<string[]> {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/auth/v1/")) paths.push(new URL(url).pathname);
    return original(input, init);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return paths;
}
