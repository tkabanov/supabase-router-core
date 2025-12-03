/**
 * Basic router example with simple role system
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { defineRoute, defineRouter } from "../mod.ts";
import { z } from "npm:zod";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

// Simple role enum
enum BasicRoles {
  ADMIN = "admin",
  USER = "user",
}

// Simple user type
interface BasicUser {
  id: string;
  email: string;
  role: BasicRoles;
}

// Define schemas
const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
});

const userResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  createdAt: z.string(),
});

// Create router
export const router = defineRouter<BasicRoles, BasicUser>({
  basePath: "/api/v1",
  defaultTags: ["Users API"],

  // Simple auth handler
  authHandler: (
    req: Request,
    _options: import("../core/types.ts").AuthOptions<BasicRoles>,
  ) => {
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");

    if (!token) {
      return Promise.resolve({
        response: new Response("Unauthorized", { status: 401 }),
      });
    }

    // Mock user - replace with real auth
    const user: BasicUser = {
      id: "123",
      email: "user@example.com",
      role: BasicRoles.USER,
    };

    return Promise.resolve({
      user,
      supabaseClient: null as unknown as SupabaseClient, // Replace with real client
    });
  },

  routes: [
    // Public endpoint (no auth)
    defineRoute({
      method: "GET",
      path: "/health",
      summary: "Health check",
      authRequired: false,
      handler: () =>
        Promise.resolve({ status: "ok", timestamp: new Date().toISOString() }),
    }),

    // Authenticated endpoint
    defineRoute({
      method: "GET",
      path: "/users/me",
      summary: "Get current user",
      authRequired: true,
      responseSchema: userResponseSchema,
      handler: ({ user }) =>
        Promise.resolve({
          id: user.id,
          email: user.email,
          name: "John Doe",
          createdAt: new Date().toISOString(),
        }),
    }),

    // Admin-only endpoint
    defineRoute({
      method: "POST",
      path: "/users",
      summary: "Create user (admin only)",
      authRequired: true,
      allowedRoles: [BasicRoles.ADMIN],
      requestSchema: {
        body: createUserSchema,
      },
      responseSchema: userResponseSchema,
      handler: ({ body, _user, _supabaseClient }) => {
        // body is typed as { email: string, name: string }
        // user is typed as BasicUser with role ADMIN

        // Create user logic here
        return Promise.resolve({
          id: crypto.randomUUID(),
          email: body.email,
          name: body.name,
          createdAt: new Date().toISOString(),
        });
      },
    }),

    // Endpoint with path and query params
    defineRoute({
      method: "GET",
      path: "/users/:id",
      summary: "Get user by ID",
      authRequired: true,
      requestSchema: {
        params: z.object({ id: z.string().uuid() }),
        query: z.object({
          include: z.enum(["profile", "posts"]).optional(),
        }),
      },
      handler: ({ params, query }) =>
        Promise.resolve({
          id: params.id,
          included: query.include || "none",
        }),
    }),
  ],
});

// For standalone execution
if (import.meta.main) {
  console.log("Starting basic example server...");
  Deno.serve(router.handler);
}
