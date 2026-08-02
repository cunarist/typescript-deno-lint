import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import ts from "typescript";

import { createDenoProgram } from "#program";

/**
 * An editor lints a buffer that no longer matches the file on disk. Every
 * position the checker reports is an offset into the text it parsed, so a
 * program holding the old text does not merely answer stale — it answers about
 * the wrong characters.
 */

const SOURCE = `export class Panel {
  readonly label = "panel";
}
`;

/** A one-file project the loader can resolve. */
async function project(): Promise<{ root: string; file: string }> {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(join(root, "deno.json"), `{ "imports": {} }`);
  const file = join(root, "panel.ts");
  await Deno.writeTextFile(file, SOURCE);
  return { root, file };
}

/** The offset a class name starts at, in the program's copy of a file. */
function classNameOffset(program: ts.Program, file: string): number | null {
  const source = program.getSourceFile(file);
  if (source === undefined) return null;
  let offset: number | null = null;
  ts.forEachChild(source, (node) => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      offset = node.name.getStart(source);
    }
  });
  return offset;
}

Deno.test("rebuild: follows an offset shifted by an edit", async () => {
  const { root, file } = await project();
  try {
    const built = await createDenoProgram([file], join(root, "deno.json"));
    const before = classNameOffset(built.program, file);
    assertNotEquals(before, null);

    // Anything inserted above the class moves it, and a rule asking about a node
    // at the new offset must reach the same declaration.
    const prefix = "// a comment added since the build\n";
    const program = built.rebuild(file, `${prefix}${SOURCE}`);
    if (program === null) throw new Error("the rebuild was refused");
    assertEquals(
      classNameOffset(program, file),
      (before ?? 0) + prefix.length,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rebuild: reuses every file the edit did not touch", async () => {
  const { root, file } = await project();
  try {
    const built = await createDenoProgram([file], join(root, "deno.json"));
    const lib = built.program.getSourceFiles()
      .find((source) => source.fileName.includes("lib."));
    const program = built.rebuild(file, `// edited\n${SOURCE}`);
    if (program === null) throw new Error("the rebuild was refused");
    // The same object, not an equal one: that identity is what lets TypeScript
    // skip reparsing, and is the whole reason a rebuild is cheap.
    assertEquals(program.getSourceFile(lib?.fileName ?? "") === lib, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rebuild: refuses a file the program never had", async () => {
  const { root, file } = await project();
  try {
    const built = await createDenoProgram([file], join(root, "deno.json"));
    assertEquals(built.rebuild(join(root, "absent.ts"), "export {};"), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
