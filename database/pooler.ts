import type { ServiceContainer } from "../core/container.ts";
import type {
  RouterDatabaseConfig,
  TransactionDbClient,
} from "../core/types.ts";

const DEFAULT_DB_CONNECTION_ENV = "SUPABASE_DB_POOLER_URL";
const DEFAULT_DB_MAX_CONNECTIONS = 5;
const DEFAULT_DB_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_DB_CONNECTION_TIMEOUT_MS = 5_000;

const toSeconds = (ms: number): number => Math.max(1, Math.floor(ms / 1000));

type SqlClient = { end: () => Promise<void> };

type Sql = import("postgres").Sql;

/**
 * Transaction poolers (Supavisor, PgBouncer) silently drop connection startup
 * parameters, so check that the requested statement_timeout actually applies
 * and warn instead of failing silently.
 */
const verifyStatementTimeout = async (
  sql: Sql,
  expectedMs: number,
  container: ServiceContainer,
): Promise<void> => {
  try {
    const [row] = await sql`
      select extract(epoch from current_setting('statement_timeout')::interval) * 1000 as ms`;
    if (Number(row.ms) === expectedMs) {
      return;
    }
    container.logger.warn(
      `statementTimeoutMs=${expectedMs} was not applied (server reports ${row.ms}ms). ` +
        "Transaction poolers drop connection parameters; set it on the database role instead: " +
        `ALTER ROLE <db_user> SET statement_timeout = '${expectedMs}ms';`,
    );
  } catch (error) {
    container.logger.warn("Could not verify statement_timeout", error);
  }
};

const registerShutdown = (
  sql: SqlClient,
  container: ServiceContainer,
): void => {
  if (typeof addEventListener !== "function") {
    return;
  }
  addEventListener("unload", () => {
    sql.end().catch((error: unknown) => {
      container.logger.warn(
        "Failed to close transaction pooler connection on shutdown",
        error,
      );
    });
  });
};

const connect = async (
  container: ServiceContainer,
  config: RouterDatabaseConfig,
): Promise<TransactionDbClient> => {
  const envName = config.connectionStringEnv ?? DEFAULT_DB_CONNECTION_ENV;
  const connectionString = container.env.get(envName);
  if (!connectionString) {
    throw new Error(`Transaction pooler enabled but ${envName} is not set`);
  }

  // Loaded lazily so routers without a database don't pay the cold-start cost
  const [{ default: postgres }, { drizzle }] = await Promise.all([
    import("postgres"),
    import("drizzle-orm/postgres-js"),
  ]);

  const sql = postgres(connectionString, {
    max: config.maxConnections ?? DEFAULT_DB_MAX_CONNECTIONS,
    idle_timeout: toSeconds(
      config.idleTimeoutMs ?? DEFAULT_DB_IDLE_TIMEOUT_MS,
    ),
    connect_timeout: toSeconds(
      config.connectionTimeoutMs ?? DEFAULT_DB_CONNECTION_TIMEOUT_MS,
    ),
    prepare: config.disablePreparedStatements === false,
    // Sent as a startup parameter, so it applies to every connection
    ...(config.statementTimeoutMs && {
      connection: { statement_timeout: config.statementTimeoutMs },
    }),
  });

  registerShutdown(sql, container);
  if (config.statementTimeoutMs) {
    await verifyStatementTimeout(sql, config.statementTimeoutMs, container);
  }

  return config.drizzleConfig
    ? drizzle(sql, config.drizzleConfig)
    : drizzle(sql);
};

/**
 * Install a lazily-connected, cached Drizzle client on the container when the
 * transaction pooler is enabled and no custom `getOrCreateDbClient` exists.
 *
 * @param container - Service container to extend
 * @param config - Database configuration from the router
 */
export function installTransactionPoolerClient(
  container: ServiceContainer,
  config?: RouterDatabaseConfig,
): void {
  if (
    !config?.enableTransactionPooler ||
    typeof container.getOrCreateDbClient === "function"
  ) {
    return;
  }

  let client: Promise<TransactionDbClient> | null = null;

  container.getOrCreateDbClient = () => {
    client ??= connect(container, config).catch((error) => {
      // Allow a retry on the next request instead of caching the failure
      client = null;
      throw error;
    });
    return client;
  };
}
