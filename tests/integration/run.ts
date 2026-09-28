// Runs the integration tests against a throwaway local Supabase stack.
//
//   deno task test:integration                 # active signing key ES256
//   deno task test:integration --alg RS256     # active signing key RS256
//   deno task test:integration --keep          # leave the stack running
//
// Requires Docker and the Supabase CLI. Set SUPABASE_CLI to use another CLI
// build, e.g. SUPABASE_CLI="npx -y supabase@beta".
//
// Steps: generate signing keys (active + previous verify-only key, to test
// rotation), vendor the library into the fixture Edge Function, start the
// stack on ports 553xx (project "supabase-router-it"), serve functions, run
// tests/integration/*_test.ts, stop the stack.
import { parseArgs } from "@std/cli/parse-args";
import { walk } from "@std/fs/walk";

const ROOT = new URL("../../", import.meta.url).pathname;
const FIXTURE = new URL("./", import.meta.url).pathname;
const SUPABASE_DIR = `${FIXTURE}supabase/`;
const GENERATED = `${FIXTURE}.generated/`;
const FUNCTION_URL = "http://127.0.0.1:55321/functions/v1/router-it/env";
const POOLER_URL =
  "postgresql://postgres.pooler-dev:postgres@127.0.0.1:55329/postgres";
const EXCLUDED_SERVICES =
  "studio,imgproxy,mailpit,logflare,vector,realtime,storage-api,postgres-meta";
const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi"];

type Alg = "ES256" | "RS256";
type Jwk = Record<string, unknown> & { kid: string; alg: Alg };

const cli = (Deno.env.get("SUPABASE_CLI") ?? "supabase").split(" ");

async function supabase(
  args: string[],
  options: { quiet?: boolean } = {},
): Promise<string> {
  const [command, ...prefix] = cli;
  const output = await new Deno.Command(command, {
    args: [...prefix, ...args],
    cwd: FIXTURE,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(output.stdout);
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`supabase ${args.join(" ")} failed:\n${stderr}${text}`);
  }
  if (!options.quiet) console.log(`✓ supabase ${args[0]} ${args[1] ?? ""}`);
  return text;
}

const KEYS_PATH = `${SUPABASE_DIR}signing_keys.json`;

/**
 * With signing_keys_path set in config.toml the CLI writes keys into that
 * file instead of stdout, so generate into an empty file and read it back.
 */
async function generateKey(alg: Alg): Promise<Jwk> {
  await Deno.writeTextFile(KEYS_PATH, "[]");
  await supabase(["gen", "signing-key", "--algorithm", alg, "--append"], {
    quiet: true,
  });
  const [key] = JSON.parse(await Deno.readTextFile(KEYS_PATH));
  return key;
}

const publicOnly = (jwk: Jwk): Jwk => {
  const copy: Record<string, unknown> = { ...jwk, key_ops: ["verify"] };
  for (const field of PRIVATE_JWK_FIELDS) delete copy[field];
  return copy as Jwk;
};

/**
 * Active key signs new tokens. The previous key (the other algorithm) stays
 * published for verification only, as after a key rotation. GoTrue accepts a
 * single private signing key, so the previous one is written without its
 * private part; its private JWK is kept aside for the rotation tests.
 */
async function writeSigningKeys(alg: Alg): Promise<string> {
  const active = await generateKey(alg);
  const previous = await generateKey(alg === "ES256" ? "RS256" : "ES256");
  await Deno.mkdir(GENERATED, { recursive: true });
  const previousPath = `${GENERATED}previous_key.json`;
  await Deno.writeTextFile(previousPath, JSON.stringify(previous));
  await Deno.writeTextFile(
    KEYS_PATH,
    JSON.stringify([active, publicOnly(previous)], null, 2),
  );
  console.log(`✓ signing keys: active ${alg}, previous ${previous.alg}`);
  return previousPath;
}

/** Copy the library into the function (the edge runtime only mounts supabase/) */
async function vendorLibrary(): Promise<void> {
  const target = `${SUPABASE_DIR}functions/_shared/router/`;
  await Deno.remove(target, { recursive: true }).catch(() => {});
  const skip = [/node_modules/, /\/tests\//, /\/examples\//, /\/\./];
  for await (const entry of walk(ROOT, { exts: [".ts"], skip })) {
    const relative = entry.path.slice(ROOT.length);
    const destination = `${target}${relative}`;
    await Deno.mkdir(destination.slice(0, destination.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.copyFile(entry.path, destination);
  }

  // The function uses the same pinned dependencies as the library
  const { imports } = JSON.parse(await Deno.readTextFile(`${ROOT}deno.json`));
  const runtimeImports = Object.fromEntries(
    Object.entries(imports as Record<string, string>).filter(([name]) =>
      !["eslint", "typescript-eslint", "@std/assert", "@std/fs"].includes(name)
    ),
  );
  await Deno.writeTextFile(
    `${SUPABASE_DIR}functions/router-it/deno.json`,
    JSON.stringify({ imports: runtimeImports }, null, 2),
  );
  console.log("✓ library vendored into supabase/functions/_shared/router");
}

const parseEnv = (text: string): Record<string, string> =>
  Object.fromEntries(
    text.split("\n")
      .map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [m[1], m[2]]),
  );

async function waitForFunction(): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const res = await fetch(FUNCTION_URL).catch(() => null);
    await res?.body?.cancel();
    if (res?.status === 200) {
      console.log("✓ edge function is serving");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Edge function did not become ready: ${FUNCTION_URL}`);
}

async function runTests(env: Record<string, string>): Promise<boolean> {
  const tests: string[] = [];
  for await (const entry of walk(FIXTURE, { match: [/_test\.ts$/] })) {
    tests.push(entry.path);
  }
  const { success } = await new Deno.Command(Deno.execPath(), {
    args: ["test", "-A", `--config=${ROOT}deno.json`, ...tests.sort()],
    cwd: ROOT,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  return success;
}

function serveFunctions(): Deno.ChildProcess {
  const [command, ...prefix] = cli;
  return new Deno.Command(command, {
    args: [...prefix, "functions", "serve"],
    cwd: FIXTURE,
    stdout: "null",
    stderr: "null",
  }).spawn();
}

async function main(): Promise<number> {
  const args = parseArgs(Deno.args, {
    string: ["alg"],
    boolean: ["keep"],
    default: { alg: "ES256" },
  });
  const alg = args.alg.toUpperCase() as Alg;
  if (alg !== "ES256" && alg !== "RS256") {
    console.error("--alg must be ES256 or RS256");
    return 2;
  }

  const previousKeyPath = await writeSigningKeys(alg);
  await vendorLibrary();

  let serve: Deno.ChildProcess | undefined;
  try {
    await supabase(["start", "-x", EXCLUDED_SERVICES]);
    const status = parseEnv(await supabase(["status", "-o", "env"]));
    serve = serveFunctions();
    await waitForFunction();

    const ok = await runTests({
      ...status,
      POOLER_URL,
      EXPECTED_ALG: alg,
      PREVIOUS_KEY_PATH: previousKeyPath,
    });
    return ok ? 0 : 1;
  } finally {
    serve?.kill();
    await serve?.status;
    if (!args.keep) await supabase(["stop", "--no-backup"]);
  }
}

Deno.exit(await main());
