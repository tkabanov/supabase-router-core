/**
 * Example using built-in Supabase authentication
 * No custom authHandler needed - uses default implementation
 */

import "@supabase/functions-js/edge-runtime.d.ts";
import { defineRoute, defineRouter } from "../mod.ts";
import { z } from "zod";

// Simple role enum
enum Roles {
  ADMIN = "admin",
  USER = "user",
}

// User type: built from the token's app_metadata (server-controlled),
// plus id and email. Use `userLoader` to load it from your own table instead.
interface User {
  id: string;
  email: string;
  role: Roles;
}

// Schemas
const createPostSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
});

/**
 * Router with built-in authentication
 *
 * Requirements:
 * - SUPABASE_URL environment variable
 * - SUPABASE_PUBLISHABLE_KEYS (and SUPABASE_SECRET_KEYS for secret-key routes);
 *   auto-provisioned in hosted Edge Functions. Legacy SUPABASE_ANON_KEY /
 *   SUPABASE_SERVICE_ROLE_KEY still work until Supabase removes them.
 * - Users must have 'role' in app_metadata (only the service role can set it)
 */
export const router = defineRouter<Roles, User>({
  basePath: "/api",
  defaultTags: ["API"],

  // No authHandler needed! Uses default Supabase authentication
  // It will:
  // 1. Validate Bearer token using Supabase Auth
  // 2. Extract user data from JWT
  // 3. Check RBAC if specified
  // 4. Provide user and supabaseClient to handlers

  routes: [
    // Public endpoint
    defineRoute({
      method: "GET",
      path: "/health",
      summary: "Health check",
      authRequired: false,
      handler: () => Promise.resolve({ status: "ok" }),
    }),

    // Authenticated endpoint - any logged-in user
    defineRoute({
      method: "GET",
      path: "/profile",
      summary: "Get current user profile",
      authRequired: true,
      handler: ({ user, services }) =>
        Promise.resolve({
          id: user.id,
          email: user.email,
          role: user.role,
          hasElevatedAccess: Boolean(services.getOrCreateServiceClient()),
        }),
    }),

    // Admin-only endpoint
    defineRoute({
      method: "POST",
      path: "/posts",
      summary: "Create post (admin only)",
      authRequired: true,
      authentication: {
        requireUserAuth: true,
        requireRBAC: true,
        allowedRoles: [Roles.ADMIN],
      },
      requestSchema: {
        body: createPostSchema,
      },
      handler: async ({ body, user, supabaseClient }) => {
        // user.role is guaranteed to be ADMIN
        const { data, error } = await supabaseClient
          .from("posts")
          .insert({
            title: body.title,
            content: body.content,
            author_id: user.id,
          })
          .select()
          .single();

        if (error) throw new Error(error.message);

        return { success: true, post: data };
      },
    }),

    // Secret-key endpoint (internal use)
    // ⚠️ WARNING: This endpoint requires a secret key and should NEVER be called from frontend
    // Service role bypasses RLS and has full database access. Only use for internal operations.
    defineRoute({
      method: "POST",
      path: "/internal/cleanup",
      summary: "Internal cleanup (service role only)",
      authRequired: true,
      authentication: {
        requireServiceRole: true,
        requireUserAuth: false,
      },
      handler: async ({ serviceRoleClient }) => {
        // Only accessible with a secret key:
        //   apikey: sb_secret_...
        // (legacy: Authorization: Bearer <service_role key>)
        // ⚠️ SECURITY: Never expose this endpoint to frontend code

        if (!serviceRoleClient) {
          throw new Error("Service role client not available");
        }

        const response = await serviceRoleClient
          .from("logs")
          .delete()
          .lt(
            "created_at",
            new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
          );

        const { data, error } = response as {
          data: Array<Record<string, unknown>> | null;
          error: { message: string } | null;
        };

        if (error) throw new Error(error.message);

        return { success: true, deleted: data ? data.length : 0 };
      },
    }),
  ],
});

/**
 * Usage:
 *
 * 1. Environment variables (auto-provisioned in hosted Edge Functions):
 *    SUPABASE_URL=https://xxx.supabase.co
 *    SUPABASE_PUBLISHABLE_KEYS={"default":"sb_publishable_..."}
 *    SUPABASE_SECRET_KEYS={"default":"sb_secret_..."}
 *    SUPABASE_JWKS={"keys":[...]}   (optional; enables local JWT verification)
 *    In supabase/config.toml set `verify_jwt = false` for this function: the
 *    router authenticates requests itself, and secret-key callers send no JWT.
 *
 * 2. Assign roles server-side via app_metadata (NOT user_metadata, which
 *    every user can change for themselves with auth.updateUser):
 *    await supabaseAdmin.auth.admin.updateUserById(userId, {
 *      app_metadata: { role: 'admin' }
 *    })
 *
 * 3. Send requests with Bearer token:
 *    Authorization: Bearer <user_access_token>
 */

if (import.meta.main) {
  console.log("Starting server with built-in Supabase authentication...");
  console.log("   Required env vars:");
  console.log("   - SUPABASE_URL");
  console.log("   - SUPABASE_PUBLISHABLE_KEYS (or legacy SUPABASE_ANON_KEY)");
  console.log(
    "   - SUPABASE_SECRET_KEYS (or legacy SUPABASE_SERVICE_ROLE_KEY)",
  );
  console.log("");
  console.log("   User app_metadata must include:");
  console.log('   - role: "admin" | "user"');
  Deno.serve(router.handler);
}
