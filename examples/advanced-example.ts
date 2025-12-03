/**
 * Advanced router example with hierarchical roles and middleware
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  defineRoute,
  defineRouter,
  loggingMiddleware,
  rateLimitMiddleware,
} from "../mod.ts";
import { z } from "npm:zod";
import { sql } from "npm:drizzle-orm";
import { createRoleHierarchy } from "../authentication/rbac.ts";

const noopAsync = () => Promise.resolve();

// Hierarchical role system
enum AdvancedRoles {
  SUPER_ADMIN = "super_admin",
  ADMIN = "admin",
  MODERATOR = "moderator",
  USER = "user",
  GUEST = "guest",
}

// Advanced user type with permissions
interface AdvancedUser {
  id: string;
  email: string;
  role: AdvancedRoles;
  permissions: string[];
  companyId?: number;
  metadata: Record<string, unknown>;
}

// Role hierarchy (higher roles inherit lower role permissions)
const roleHierarchy = {
  [AdvancedRoles.SUPER_ADMIN]: [
    AdvancedRoles.ADMIN,
    AdvancedRoles.MODERATOR,
    AdvancedRoles.USER,
    AdvancedRoles.GUEST,
  ],
  [AdvancedRoles.ADMIN]: [
    AdvancedRoles.MODERATOR,
    AdvancedRoles.USER,
    AdvancedRoles.GUEST,
  ],
  [AdvancedRoles.MODERATOR]: [AdvancedRoles.USER, AdvancedRoles.GUEST],
  [AdvancedRoles.USER]: [AdvancedRoles.GUEST],
  [AdvancedRoles.GUEST]: [],
};

const checkRoleHierarchy = createRoleHierarchy(roleHierarchy);

// Schemas
const createPostSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  published: z.boolean().default(false),
});

const updatePostSchema = createPostSchema.partial();

const postResponseSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  published: z.boolean(),
  authorId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// Custom middleware for permission checking
const permissionMiddleware = (
  requiredPermission: string,
): import("../core/types.ts").Middleware<AdvancedUser> => {
  return async (ctx, next) => {
    const user = ctx.user;
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (!user.permissions.includes(requiredPermission)) {
      return new Response("Forbidden: missing permission", { status: 403 });
    }

    return await next();
  };
};

// Create advanced router
export const router = defineRouter<AdvancedRoles, AdvancedUser>({
  basePath: "/api/v2",
  defaultTags: ["Advanced API"],

  // Global middlewares
  middlewares: [
    loggingMiddleware({ logBody: false }),
    rateLimitMiddleware({
      maxRequests: 1000,
      windowMs: 60000, // 1000 requests per minute
    }),
  ],

  // Advanced auth handler with role hierarchy
  authHandler: async (
    req: Request,
    options: import("../core/types.ts").AuthOptions<AdvancedRoles>,
  ) => {
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    await noopAsync();

    if (options.requireServiceRole) {
      // Check service role token
      if (token !== "service_role_key") {
        return { response: new Response("Unauthorized", { status: 401 }) };
      }
      return {};
    }

    if (options.requireUserAuth) {
      if (!token) {
        return { response: new Response("Unauthorized", { status: 401 }) };
      }

      // Mock user - replace with real auth
      const user: AdvancedUser = {
        id: "123",
        email: "admin@example.com",
        role: AdvancedRoles.ADMIN,
        permissions: [
          "posts.create",
          "posts.update",
          "posts.delete",
          "users.manage",
        ],
        companyId: 1,
        metadata: {},
      };

      // Check role hierarchy if RBAC enabled
      if (options.requireRBAC && options.allowedRoles) {
        const hasRole = options.allowedRoles.some((required) =>
          checkRoleHierarchy(user.role, required)
        );

        if (!hasRole) {
          return { response: new Response("Forbidden", { status: 403 }) };
        }
      }

      await noopAsync();
      return {
        user,
      };
    }

    return {};
  },

  // CORS configuration
  corsHeaders: {
    allowedOrigins: ["https://example.com", "https://app.example.com"],
    allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
    credentials: true,
  },

  // Optional direct database access via Supabase transaction pooler
  database: {
    enableTransactionPooler: true,
    connectionStringEnv: "SUPABASE_DB_POOLER_URL",
    statementTimeoutMs: 10_000,
    maxConnections: 4,
    disablePreparedStatements: true,
  },

  routes: [
    // Public endpoint with caching
    defineRoute({
      method: "GET",
      path: "/posts",
      summary: "List all posts",
      authRequired: false,
      requestSchema: {
        query: z.object({
          page: z.coerce.number().int().positive().default(1),
          limit: z.coerce.number().int().min(1).max(100).default(20),
          tag: z.string().optional(),
        }),
      },
      handler: async ({ query }) => {
        await noopAsync();
        return {
          posts: [],
          pagination: {
            page: query.page,
            limit: query.limit,
            total: 0,
          },
        };
      },
    }),

    // Create post (requires specific permission)
    defineRoute({
      method: "POST",
      path: "/posts",
      summary: "Create a new post",
      authRequired: true,
      allowedRoles: [AdvancedRoles.USER], // Users and above
      requestSchema: {
        body: createPostSchema,
      },
      responseSchema: postResponseSchema,
      middlewares: [
        permissionMiddleware("posts.create"),
      ],
      handler: async ({ body, user }) => {
        await noopAsync();
        return {
          id: crypto.randomUUID(),
          ...body,
          tags: body.tags || [],
          authorId: user.id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
    }),

    // Update post (moderators and above)
    defineRoute({
      method: "PATCH",
      path: "/posts/:id",
      summary: "Update a post",
      authRequired: true,
      allowedRoles: [AdvancedRoles.MODERATOR],
      requestSchema: {
        params: z.object({ id: z.string().uuid() }),
        body: updatePostSchema,
      },
      responseSchema: postResponseSchema,
      middlewares: [
        permissionMiddleware("posts.update"),
      ],
      handler: async ({ params, body, user }) => {
        await noopAsync();
        return {
          id: params.id,
          title: body.title || "Default Title",
          content: body.content || "Default Content",
          tags: body.tags || [],
          published: body.published ?? false,
          authorId: user.id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
    }),

    // Delete post (admin only)
    defineRoute({
      method: "DELETE",
      path: "/posts/:id",
      summary: "Delete a post",
      authRequired: true,
      allowedRoles: [AdvancedRoles.ADMIN],
      requestSchema: {
        params: z.object({ id: z.string().uuid() }),
      },
      middlewares: [
        permissionMiddleware("posts.delete"),
      ],
      handler: async ({ params }) => {
        await noopAsync();
        return {
          success: true,
          deletedId: params.id,
        };
      },
    }),

    // Super admin only endpoint
    defineRoute({
      method: "POST",
      path: "/admin/reset",
      summary: "Reset system (super admin only)",
      authRequired: true,
      allowedRoles: [AdvancedRoles.SUPER_ADMIN],
      handler: async ({ user }) => {
        await noopAsync();
        console.log(`System reset requested by ${user.email}`);
        return {
          success: true,
          message: "System reset initiated",
        };
      },
    }),

    // Transactional workload using Supabase transaction pooler + Drizzle
    defineRoute({
      method: "POST",
      path: "/reports/weekly",
      summary: "Generate weekly report with direct database access",
      description:
        "Demonstrates the useDatabase flag with the transaction pooler client.",
      authRequired: true,
      allowedRoles: [AdvancedRoles.ADMIN],
      useDatabase: true,
      handler: async ({ db }) => {
        if (!db) {
          throw new Response("Database unavailable", { status: 503 });
        }

        await db.transaction(async (tx) => {
          // Replace with your ORM/query builder logic
          await tx.execute(sql`select current_date`);
        });

        return {
          success: true,
          message: "Weekly report pipeline scheduled",
        };
      },
    }),

    // Service role endpoint (internal use)
    defineRoute({
      method: "POST",
      path: "/internal/cleanup",
      summary: "Internal cleanup task",
      authentication: {
        requireServiceRole: true,
        requireUserAuth: false,
      },
      handler: async () => {
        await noopAsync();
        // Internal cleanup logic
        return {
          success: true,
          cleaned: 100,
        };
      },
    }),
  ],
});

// For standalone execution
if (import.meta.main) {
  console.log("Starting advanced example server...");
  console.log("   - Role hierarchy enabled");
  console.log("   - Permission-based access control");
  console.log("   - Rate limiting: 1000 req/min");
  console.log("   - CORS: https://example.com, https://app.example.com");
  Deno.serve(router.handler);
}
