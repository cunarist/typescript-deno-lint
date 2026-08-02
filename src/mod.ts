/**
 * Type-aware lint rules for Deno, authored the way typescript-eslint rules are.
 *
 * This entry point is rule authoring alone — messages, options, plugin
 * assembly — and builds nothing. Import `@cunarist/typescript-deno-lint/types`
 * from a rule that needs the checker; that is the entry point that builds the
 * program, and it is separate so a plugin with no type-aware rule pays nothing.
 *
 * @module
 */

export * from "#rule";
