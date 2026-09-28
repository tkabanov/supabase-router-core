import type { SupabaseClient } from "@supabase/supabase-js";
import { createContainer, type ServiceContainer } from "../mod.ts";

/** Legacy JWT-based keys (deprecated by Supabase, still supported) */
export const LEGACY_ENV: Record<string, string> = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
};

/** New API keys as auto-provisioned in hosted Edge Functions */
export const NEW_KEYS_ENV: Record<string, string> = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({
    default: "sb_publishable_default",
    mobile: "sb_publishable_mobile",
  }),
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_default" }),
  SUPABASE_JWKS: JSON.stringify({ keys: [{ kid: "k1", kty: "EC" }] }),
};

export const ENV = LEGACY_ENV;

export interface FakeAuthUser {
  id: string;
  email?: string;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
}

/**
 * Container whose Supabase clients are fakes. `users` maps a bearer token to
 * the Supabase Auth user returned by `auth.getUser(token)`.
 */
export function createTestContainer(
  users: Record<string, FakeAuthUser> = {},
  overrides: Partial<ServiceContainer> = {},
  env: Record<string, string> = LEGACY_ENV,
): ServiceContainer & { logs: unknown[][]; calls: unknown[][] } {
  const logs: unknown[][] = [];
  const calls: unknown[][] = [];
  const fakeClient = (label: string) =>
    ({
      label,
      auth: {
        getUser: (token: string) => {
          calls.push(["getUser", token]);
          return Promise.resolve(
            users[token]
              ? { data: { user: users[token] }, error: null }
              : { data: { user: null }, error: new Error("invalid") },
          );
        },
        getClaims: (token: string, options?: unknown) => {
          calls.push(["getClaims", token, options]);
          const user = users[token];
          return Promise.resolve(
            user
              ? {
                data: {
                  claims: {
                    sub: user.id,
                    email: user.email,
                    role: "authenticated",
                    app_metadata: user.app_metadata,
                    user_metadata: user.user_metadata,
                  },
                },
                error: null,
              }
              : { data: null, error: new Error("invalid JWT") },
          );
        },
      },
    }) as unknown as SupabaseClient;

  const container = createContainer({
    env: { get: (k) => env[k], require: (k) => env[k] },
    logger: {
      log: (...a) => logs.push(["log", ...a]),
      warn: (...a) => logs.push(["warn", ...a]),
      error: (...a) => logs.push(["error", ...a]),
    },
    idGenerator: { generate: () => "req-1" },
    supabaseClientFactory: {
      create: (_url, key) => fakeClient(key),
      createWithToken: (_url, _key, token) => fakeClient(`user:${token}`),
    },
    ...overrides,
  });
  return Object.assign(container, { logs, calls });
}

export const request = (
  path: string,
  init: RequestInit & { token?: string } = {},
): Request => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  return new Request(`http://localhost${path}`, { ...init, headers });
};
