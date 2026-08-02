import type ts from "typescript";

import { setProject } from "#store";

/**
 * Installing a program by hand, for rule tests.
 *
 * `Deno.lint.runPlugin` lints a snippet that belongs to no project, so nothing
 * the plugin built at load contains it and every type-aware rule would go
 * silent. A test assembles its own program — typically the snippet plus the
 * imports it omits, arranged so the snippet's offsets are unchanged — and
 * installs it here.
 *
 * Importing this module does not build anything. It is the one entry point that
 * reaches the store without the plugin-load build behind it, so a test suite
 * does not pay for a program it is about to replace.
 *
 * @module
 */

/**
 * Installs a program for rules to read, in place of the one built at load.
 *
 * The program's copy of a file is used whatever the linted text is, since a test
 * program is built from text that deliberately differs from the snippet.
 */
export function useTestProgram(program: ts.Program): void {
  setProject({ program, rebuild: () => null, trustStaleText: true });
}

/** Removes the installed program, leaving type-aware rules silent. */
export function clearTestProgram(): void {
  setProject(null);
}
