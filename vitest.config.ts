import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Vitest runs the pure-function unit tests (e.g. tests/call-reviewer.spec.ts).
// The app is server-first, so unit-tested modules pull in the `server-only`
// guard and the `@/` path alias; neither resolves under a bare Node/Vitest run.
// Alias `@/` → ./src and stub `server-only` to a no-op so those modules import.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(
        new URL("./tests/stubs/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.unit.test.ts"],
    // Ten of these files are static analysis over the repo itself, not pure
    // functions: they read all 206 migrations (~1.3 MB) and every file under
    // src/ (531 files, ~3.1 MB) to assert things a reviewer cannot check by
    // eye — that a SQL predicate still matches its TypeScript, that no paged
    // read lost its ORDER BY. Vitest's 5s default is sized for tests that touch
    // no disk at all, and with several workers contending for it these crossed
    // it often enough to fail roughly one full run in three, always with
    // `Test timed out`, never an assertion. A guard that has to be re-run until
    // it goes green is a guard people learn to ignore. The whole suite still
    // finishes in about 30 seconds; this only changes when a genuinely stuck
    // test is declared dead.
    testTimeout: 30_000,
  },
});
