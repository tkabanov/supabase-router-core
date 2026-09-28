import type { EnvironmentProvider } from "./container.ts";

/**
 * JSON Web Key as provided in `SUPABASE_JWKS`
 */
export type SupabaseJwk = Record<string, unknown> & { kid?: string };

/**
 * Supabase API keys resolved from the environment.
 *
 * Supports, in order of preference:
 * - `SUPABASE_PUBLISHABLE_KEYS` / `SUPABASE_SECRET_KEYS`: JSON objects of named
 *   keys, auto-provisioned in hosted Edge Functions (`default` is preferred)
 * - `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY`: single keys (local CLI)
 * - `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`: legacy JWT keys,
 *   deprecated by Supabase by the end of 2026 but still accepted
 */
export interface SupabaseKeys {
  /** Project URL (`SUPABASE_URL`), empty when unset */
  url: string;
  /** Every accepted publishable (or legacy anon) key */
  publishableKeys: string[];
  /** Every accepted secret (or legacy service_role) key */
  secretKeys: string[];
  /** Key used to create anonymous / user-scoped clients */
  primaryPublishableKey?: string;
  /** Key used to create the admin client */
  primarySecretKey?: string;
  /** JWKS for local JWT verification (`SUPABASE_JWKS`), when provided */
  jwks?: { keys: SupabaseJwk[] };
}

const parseJson = (env: EnvironmentProvider, name: string): unknown => {
  const raw = env.get(name);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
};

/** Named keys (`{"default": "sb_..."}`), `default` first */
const readNamedKeys = (env: EnvironmentProvider, name: string): string[] => {
  const parsed = parseJson(env, name) as Record<string, unknown> | undefined;
  if (!parsed) return [];
  const { default: preferred, ...rest } = parsed;
  return [preferred, ...Object.values(rest)].filter(
    (key): key is string => typeof key === "string" && key.length > 0,
  );
};

const collectKeys = (
  env: EnvironmentProvider,
  names: [json: string, single: string, legacy: string],
): string[] => {
  const [json, single, legacy] = names;
  const keys = [
    ...readNamedKeys(env, json),
    env.get(single),
    env.get(legacy),
  ].filter((key): key is string => !!key);
  return [...new Set(keys)];
};

const readJwks = (
  env: EnvironmentProvider,
): SupabaseKeys["jwks"] => {
  const parsed = parseJson(env, "SUPABASE_JWKS") as
    | { keys?: SupabaseJwk[] }
    | undefined;
  return Array.isArray(parsed?.keys) ? { keys: parsed.keys } : undefined;
};

/**
 * Resolve Supabase URL, API keys and JWKS from the environment
 * @param env - Environment provider
 * @returns Resolved keys (lists may be empty)
 *
 * @example
 * ```typescript
 * const keys = resolveSupabaseKeys(container.env);
 * createClient(keys.url, keys.primarySecretKey!);
 * ```
 */
export function resolveSupabaseKeys(env: EnvironmentProvider): SupabaseKeys {
  const publishableKeys = collectKeys(env, [
    "SUPABASE_PUBLISHABLE_KEYS",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY",
  ]);
  const secretKeys = collectKeys(env, [
    "SUPABASE_SECRET_KEYS",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);

  return {
    url: env.get("SUPABASE_URL") ?? "",
    publishableKeys,
    secretKeys,
    primaryPublishableKey: publishableKeys[0],
    primarySecretKey: secretKeys[0],
    jwks: readJwks(env),
  };
}
