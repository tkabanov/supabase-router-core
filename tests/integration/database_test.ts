// Transaction pooler client against Supavisor and a direct connection
import { assert, assertEquals } from "@std/assert";
import { stack } from "./support.ts";
import { callJson, makeRouter, newKeysEnv } from "./router_fixture.ts";

const timeoutWarnings = (logs: Array<[string, ...unknown[]]>) =>
  logs.filter(([level, message]) =>
    level === "warn" && String(message).includes("statement_timeout")
  );

Deno.test("Supavisor (transaction mode): queries work, dropped statement_timeout is reported", async () => {
  const { router, logs } = makeRouter(newKeysEnv(), {
    databaseUrl: stack.poolerUrl,
  });
  const { status, body } = await callJson(router, "/api/db");
  assertEquals(status, 200, JSON.stringify(logs));
  assertEquals(body.one, 1);
  // Supavisor silently drops connection startup parameters...
  assertEquals(body.timeout, "0");
  // ...so the router warns instead of failing silently
  assert(timeoutWarnings(logs).length === 1, JSON.stringify(logs));
  dispatchEvent(new Event("unload"));
});

Deno.test("direct connection: statement_timeout applies without warnings", async () => {
  const { router, logs } = makeRouter(newKeysEnv(), {
    databaseUrl: stack.dbUrl,
  });
  const { body } = await callJson(router, "/api/db");
  assertEquals(body.timeout, "1234ms");
  assertEquals(timeoutWarnings(logs), []);
  dispatchEvent(new Event("unload"));
});
