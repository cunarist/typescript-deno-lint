import { assertEquals, assertNotEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

import { createRule, definePlugin } from "../src/mod.ts";
import { tryGetTypeServices } from "../src/types.ts";

const FIXTURE = fromFileUrl(import.meta.resolve("./fixtures/typed.ts"));
const SOURCE = Deno.readTextFileSync(FIXTURE);

/**
 * The fixture is a real file inside this project, so the program built at plugin
 * load contains it. That is the deployment path: a rule only ever sees files the
 * project's own program already holds.
 */
function collect(
  visit: (
    node: Deno.lint.Node,
    services: ReturnType<typeof tryGetTypeServices>,
    report: (message: string) => void,
  ) => void,
  nodeType: string,
): string[] {
  const found: string[] = [];
  const rule = createRule({
    name: "probe",
    meta: { messages: { found: "{{what}}" } },
    defaultOptions: [],
    create(context) {
      const services = tryGetTypeServices(context);
      const visitor: Record<string, (node: Deno.lint.Node) => void> = {
        [nodeType]: (node) => {
          visit(node, services, (message) => {
            found.push(message);
            context.report({
              node,
              messageId: "found",
              data: { what: message },
            });
          });
        },
      };
      return visitor as Deno.lint.LintVisitor;
    },
  });
  Deno.lint.runPlugin(
    definePlugin({ name: "probe", rules: [rule] }),
    FIXTURE,
    SOURCE,
  );
  return found;
}

Deno.test("the program built at plugin load reaches a rule", () => {
  const seen = collect((_node, services, report) => {
    report(services === null ? "missing" : "present");
  }, "Program");
  assertEquals(seen, ["present"]);
});

Deno.test("a lint node maps onto the TypeScript node covering it", () => {
  const kinds = collect((node, services, report) => {
    const found = services?.getTSNode(node);
    if (found !== undefined) {
      report(
        `${node.type}:${
          services?.sourceFile.text.slice(
            found.getStart(services.sourceFile),
            found.getEnd(),
          )
        }`,
      );
    }
  }, "CallExpression");
  assertEquals(kinds, [
    'CallExpression:Promise.resolve("name")',
    "CallExpression:fetchName()",
    "CallExpression:Math.max(length, count ?? 0)",
  ]);
});

Deno.test("the checker answers for a mapped node", () => {
  const types = collect((node, services, report) => {
    const type = services?.getTypeAtLocation(node);
    if (type !== undefined && services !== null) {
      report(services.checker.typeToString(type));
    }
  }, "CallExpression");
  assertEquals(types[1], "Promise<string>");
});

Deno.test("offsets line up through non-ASCII source", () => {
  // The identifier `이름` sits after an emoji, so a byte-counted offset would
  // land in the wrong place and the checker would answer about another node.
  const types = collect((node, services, report) => {
    if ("name" in node && node.name === "이름") {
      const type = services?.getTypeAtLocation(node);
      if (type !== undefined && services !== null) {
        report(services.checker.typeToString(type));
      }
    }
  }, "Identifier");
  assertNotEquals(types.length, 0);
  for (const type of types) {
    assertEquals(type, '"한글🎉"');
  }
});
