import { assertEquals } from "@std/assert";
import ts from "typescript";

import { createRule, definePlugin } from "#mod";
import { clearTestProgram, useTestProgram } from "#testing";
import { tryGetTypeServices } from "#types";

/**
 * A rule test lints a snippet that belongs to no project. The program installed
 * here stands in for one, built from text that deliberately differs from the
 * snippet — the imports the snippet omits are appended, so its own offsets are
 * untouched.
 */
const SNIPPET = "const value = describe();\n";
const IMPORTS = "declare function describe(): 42;\n";

/** Builds a program over the snippet plus the declarations it leaves out. */
function programFor(filename: string): ts.Program {
  const source = ts.createSourceFile(
    filename,
    `${SNIPPET}${IMPORTS}`,
    ts.ScriptTarget.ESNext,
    true,
  );
  const host = ts.createCompilerHost({}, true);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, onError, shouldCreate) =>
    name === filename ? source : read(name, version, onError, shouldCreate);
  return ts.createProgram([filename], { noEmit: true }, host);
}

/** The types a rule sees for every call expression in the snippet. */
function typesInSnippet(filename: string): string[] {
  const seen: string[] = [];
  const rule = createRule({
    name: "probe",
    meta: { messages: { seen: "{{type}}" } },
    defaultOptions: [],
    create(context) {
      const services = tryGetTypeServices(context);
      return {
        CallExpression(node) {
          const type = services?.getTypeAtLocation(node);
          if (type !== undefined && services !== null) {
            seen.push(services.checker.typeToString(type));
          }
        },
      };
    },
  });
  Deno.lint.runPlugin(
    definePlugin({ name: "probe", rules: [rule] }),
    filename,
    SNIPPET,
  );
  return seen;
}

Deno.test("an installed program answers for a snippet outside any project", () => {
  const filename = "snippet.ts";
  useTestProgram(programFor(filename));
  try {
    assertEquals(typesInSnippet(filename), ["42"]);
  } finally {
    clearTestProgram();
  }
});

Deno.test("clearing the program leaves a type-aware rule silent", () => {
  useTestProgram(programFor("snippet.ts"));
  clearTestProgram();
  assertEquals(typesInSnippet("snippet.ts"), []);
});
