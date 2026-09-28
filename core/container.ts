import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { TransactionDbClient } from "./types.ts";
import { resolveSupabaseKeys } from "./supabase-keys.ts";

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
  /** Log an informational message */
  log(message: string, ...args: unknown[]): void;
  /** Log an error */
  error(message: string, ...args: unknown[]): void;
  /** Log a warning */
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
  /** Return a new unique ID */
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
 *   createWithToken: (url, publishableKey, token) => mockUserClient(token),
 * };
 * ```
 */
export interface SupabaseClientFactory {
  /** Create a client for an API key (publishable or secret) */
  create(url: string, key: string): SupabaseClient;
  /** Create a user-scoped client (publishable key + the user's JWT) */
  createWithToken(
    url: string,
    publishableKey: string,
    token: string,
  ): SupabaseClient;
}

/**
 * Environment variable provider interface for dependency injection
 * Allows custom environment variable handling for testing
 *
 * @example
 * ```typescript
 * const testEnv: EnvironmentProvider = {
 *   get: (key) => testEnvVars[key],
 *   require: (key) => {
 *     if (!testEnvVars[key]) throw new Error(`${key} missing`);
 *     return testEnvVars[key];
 *   },
 * };
 * ```
 */
export interface EnvironmentProvider {
  /** Read a variable, or undefined when unset */
  get(key: string): string | undefined;
  /** Read a variable, throwing when unset */
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
  /** Get or create cached client for the publishable (or legacy anon) key */
  getOrCreateAnonClient: () => SupabaseClient;
  /** Get or create cached admin client for the secret (or legacy service_role) key */
  getOrCreateServiceClient: () => SupabaseClient;
  /**
   * Get or create cached transaction pooler database client.
   * May be async: the router awaits it.
   */
  getOrCreateDbClient?: () =>
    | TransactionDbClient
    | Promise<TransactionDbClient>;
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

type KeyKind = "publishable" | "secret";

const KEY_ERRORS: Record<KeyKind, string> = {
  publishable:
    "SUPABASE_URL and a publishable key (SUPABASE_PUBLISHABLE_KEYS, SUPABASE_PUBLISHABLE_KEY or legacy SUPABASE_ANON_KEY) required",
  secret:
    "SUPABASE_URL and a secret key (SUPABASE_SECRET_KEYS, SUPABASE_SECRET_KEY or legacy SUPABASE_SERVICE_ROLE_KEY) required",
};

/**
 * Create a lazily-initialised Supabase client for the primary publishable or
 * secret key. The client is cached per container and recreated if the
 * resolved URL or key changes.
 */
const createCachedClientGetter = (
  getContainer: () => ServiceContainer,
  kind: KeyKind,
): () => SupabaseClient => {
  let cached: { client: SupabaseClient; url: string; key: string } | null =
    null;

  return () => {
    const container = getContainer();
    const keys = resolveSupabaseKeys(container.env);
    const key = kind === "publishable"
      ? keys.primaryPublishableKey
      : keys.primarySecretKey;

    if (!keys.url || !key) {
      throw new Error(KEY_ERRORS[kind]);
    }

    if (cached?.url !== keys.url || cached.key !== key) {
      cached = {
        client: container.supabaseClientFactory.create(keys.url, key),
        url: keys.url,
        key,
      };
    }

    return cached.client;
  };
};

/** Marks getters created by createContainer (bound to their container) */
const BUILT_IN_GETTER = Symbol("supabase-router.builtInGetter");

const markBuiltIn = <T extends object>(getter: T): T =>
  Object.assign(getter, { [BUILT_IN_GETTER]: true });

/**
 * Keep a user-provided getter, but never a built-in one copied from another
 * container: it would keep reading that container's env and factory.
 */
const pickFunction = <T>(value: unknown, fallback: T): T =>
  typeof value === "function" &&
    !(value as { [BUILT_IN_GETTER]?: boolean })[BUILT_IN_GETTER]
    ? value as T
    : fallback;

/**
 * Create a service container with defaults and optional overrides
 *
 * Performance: Supabase clients are created lazily and cached per container
 * to avoid creating new clients on every request (5-8ms overhead per request).
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
 * ```
 */
export function createContainer<TOverrides extends object = object>(
  overrides?: Partial<ServiceContainer> & TOverrides,
): ServiceContainer & TOverrides {
  const provided: Partial<ServiceContainer> = overrides ?? {};

  if (
    provided.getOrCreateDbClient !== undefined &&
    typeof provided.getOrCreateDbClient !== "function"
  ) {
    throw new Error("getOrCreateDbClient override must be a function");
  }

  const container = {
    logger: defaultLogger,
    idGenerator: defaultIdGenerator,
    supabaseClientFactory: defaultSupabaseClientFactory,
    env: defaultEnv,
    ...provided,
  } as ServiceContainer & TOverrides;

  const self = () => container;
  container.getOrCreateAnonClient = pickFunction(
    provided.getOrCreateAnonClient,
    markBuiltIn(createCachedClientGetter(self, "publishable")),
  );
  container.getOrCreateServiceClient = pickFunction(
    provided.getOrCreateServiceClient,
    markBuiltIn(createCachedClientGetter(self, "secret")),
  );

  return container;
}
