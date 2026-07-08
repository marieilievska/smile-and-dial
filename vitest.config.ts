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
  },
});
