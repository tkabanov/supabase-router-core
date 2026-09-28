import { defineRoute, defineRouter } from "../_shared/router/mod.ts";

// No container overrides: everything comes from the env the edge runtime
// auto-provisions (SUPABASE_URL, SUPABASE_PUBLISHABLE_KEYS, SUPABASE_SECRET_KEYS,
// SUPABASE_JWKS, legacy SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY).
const router = defineRouter({
  basePath: "/router-it",
  defaultTags: [],
  routes: [
    defineRoute({
      method: "GET",
      path: "/env",
      authRequired: false,
      handler: () => {
        const names = [
          "SUPABASE_URL",
          "SUPABASE_PUBLISHABLE_KEYS",
          "SUPABASE_SECRET_KEYS",
          "SUPABASE_JWKS",
          "SUPABASE_PUBLISHABLE_KEY",
          "SUPABASE_SECRET_KEY",
          "SUPABASE_ANON_KEY",
          "SUPABASE_SERVICE_ROLE_KEY",
        ];
        const present: Record<string, string> = {};
        for (const n of names) {
          const v = Deno.env.get(n);
          present[n] = !v
            ? "missing"
            : v.trim().startsWith("{")
            ? "json:" + Object.keys(JSON.parse(v)).join(",")
            : v.startsWith("sb_")
            ? v.slice(0, 15) + "..."
            : v.startsWith("eyJ")
            ? "jwt"
            : "set";
        }
        return Promise.resolve(present);
      },
    }),
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
      path: "/internal",
      authentication: { requireServiceRole: true },
      handler: async ({ serviceRoleClient }) => {
        const { data, error } = await serviceRoleClient!.auth.admin.listUsers();
        if (error) throw new Error(error.message);
        return { count: data.users.length };
      },
    }),
  ],
});

Deno.serve(router.handler);
