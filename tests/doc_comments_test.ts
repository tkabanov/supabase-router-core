import { assertEquals } from "@std/assert";
import { walk } from "@std/fs/walk";

// Supabase CLI bundles Edge Functions by scanning file text for imports, including
// examples inside JSDoc comments. A relative import in a comment that does not
// resolve breaks `supabase functions serve/deploy` for anyone who vendors this
// library into supabase/functions/_shared.
const RELATIVE_IMPORT = /\b(from|import)\s*\(?["']\.{1,2}\//;

/** Line numbers of relative imports that appear inside comments */
export function relativeImportsInComments(source: string): number[] {
  const found: number[] = [];
  let inBlock = false;
  source.split("\n").forEach((line, index) => {
    const blockStart = line.indexOf("/*");
    const lineComment = line.indexOf("//");
    const commentText = inBlock
      ? line
      : blockStart >= 0
      ? line.slice(blockStart)
      : lineComment >= 0
      ? line.slice(lineComment)
      : "";
    if (RELATIVE_IMPORT.test(commentText)) found.push(index + 1);
    if (blockStart >= 0 && !line.includes("*/", blockStart + 2)) inBlock = true;
    if (inBlock && line.includes("*/") && blockStart < 0) inBlock = false;
  });
  return found;
}

Deno.test("comment scanner finds imports in JSDoc, block and line comments", () => {
  const source = [
    'import { a } from "./real.ts";',
    "/**",
    " * import { b } from './jsdoc.ts';",
    " */",
    "/*",
    "   import { c } from '../block.ts';",
    "*/",
    "// import { d } from './line.ts';",
    'export { e } from "./reexport.ts";',
  ].join("\n");
  assertEquals(relativeImportsInComments(source), [3, 6, 8]);
});

Deno.test("doc comments contain no relative imports", async () => {
  const offenders: string[] = [];
  const root = new URL("..", import.meta.url).pathname;
  for await (
    const entry of walk(root, {
      exts: [".ts"],
      skip: [/node_modules/, /tests\//, /\/\./],
    })
  ) {
    const source = await Deno.readTextFile(entry.path);
    for (const line of relativeImportsInComments(source)) {
      offenders.push(`${entry.path.slice(root.length)}:${line}`);
    }
  }
  assertEquals(offenders, []);
});
