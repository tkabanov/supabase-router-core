import type { AuthOptions, AuthResult } from "../core/types.ts";
import type { ServiceContainer } from "../core/container.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { forbidden, unauthorized } from "../errors/http-errors.ts";

/**
 * Default Supabase authentication handler with client caching
 * Uses Authorization header with Bearer token
 *
 * Performance optimization: Caches Supabase client in closure
 * to avoid 5-10ms overhead per authenticated request.
 * Cache is per-authHandler instance, reused across requests.
 *
 * @param container - Service container with environment and Supabase client factory
 * @example
 * ```typescript
 * const router = defineRouter({
 *   // authHandler not provided - uses this default
 *   routes: [...]
 * });
 * ```
 */
export function createDefaultAuthHandler<TUser = unknown, TRole = string>(
  container: ServiceContainer,
): Promise<
  (
    req: Request,
    options: AuthOptions<TRole>,
  ) => Promise<AuthResult<TUser, TRole>>
> {
  // Environment configuration (lazy errors for better DX)
  const url = container.env.get("SUPABASE_URL");
  const serviceKey = container.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = container.env.get("SUPABASE_ANON_KEY");

  if (!url) {
    throw new Error(
      "Supabase configuration missing. Provide SUPABASE_URL environment variable or custom authHandler.",
    );
  }

  if (!serviceKey) {
    throw new Error(
      "Supabase configuration missing. Provide SUPABASE_SERVICE_ROLE_KEY environment variable or custom authHandler.",
    );
  }

  if (!anonKey) {
    throw new Error(
      "Supabase configuration missing. Provide SUPABASE_ANON_KEY environment variable or custom authHandler.",
    );
  }

  // Cache admin (service role) client for token verification
  let cachedServiceClient: SupabaseClient | null = null;
  let cachedServiceUrl: string | undefined;
  let cachedServiceKey: string | undefined;

  const getServiceClient = (): SupabaseClient => {
    if (
      !cachedServiceClient || cachedServiceUrl !== url ||
      cachedServiceKey !== serviceKey
    ) {
      cachedServiceClient = container.supabaseClientFactory.create(
        url,
        serviceKey,
      );
      cachedServiceUrl = url;
      cachedServiceKey = serviceKey;
    }
    return cachedServiceClient;
  };

  const handler = async (
    req: Request,
    options: AuthOptions<TRole>,
  ): Promise<AuthResult<TUser, TRole>> => {
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "");

    if (!authHeader || !token) {
      return { response: unauthorized("Authorization header required") };
    }

    // Resolve service client lazily (only if needed beyond token verification)
    const serviceClient = getServiceClient();

    // Check for service role bypass
    if (options.requireServiceRole || options.bypassWithServiceRole) {
      if (token === serviceKey) {
        // Log warning if service role is used (security audit)
        if (options.requireServiceRole) {
          container.logger.warn(
            "Service role key used for authentication. This should only be used for internal operations.",
          );
        }
        return {
          supabaseClient: serviceClient,
          serviceRoleClient: serviceClient,
          serviceBypassed: true,
        } as AuthResult<TUser, TRole>;
      }

      if (options.requireServiceRole) {
        return { response: unauthorized("Service role key required") };
      }
    }

    // Check for anon key bypass
    if (options.bypassWithAnonRole && token === anonKey) {
      return {
        supabaseClient: container.getOrCreateAnonClient(),
        serviceBypassed: true,
      } as AuthResult<TUser, TRole>;
    }

    if (options.requireUserAuth === false) {
      return {
        supabaseClient: container.getOrCreateAnonClient(),
      } as AuthResult<TUser, TRole>;
    }

    // Validate user token using service client
    const { data: userData, error: authError } = await serviceClient.auth
      .getUser(token);

    if (authError || !userData?.user) {
      return { response: unauthorized("Invalid or expired token") };
    }

    const user = {
      id: userData.user.id,
      email: userData.user.email,
      ...userData.user.user_metadata,
    } as TUser;

    // RBAC enforcement
    if (options.requireRBAC && options.allowedRoles) {
      const userRole = (user as { role?: TRole } | undefined)?.role;

      if (userRole === undefined || userRole === null) {
        return { response: forbidden("User role not found") };
      }

      if (!options.allowedRoles.includes(userRole)) {
        return { response: forbidden("Insufficient permissions") };
      }
    }

    // Create user-scoped client using JWT token
    const userClient = container.supabaseClientFactory.createWithToken(
      url,
      anonKey,
      token,
    );

    return {
      user,
      supabaseClient: userClient,
      serviceBypassed: false,
    } as AuthResult<TUser, TRole>;
  };

  return Promise.resolve(handler);
}

/**
 * Get default auth handler or throw error with helpful message
 *
 * @param container - Service container with environment and Supabase client factory
 */
export async function getOrCreateDefaultAuthHandler<
  TUser = unknown,
  TRole = string,
>(
  container: ServiceContainer,
): Promise<
  (
    req: Request,
    options: AuthOptions<TRole>,
  ) => Promise<AuthResult<TUser, TRole>>
> {
  try {
    return await createDefaultAuthHandler<TUser, TRole>(container);
  } catch (error) {
    throw new Error(
      `Authentication configuration error: ${
        error instanceof Error ? error.message : error
      }\n\n` +
        "To fix this:\n" +
        "1. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables, OR\n" +
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
