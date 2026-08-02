import type ts from "typescript";

/**
 * The built program, held for the isolate's life so synchronous rules can read
 * it.
 *
 * Building resolves modules through Deno, which is asynchronous, so it cannot
 * happen inside a rule. It happens once at plugin load, under a top-level
 * `await` that `deno lint` waits on before running any rule, and the result
 * lands here. Verified: `deno lint` runs every rule in the isolate that loaded
 * the plugin, so a module variable reaches all of them.
 *
 * Nothing is written to disk. A lint run must not leave artifacts in the project
 * it is linting.
 *
 * @module
 */

/** A built program, kept alive so one changed file can be rebuilt against it. */
export interface Project {
  /** The program as it stands, from the build or the last rebuild. */
  readonly program: ts.Program;
  /** Rebuilds with one file's text replaced, or null when it cannot. */
  readonly rebuild: (path: string, text: string) => ts.Program | null;
}

let project: Project | null = null;

/** One rebuild kept per file, so every rule on that file reuses it. */
const rebuilt = new Map<
  string,
  { text: string; source: ts.SourceFile | null }
>();

/** Publishes the built project, for rules to read. */
export function setProject(next: Project | null): void {
  project = next;
  rebuilt.clear();
}

/** The built project, or null when the build never finished. */
export function currentProject(): Project | null {
  return project;
}

/**
 * The parsed source for the file being linted, rebuilding when it has changed.
 *
 * An editor lints a buffer that no longer matches the file on disk, and every
 * position the checker reports is an offset into the text it parsed, so stale
 * source is not merely old but wrong. A rebuild swaps that one file and reuses
 * the program, which is far cheaper than building again: every unchanged file is
 * handed back to TypeScript as the identical object, so only the edited file is
 * parsed.
 *
 * Each rule on a file asks for this, so the rebuild is kept until the text
 * changes again. A failed rebuild is kept too, so it is not retried once per
 * rule.
 */
export function currentSourceFile(
  filename: string,
  text: string,
): ts.SourceFile | null {
  if (project === null) {
    return null;
  }
  const built = project.program.getSourceFile(filename);
  if (built !== undefined && built.text === text) {
    return built;
  }
  const previous = rebuilt.get(filename);
  if (previous !== undefined && previous.text === text) {
    return previous.source;
  }
  const program = project.rebuild(filename, text);
  const source = program?.getSourceFile(filename) ?? null;
  rebuilt.set(filename, { text, source });
  return source;
}
