/**
 * The checker, reachable from inside a synchronous lint rule.
 *
 * Importing this module builds the project's TypeScript program, under the
 * top-level `await` that `deno lint` waits on before running any rule. That is
 * the only moment a program can be built: resolving modules the way Deno does is
 * asynchronous, and a rule is not.
 *
 * @module
 */

export * from "#services";
