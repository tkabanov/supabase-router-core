import type {
  AuthHandler,
  AuthOptions,
  AuthResult,
  UserLoader,
} from "../core/types.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ServiceContainer } from "../core/container.ts";
import { unauthorized } from "../errors/http-errors.ts";
import { timingSafeEqual } from "../security/timing.ts";
import {
  resolveSupabaseKeys,
  type SupabaseKeys,
} from "../core/supabase-keys.ts";

/**
 * How user access tokens are verified by the default auth handler.
 *
 * - `"claims"` (default, recommended by Supabase): `auth.getClaims()`. With
 *   asymmetric signing keys (ES256/RS256) the signature is checked locally
 *   against the JWKS (`SUPABASE_JWKS` or the project's JWKS endpoint), so there
 *   is no network round trip. Projects still on the legacy HS256 secret
 *   automatically fall back to asking the Auth server. Trade-off: a session
 *   that was signed out stays valid until the access token expires.
 * - `"auth-server"`: `auth.getUser()` on every request. Detects signed-out
 *   sessions and deleted users immediately, at the cost of a request to the
 *   Auth server (which runs only in your project's region).
 */
export type TokenVerification = "claims" | "auth-server";

/**
 * Verified user token claims used to build the default user object
 */
interface VerifiedClaims {
  sub: string;
  email?: string;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
  is_anonymous?: boolean;
}

const readSupabaseKeys = (container: ServiceContainer): SupabaseKeys => {
  const keys = resolveSupabaseKeys(container.env);
  if (!keys.url) {
    throw new Error(
      "Supabase configuration missing. Provide SUPABASE_URL environment variable or custom authHandler.",
    );
  }
  if (!keys.primaryPublishableKey) {
    throw new Error(
      "Supabase configuration missing. Provide SUPABASE_PUBLISHABLE_KEYS (or SUPABASE_PUBLISHABLE_KEY / legacy SUPABASE_ANON_KEY) environment variable or custom authHandler.",
    );
  }
  return keys;
};

/**
 * Extract the token from an `Authorization: Bearer <token>` header
 * @param header - Authorization header value
 * @returns Token, or null when the header is missing or malformed
 */
export function parseBearerToken(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}

/**
 * Build the user object from server-controlled claims only.
 * `user_metadata` is writable by the user themselves (`auth.updateUser`),
 * so it is exposed as a nested field and never used for `id`, `email` or
 * `role`. Note that the JWT's top-level `role` claim is the Postgres role
 * (`authenticated`), not an application role, and is not used either.
 */
const buildUser = (claims: VerifiedClaims): Record<string, unknown> => ({
  ...claims.app_metadata,
  user_metadata: claims.user_metadata ?? {},
  is_anonymous: claims.is_anonymous ?? false,
  id: claims.sub,
  email: claims.email,
});

interface AuthDeps<TUser> {
  container: ServiceContainer;
  keys: SupabaseKeys;
  verification: TokenVerification;
  userLoader?: UserLoader<TUser>;
}

interface Credentials {
  /** Token from `Authorization: Bearer` */
  bearer: string | null;
  /** Value of the `apikey` header */
  apiKey: string | null;
}

const matchesAny = (
  credentials: Credentials,
  keys: string[],
): boolean =>
  [credentials.apiKey, credentials.bearer].some((value) =>
    !!value && keys.some((key) => timingSafeEqual(value, key))
  );

/** Secret keys belong on `apikey`; legacy service_role JWTs on `Authorization` */
const resolveServiceBypass = <TUser, TRole>(
  credentials: Credentials,
  options: AuthOptions<TRole>,
  { container, keys }: AuthDeps<TUser>,
): AuthResult<TUser, TRole> | undefined => {
  const allowed = options.requireServiceRole || options.bypassWithServiceRole;
  if (!allowed || !matchesAny(credentials, keys.secretKeys)) {
    return undefined;
  }

  const serviceClient = container.getOrCreateServiceClient();
  return {
    supabaseClient: serviceClient,
    serviceRoleClient: serviceClient,
    serviceBypassed: true,
  };
};

const createUserClient = <TUser>(
  token: string,
  { container, keys }: AuthDeps<TUser>,
) =>
  container.supabaseClientFactory.createWithToken(
    keys.url,
    keys.primaryPublishableKey!,
    token,
  );

type AuthClient = SupabaseClient["auth"];

/** Ask the Auth server; detects signed-out sessions and deleted users */
const verifyWithAuthServer = async (
  auth: AuthClient,
  token: string,
): Promise<VerifiedClaims | null> => {
  const { data, error } = await auth.getUser(token);
  const user = error ? null : data?.user;
  return user ? { ...user, sub: user.id } : null;
};

/** Verify locally against the JWKS (falls back to the Auth server for HS256) */
const verifyWithJwks = async (
  auth: AuthClient,
  token: string,
  jwks: SupabaseKeys["jwks"],
): Promise<VerifiedClaims | null> => {
  const { data, error } = await auth.getClaims(
    token,
    jwks ? { jwks: jwks as never } : undefined,
  );
  const claims = error ? null : data?.claims as VerifiedClaims | undefined;
  // API keys and service_role JWTs have no subject: they are not users
  return claims?.sub ? claims : null;
};

const verifyClaims = <TUser>(
  token: string,
  { container, keys, verification }: AuthDeps<TUser>,
): Promise<VerifiedClaims | null> => {
  const auth = container.getOrCreateAnonClient().auth;
  // Older supabase-js versions and hand-written test mocks only have getUser
  const useAuthServer = verification === "auth-server" ||
    typeof auth.getClaims !== "function";

  return useAuthServer
    ? verifyWithAuthServer(auth, token)
    : verifyWithJwks(auth, token, keys.jwks);
};

/** Verify the token and load the user */
const verifyUser = async <TUser>(
  token: string,
  deps: AuthDeps<TUser>,
): Promise<TUser | null> => {
  const claims = await verifyClaims(token, deps);
  if (!claims) {
    return null;
  }

  if (!deps.userLoader) {
    return buildUser(claims) as TUser;
  }

  return await deps.userLoader(claims.sub, createUserClient(token, deps));
};

/** Result when no user could be authenticated */
const withoutUser = <TUser, TRole>(
  credentials: Credentials,
  options: AuthOptions<TRole>,
  deps: AuthDeps<TUser>,
): AuthResult<TUser, TRole> => {
  if (
    options.bypassWithAnonRole &&
    matchesAny(credentials, deps.keys.publishableKeys)
  ) {
    return {
      supabaseClient: deps.container.getOrCreateAnonClient(),
      anonBypassed: true,
    };
  }

  // Optional auth: continue anonymously without a user
  if (options.requireUserAuth === false) {
    return { supabaseClient: deps.container.getOrCreateAnonClient() };
  }

  return {
    response: unauthorized(
      credentials.bearer
        ? "Invalid or expired token"
        : "Authorization header required",
    ),
  };
};

const authenticate = async <TUser, TRole>(
  req: Request,
  options: AuthOptions<TRole>,
  deps: AuthDeps<TUser>,
): Promise<AuthResult<TUser, TRole>> => {
  const credentials: Credentials = {
    bearer: parseBearerToken(req.headers.get("Authorization")),
    apiKey: req.headers.get("apikey"),
  };

  const serviceBypass = resolveServiceBypass<TUser, TRole>(
    credentials,
    options,
    deps,
  );
  if (serviceBypass) {
    return serviceBypass;
  }

  if (options.requireServiceRole) {
    return { response: unauthorized("Secret key required") };
  }

  // A signed-in user always wins over the publishable key that supabase-js
  // sends in `apikey` on every request
  const user = credentials.bearer
    ? await verifyUser(credentials.bearer, deps)
    : null;
  if (!user) {
    return withoutUser(credentials, options, deps);
  }

  return {
    user,
    supabaseClient: createUserClient(credentials.bearer!, deps),
    serviceBypassed: false,
  };
};

/**
 * Options for the default Supabase auth handler
 */
export interface DefaultAuthOptions<TUser> {
  /** Load the user (with role) by id instead of using `app_metadata` */
  userLoader?: UserLoader<TUser>;
  /** How access tokens are verified (default: `"claims"`) */
  tokenVerification?: TokenVerification;
}

/**
 * Default Supabase authentication handler
 *
 * - User access tokens come from `Authorization: Bearer <jwt>` and are
 *   verified with `getClaims()` (see {@link TokenVerification}).
 * - Secret keys (`sb_secret_...`) are accepted on the `apikey` header, legacy
 *   `service_role` JWTs also on `Authorization`, only on routes that opt in.
 * - Publishable keys are accepted only with `bypassWithAnonRole`.
 * - All keys are compared in constant time.
 * - The user (and its `role`) comes from `userLoader` when provided, otherwise
 *   from the token's `app_metadata`.
 * - RBAC is enforced by `validateAuthResult`, which the router always runs.
 *
 * @param container - Service container with environment and Supabase client factory
 * @param options - User loader and token verification mode
 * @example
 * ```typescript
 * const router = defineRouter({
 *   // authHandler not provided - uses this default
 *   userLoader: async (id, supabase) =>
 *     (await supabase.from("profiles").select("*").eq("id", id).single()).data,
 *   routes: [...]
 * });
 * ```
 */
export function createDefaultAuthHandler<TUser = unknown, TRole = string>(
  container: ServiceContainer,
  options: DefaultAuthOptions<TUser> = {},
): Promise<AuthHandler<TRole, TUser>> {
  const deps: AuthDeps<TUser> = {
    container,
    keys: readSupabaseKeys(container),
    verification: options.tokenVerification ?? "claims",
    userLoader: options.userLoader,
  };

  return Promise.resolve((req, authOptions) =>
    authenticate<TUser, TRole>(req, authOptions, deps)
  );
}

/**
 * Get default auth handler or throw error with helpful message
 *
 * @param container - Service container with environment and Supabase client factory
 * @param options - User loader and token verification mode
 */
export async function getOrCreateDefaultAuthHandler<
  TUser = unknown,
  TRole = string,
>(
  container: ServiceContainer,
  options: DefaultAuthOptions<TUser> = {},
): Promise<AuthHandler<TRole, TUser>> {
  try {
    return await createDefaultAuthHandler<TUser, TRole>(container, options);
  } catch (error) {
    throw new Error(
      `Authentication configuration error: ${
        error instanceof Error ? error.message : error
      }\n\n` +
        "To fix this:\n" +
        "1. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEYS (auto-provisioned in Edge Functions;\n" +
        "   legacy SUPABASE_ANON_KEY also works), plus SUPABASE_SECRET_KEYS for secret-key routes, OR\n" +
        "2. Provide a custom authHandler in router configuration:\n\n" +
        "   const router = defineRouter({\n" +
        "     authHandler: async (req: Request, options: AuthOptions) => {\n" +
        "       // Your custom auth logic\n" +
        "       return { user, supabaseClient };\n" +
        "     },\n" +
        "     routes: [...]\n" +
        "   });",
    );
  }
}
