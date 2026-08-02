import { exists, expandGlob } from "@std/fs";
import { join } from "@std/path";

import { setProject } from "./store.ts";

/**
 * Builds the project's TypeScript program once, at plugin load, off no separate
 * command.
 *
 * Importing this module for its side effect is what makes a plugin type-aware.
 * `deno lint` awaits a plugin's top-level `await` before running any rule, so
 * the program is built while the plugin loads and every rule afterwards finds it
 * ready.
 *
 * The cost lands on whoever imports it: roughly a quarter second for a
 * mid-sized project, paid once per lint run. A plugin with no type-aware rule
 * should import `@cunarist/typescript-deno-lint` alone and never reach for
 * `/types`, which is why the two are separate entry points.
 *
 * Any failure is swallowed. A project the loader cannot resolve leaves the
 * type-aware rules silent rather than failing the whole lint.
 *
 * @module
 */

export * from "./store.ts";

/** Source kinds Deno lint can hand to a plugin. */
const SOURCE_PATTERN = "*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

await build().catch(() => {});

/** Builds the program for the project in the working directory. */
async function build(): Promise<void> {
  const { createDenoProgram } = await import("#program");
  const root = Deno.cwd();
  const json = join(root, "deno.json");
  const config = await exists(json, { isFile: true })
    ? json
    : join(root, "deno.jsonc");
  const files: string[] = [];
  for await (
    const entry of expandGlob(join(root, "**", SOURCE_PATTERN), {
      exclude: ["**/node_modules/**"],
    })
  ) {
    if (entry.isFile) {
      files.push(entry.path);
    }
  }
  const built = await createDenoProgram(files, config);
  setProject({
    get program() {
      return built.program;
    },
    rebuild: (path, text) => built.rebuild(path, text),
  });
}
