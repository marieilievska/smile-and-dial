// Teach plain `node` the app's "@/…" import alias.
//
// The parity scripts import real application modules rather than re-typing the
// rules those modules hold — that is the whole point of them, since a checker
// that re-implements what it checks can make the same mistake twice and call it
// agreement. `node --experimental-strip-types` runs the .ts files happily, but
// it has no idea what "@/lib/calls/outcomes" means: the alias lives in
// tsconfig.json, which node never reads. So src/lib/calls/outcomes.ts, whose
// own first line is `import … from "@/lib/labels"`, fails to load.
//
// This is a module-resolution hook (node:module register()). It maps a leading
// "@/" to src/ and, because ESM has no extension guessing, tries the extensions
// TypeScript would have. Anything else is passed straight through untouched.
//
// Register it from a script, before dynamically importing app code:
//
//   import { register } from "node:module";
//   register("./ts-path-alias.mjs", import.meta.url);
//   const { THING } = await import("../src/lib/…/module.ts");
//
// The import must be dynamic: static imports are hoisted above the register()
// call and would resolve before the hook exists.
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = new URL("../src/", import.meta.url);

/** In the order tsc's moduleResolution would try them. */
const CANDIDATES = [
  "",
  ".ts",
  ".tsx",
  ".mjs",
  ".js",
  "/index.ts",
  "/index.tsx",
];

function isFile(url) {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, next) {
  if (!specifier.startsWith("@/")) return next(specifier, context);
  const base = new URL(specifier.slice(2), SRC);
  for (const ext of CANDIDATES) {
    const candidate = new URL(base.href + ext);
    if (isFile(candidate)) return next(candidate.href, context);
  }
  // Fall through so node reports its own "cannot find module" against the
  // specifier the author actually wrote.
  return next(specifier, context);
}
