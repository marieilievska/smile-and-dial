// No-op stub for the `server-only` package under Vitest. The real package throws
// if imported into a client bundle; in unit tests there is no bundler boundary,
// so this empty module lets server-first modules import cleanly.
export {};
