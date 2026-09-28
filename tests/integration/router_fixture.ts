import { sql } from "drizzle-orm";
import { createContainer, defineRoute, defineRouter } from "../../mod.ts";
import { stack } from "./support.ts";

type Env = Record<string, string>;

/** Env as auto-provisioned in hosted Edge Functions (new API keys) */
export const newKeysEnv = (jwks?: unknown): Env => ({
  SUPABASE_URL: stack.apiUrl,
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: stack.publishableKey }),
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: stack.secretKey }),
  ...(jwks ? { SUPABASE_JWKS: JSON.stringify(jwks) } : {}),
});

/** Env of a project that still uses the legacy JWT-based keys */
export const legacyEnv = (): Env => ({
  SUPABASE_URL: stack.apiUrl,
  SUPABASE_ANON_KEY: stack.legacyAnonKey,
  SUPABASE_SERVICE_ROLE_KEY: stack.legacyServiceRoleKey,
});

export const fetchJwks = async (): Promise<{ keys: Array<{ kid: string }> }> =>
  await (await fetch(`${stack.apiUrl}/auth/v1/.well-known/jwks.json`)).json();

interface FixtureOptions {
  tokenVerification?: "auth-server";
  /** Connection string for the transaction pooler client */
  databaseUrl?: string;
}

const routes = [
  defineRoute({
    method: "GET",
    path: "/me",
    handler: ({ user }) => Promise.resolve(user),
  }),
  defineRoute({
    method: "POST",
    path: "/admin",
    allowedRoles: ["admin"],
    handler: () => Promise.resolve({ ok: true }),
  }),
  defineRoute({
    method: "GET",
    path: "/notes",
    handler: async ({ supabaseClient }) => {
      const { data, error } = await supabaseClient.from("notes").select("body");
      if (error) throw new Error(error.message);
      return data;
    },
  }),
  defineRoute({
    method: "GET",
    path: "/internal/users",
    authentication: { requireServiceRole: true },
    handler: async ({ serviceRoleClient }) => {
      const { data, error } = await serviceRoleClient!.auth.admin.listUsers();
      if (error) throw new Error(error.message);
      return { count: data.users.length };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/feed",
    authentication: { bypassWithAnonRole: true },
    handler: ({ user }) =>
      Promise.resolve({ user: (user as { id?: string })?.id ?? null }),
  }),
  defineRoute({
    method: "GET",
    path: "/db",
    authRequired: false,
    useDatabase: true,
    handler: async ({ db }) => {
      const [row] = await db!.execute(
        sql`select current_setting('statement_timeout') as timeout, 1 as one`,
      );
      return row;
    },
  }),
];

/** Router wired to the local stack; `logs` collects warnings and errors */
export function makeRouter(env: Env, options: FixtureOptions = {}) {
  const logs: Array<[string, ...unknown[]]> = [];
  const fullEnv: Env = {
    ...env,
    ...(options.databaseUrl && { SUPABASE_DB_POOLER_URL: options.databaseUrl }),
  };
  const container = createContainer({
    env: { get: (k) => fullEnv[k], require: (k) => fullEnv[k] },
    logger: {
      log: () => {},
      warn: (...a) => logs.push(["warn", ...a]),
      error: (...a) => logs.push(["error", ...a]),
    },
  });

  const router = defineRouter({
    basePath: "/api",
    defaultTags: [],
    container,
    tokenVerification: options.tokenVerification,
    database: {
      enableTransactionPooler: !!options.databaseUrl,
      statementTimeoutMs: 1234,
    },
    routes: options.databaseUrl
      ? routes
      : routes.filter((r) => r.path !== "/db"),
  });

  return { router, logs };
}

/** Call the router in-process with optional Bearer token and apikey header */
export const call = (
  router: { handler: (req: Request) => Promise<Response> },
  path: string,
  init: RequestInit & { token?: string; apikey?: string } = {},
): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.apikey) headers.set("apikey", init.apikey);
  return router.handler(
    new Request(`http://localhost${path}`, { ...init, headers }),
  );
};

// Response bodies are asserted field by field in tests
// deno-lint-ignore no-explicit-any
type Json = any;

/** Status and parsed JSON body (consumes the body) */
export const callJson = async (
  ...args: Parameters<typeof call>
): Promise<{ status: number; body: Json }> => {
  const res = await call(...args);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
};
