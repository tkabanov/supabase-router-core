/**
 * Example using built-in Supabase authentication
 * No custom authHandler needed - uses default implementation
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { defineRoute, defineRouter } from "../mod.ts";
import { z } from "npm:zod";

// Simple role enum
enum Roles {
  ADMIN = "admin",
  USER = "user",
}

// User type (must match data in user_metadata)
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
 * - SUPABASE_SERVICE_ROLE_KEY environment variable
 * - SUPABASE_ANON_KEY environment variable
 * - Users must have 'role' field in user_metadata
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

    // Service role endpoint (internal use)
    // ⚠️ WARNING: This endpoint requires service role key and should NEVER be called from frontend
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
        // Only accessible with service role key
        // Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
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
 * 1. Set environment variables:
 *    SUPABASE_URL=https://xxx.supabase.co
 *    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
 *    SUPABASE_ANON_KEY=eyJhbGc...
 *
 * 2. Make sure users have 'role' in user_metadata:
 *    await supabase.auth.updateUser({
 *      data: { role: 'admin' }
 *    })
 *
 * 3. Send requests with Bearer token:
 *    Authorization: Bearer <user_access_token>
 */

if (import.meta.main) {
  console.log("Starting server with built-in Supabase authentication...");
  console.log("   Required env vars:");
  console.log("   - SUPABASE_URL");
  console.log("   - SUPABASE_SERVICE_ROLE_KEY");
  console.log("   - SUPABASE_ANON_KEY");
  console.log("");
  console.log("   User metadata must include:");
  console.log('   - role: "admin" | "user"');
  Deno.serve(router.handler);
}
