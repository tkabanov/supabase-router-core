import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { drizzle as drizzleFactory } from "npm:drizzle-orm/postgres-js";

type TransactionDbClient = ReturnType<typeof drizzleFactory>;

/**
 * Module-level cache for Supabase clients
 * 
 * IMPORTANT: In serverless environments (Deno Deploy, Supabase Edge Functions):
 * - Cache works within a single warm instance (reused across multiple requests)
 * - Cache is reset on cold starts (new instance initialization)
 * - This is a performance optimization, not a guarantee
 * 
 * For best results, create container at module level (not per-request):
 * ```typescript
 * // ✅ Good - container created once at module level
 * const container = createContainer({...});
 * const router = defineRouter({ container, routes: [...] });
 * 
 * // ❌ Bad - container created per request (cache doesn't help)
 * Deno.serve(async (req) => {
 *   const container = createContainer({...});
 *   // ...
 * });
 * ```
 */
let moduleCachedAnonClient: SupabaseClient | null = null;
let moduleCachedAnonUrl: string | undefined;
let moduleCachedAnonKey: string | undefined;
let moduleCachedServiceClient: SupabaseClient | null = null;
let moduleCachedServiceUrl: string | undefined;
let moduleCachedServiceKey: string | undefined;

/**
 * Logger interface for dependency injection
 * Allows custom logging implementations for testing or custom behavior
 *
 * @example
 * ```typescript
 * const customLogger: Logger = {
 *   log: (msg) => console.log(`[INFO] ${msg}`),
 *   error: (msg) => console.error(`[ERROR] ${msg}`),
 *   warn: (msg) => console.warn(`[WARN] ${msg}`),
 * };
 * ```
 */
export interface Logger {
  log(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

/**
 * ID generator interface for dependency injection
 * Allows custom ID generation for testing or custom formats
 *
 * @example
 * ```typescript
 * const customIdGenerator: IdGenerator = {
 *   generate: () => `custom-${Date.now()}`,
 * };
 * ```
 */
export interface IdGenerator {
  generate(): string;
}

/**
 * Supabase client factory interface for dependency injection
 * Allows custom client creation for testing or custom configurations
 *
 * @example
 * ```typescript
 * const mockFactory: SupabaseClientFactory = {
 *   create: (url, key) => mockSupabaseClient,
 *   createWithToken: (token) => mockSupabaseClientWithToken,
 * };
 * ```
 */
export interface SupabaseClientFactory {
  create(url: string, key: string): SupabaseClient;
  createWithToken(url: string, anonKey: string, token: string): SupabaseClient;
}

/**
 * Environment variable provider interface for dependency injection
 * Allows custom environment variable handling for testing
 *
 * @example
 * ```typescript
 * const testEnv: EnvironmentProvider = {
 *   get: (key) => testEnvVars[key],
 *   require: (key) => testEnvVars[key] || throw new Error(),
 * };
 * ```
 */
export interface EnvironmentProvider {
  get(key: string): string | undefined;
  require(key: string): string;
}

/**
 * Service container interface
 * Extensible container for core services and custom user services
 *
 * @example
 * ```typescript
 * // With custom services
 * interface MyServices extends ServiceContainer {
 *   emailService: EmailService;
 *   paymentService: PaymentService;
 * }
 *
 * const container: MyServices = createContainer({
 *   emailService: new EmailService(),
 *   paymentService: new PaymentService(),
 * });
 * ```
 */
export interface ServiceContainer {
  /** Logging service */
  logger: Logger;
  /** ID generation service */
  idGenerator: IdGenerator;
  /** Supabase client factory */
  supabaseClientFactory: SupabaseClientFactory;
  /** Environment variable provider */
  env: EnvironmentProvider;
  /** Get or create cached anonymous Supabase client (performance optimization) */
  getOrCreateAnonClient: () => SupabaseClient;
  /** Get or create cached service-role Supabase client */
  getOrCreateServiceClient: () => SupabaseClient;
  /** Get or create cached transaction pooler database client */
  getOrCreateDbClient?: () => TransactionDbClient;
}

/**
 * Default logger implementation using console
 */
export const defaultLogger: Logger = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
};

/**
 * Default ID generator using crypto.randomUUID()
 */
export const defaultIdGenerator: IdGenerator = {
  generate: () => crypto.randomUUID(),
};

/**
 * Default Supabase client factory using official client
 */
export const defaultSupabaseClientFactory: SupabaseClientFactory = {
  create: (url: string, key: string) => createClient(url, key),
  createWithToken: (url: string, anonKey: string, token: string) =>
    createClient(url, anonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    }),
};

/**
 * Default environment provider using Deno.env
 */
export const defaultEnv: EnvironmentProvider = {
  get: (key: string) => Deno.env.get(key),
  require: (key: string) => {
    const value = Deno.env.get(key);
    if (!value) {
      throw new Error(`Required environment variable ${key} not found`);
    }
    return value;
  },
};

/**
 * Create a service container with defaults and optional overrides
 *
 * Performance: Includes module-level cached Supabase clients to avoid
 * creating new clients on every request (5-8ms overhead per request).
 *
 * **Serverless Environment Notes:**
 * - Cache works within a single warm instance (reused across multiple requests)
 * - Cache is reset on cold starts (new instance initialization)
 * - For best performance, create container at module level, not per-request
 *
 * @param overrides - Partial container to override default services or add custom services
 * @returns Complete service container
 *
 * @example
 * ```typescript
 * // ✅ Good - container created once at module level
 * const container = createContainer({
 *   emailService: new EmailService(),
 * });
 * const router = defineRouter({ container, routes: [...] });
 *
 * // Use all defaults
 * const container = createContainer();
 *
 * // Override logger only
 * const container = createContainer({
 *   logger: customLogger,
 * });
 *
 * // Add custom services
 * const container = createContainer({
 *   emailService: new EmailService(),
 *   paymentService: new PaymentService(),
 * });
 * ```
 */
export function createContainer<
  TOverrides extends Record<string, unknown> = Record<string, never>,
>(
  overrides?:
    & Partial<ServiceContainer>
    & TOverrides
    & Record<string, unknown>,
): ServiceContainer & TOverrides {

  const providedOverrides = (overrides ?? {}) as
    & Partial<ServiceContainer>
    & TOverrides
    & Record<string, unknown>;

  const container = {
    logger: defaultLogger,
    idGenerator: defaultIdGenerator,
    supabaseClientFactory: defaultSupabaseClientFactory,
    env: defaultEnv,
    getOrCreateAnonClient: providedOverrides.getOrCreateAnonClient ??
      (() => {
        throw new Error(
          "SUPABASE_URL and SUPABASE_ANON_KEY required",
        );
      }),
    getOrCreateServiceClient: providedOverrides.getOrCreateServiceClient ??
      (() => {
        throw new Error(
          "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required",
        );
      }),
    getOrCreateDbClient: providedOverrides.getOrCreateDbClient,
    ...providedOverrides,
  } as ServiceContainer & TOverrides;

  // Add helper method for cached anon client
  // Uses module-level cache (shared across all container instances in same module)
  const getOrCreateAnonClient = (): SupabaseClient => {
    const url = container.env.get("SUPABASE_URL");
    const anonKey = container.env.get("SUPABASE_ANON_KEY");

    if (!url || !anonKey) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_ANON_KEY required",
      );
    }

    // Return cached client if same URL and key (performance optimization)
    // Cache is module-level, shared across all container instances
    if (
      moduleCachedAnonClient &&
      moduleCachedAnonUrl === url &&
      moduleCachedAnonKey === anonKey
    ) {
      return moduleCachedAnonClient;
    }

    // Create and cache new client at module level
    moduleCachedAnonClient = container.supabaseClientFactory.create(
      url,
      anonKey,
    );
    moduleCachedAnonUrl = url;
    moduleCachedAnonKey = anonKey;

    return moduleCachedAnonClient;
  };

  const getOrCreateServiceClient = (): SupabaseClient => {
    const url = container.env.get("SUPABASE_URL");
    const serviceKey = container.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!url || !serviceKey) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required",
      );
    }

    // Return cached client if same URL and key
    // Cache is module-level, shared across all container instances
    if (
      moduleCachedServiceClient &&
      moduleCachedServiceUrl === url &&
      moduleCachedServiceKey === serviceKey
    ) {
      return moduleCachedServiceClient;
    }

    // Create and cache new client at module level
    moduleCachedServiceClient = container.supabaseClientFactory.create(
      url,
      serviceKey,
    );
    moduleCachedServiceUrl = url;
    moduleCachedServiceKey = serviceKey;

    return moduleCachedServiceClient;
  };

  if (
    !("getOrCreateAnonClient" in providedOverrides) ||
    typeof providedOverrides.getOrCreateAnonClient !== "function"
  ) {
    container.getOrCreateAnonClient = getOrCreateAnonClient;
  }

  if (
    !("getOrCreateServiceClient" in providedOverrides) ||
    typeof providedOverrides.getOrCreateServiceClient !== "function"
  ) {
    container.getOrCreateServiceClient = getOrCreateServiceClient;
  }

  if (
    "getOrCreateDbClient" in providedOverrides &&
    providedOverrides.getOrCreateDbClient &&
    typeof providedOverrides.getOrCreateDbClient !== "function"
  ) {
    throw new Error("getOrCreateDbClient override must be a function");
  }

  return container;
}
