/**
 * A TypeScript program that resolves modules the way Deno does.
 *
 * Deno lint hands a rule one file at a time, parsed, with no types and no
 * cross-file resolution. Everything type-aware in this package rests on the
 * program built here.
 *
 * @module
 */

export * from "./deno-program.ts";
