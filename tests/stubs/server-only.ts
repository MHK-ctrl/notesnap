/**
 * Test stub for the `server-only` package.
 *
 * The real package throws unless the module is resolved with the `react-server`
 * export condition (which Next.js uses for server code). Vitest runs in plain
 * Node, so the guard is aliased to this empty module in vitest.config.ts. The
 * guard still applies where it matters: the Next.js production build.
 */
export {};
