/**
 * A TypeScript program that resolves modules the way Deno does.
 *
 * Deno lint hands a rule one file at a time, parsed, with no types and no
 * cross-file resolution. Everything type-aware in this package rests on the
 * program built here.
 *
 * It is exported because a test needs to build one for itself, over a fixture
 * project whose dependencies must resolve exactly as they would in a real lint
 * run. A plugin has no reason to call it: the program its rules read is already
 * built at load.
 *
 * @module
 */

export * from "./deno-program.ts";
