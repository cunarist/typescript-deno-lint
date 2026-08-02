import { dirname, join, resolve } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";

/**
 * Per-rule options, read out of the project's Deno configuration file.
 *
 * Deno's plugin API has no channel for configuration: `Deno.lint.Plugin` is
 * `{ name, rules }` and `RuleContext` carries no `options`. The only way a rule
 * can be configured at all is to read the configuration file itself.
 *
 * It has to be a top-level key. Verified: Deno rejects an unknown field inside
 * `lint` — `unknown field 'pluginOptions', expected one of 'rules', 'include',
 * 'exclude', 'files', 'report', 'plugins'` — while an unknown top-level key is
 * accepted without complaint.
 *
 * ```jsonc
 * {
 *   "lint": { "plugins": ["jsr:@scope/my-plugin"] },
 *   "lintOptions": {
 *     "my-plugin/no-floating-promises": { "ignoreVoid": true }
 *   }
 * }
 * ```
 *
 * Keys are rule ids, matching how ESLint keys its own `rules` block, so two
 * plugins configured in the same project cannot collide.
 *
 * @module
 */

/** The top-level configuration key rule options are read from. */
const OPTIONS_KEY = "lintOptions";

/** Configuration file names, in the order Deno itself prefers them. */
const CONFIG_NAMES = ["deno.json", "deno.jsonc"];

let loaded: Record<string, unknown> | null = null;

/**
 * The configured options for one rule id, or undefined when it has none.
 *
 * The configuration file is read once per isolate. A missing file, unreadable
 * file, or malformed JSON leaves every rule on its defaults rather than failing
 * the lint — a configuration problem should surface as a rule that did not take
 * effect, not as a crashed plugin.
 */
export function configuredOptions(ruleId: string): unknown {
  loaded ??= readOptions();
  return loaded[ruleId];
}

/** Replaces the loaded configuration, for tests. */
export function setConfiguredOptions(
  options: Record<string, unknown> | null,
): void {
  loaded = options;
}

/** Reads the `lintOptions` block from the nearest configuration file. */
function readOptions(): Record<string, unknown> {
  const path = findConfig();
  if (path === null) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(Deno.readTextFileSync(path));
  } catch {
    return {};
  }
  if (!isRecord(parsed)) {
    return {};
  }
  const options = parsed[OPTIONS_KEY];
  return isRecord(options) ? options : {};
}

/** The nearest configuration file at or above the working directory. */
function findConfig(): string | null {
  let directory: string;
  try {
    directory = resolve(Deno.cwd());
  } catch {
    return null;
  }
  while (true) {
    for (const name of CONFIG_NAMES) {
      const path = join(directory, name);
      if (isFile(path)) {
        return path;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

/** Whether a path exists and is a file, false when it cannot be told. */
function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/** Whether a JSON value is an object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
