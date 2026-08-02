import { assertEquals } from "@std/assert";

import { createRule, definePlugin, ruleCreator } from "#mod";
import { setConfiguredOptions } from "#options";

/** Runs a one-rule plugin over a snippet and returns what it reported. */
function messages(
  rule: Parameters<typeof definePlugin>[0]["rules"][number],
  source = "const x = 1;\n",
): string[] {
  const plugin = definePlugin({ name: "probe", rules: [rule] });
  return Deno.lint.runPlugin(plugin, "snippet.ts", source)
    .map((diagnostic) => diagnostic.message);
}

/** A rule that reports its options and interpolates them into its message. */
function reporter(defaults: readonly unknown[]) {
  return createRule({
    name: "report-options",
    meta: { messages: { seen: "options are {{options}}" } },
    defaultOptions: defaults,
    create(context) {
      return {
        Program(node) {
          context.report({
            node,
            messageId: "seen",
            data: { options: JSON.stringify(context.options) },
          });
        },
      };
    },
  });
}

Deno.test("a rule falls back to its defaults when nothing configures it", () => {
  setConfiguredOptions({});
  assertEquals(messages(reporter([{ ignoreVoid: false, depth: 1 }])), [
    'options are [{"ignoreVoid":false,"depth":1}]',
  ]);
});

Deno.test("configured options merge over the defaults key by key", () => {
  // Setting one option must not silently reset the others, which is the whole
  // reason the defaults are merged rather than replaced.
  setConfiguredOptions({ "probe/report-options": { ignoreVoid: true } });
  assertEquals(messages(reporter([{ ignoreVoid: false, depth: 1 }])), [
    'options are [{"ignoreVoid":true,"depth":1}]',
  ]);
});

Deno.test("a configured array replaces rather than merges", () => {
  setConfiguredOptions({ "probe/report-options": { tags: ["b"] } });
  assertEquals(messages(reporter([{ tags: ["a"] }])), [
    'options are [{"tags":["b"]}]',
  ]);
});

Deno.test("positional options are configured as an array", () => {
  setConfiguredOptions({ "probe/report-options": ["always", { depth: 2 }] });
  assertEquals(messages(reporter(["never", { depth: 1 }])), [
    'options are ["always",{"depth":2}]',
  ]);
});

Deno.test("a message id renders its template with the reported data", () => {
  setConfiguredOptions({});
  const rule = createRule({
    name: "named",
    meta: { messages: { named: "{{ what }} is not allowed here" } },
    defaultOptions: [],
    create(context) {
      return {
        Program(node) {
          context.report({ node, messageId: "named", data: { what: "await" } });
        },
      };
    },
  });
  assertEquals(messages(rule), ["await is not allowed here"]);
});

Deno.test("an undeclared message id names itself instead of rendering", () => {
  setConfiguredOptions({});
  const rule = createRule({
    name: "wrong",
    meta: { messages: { right: "fine" } },
    defaultOptions: [],
    create(context) {
      return {
        Program(node) {
          // The type parameter rejects this, which is the point; a plugin
          // compiled loosely still must not ship a message that reads as an id.
          context.report({ node, messageId: "typo" as "right" });
        },
      };
    },
  });
  assertEquals(messages(rule), [
    'Rule "wrong" reported unknown messageId "typo".',
  ]);
});

Deno.test("a fix passes through to Deno unchanged", () => {
  setConfiguredOptions({});
  const rule = createRule({
    name: "fixable",
    meta: { fixable: "code", messages: { swap: "use two" } },
    defaultOptions: [],
    create(context) {
      return {
        Literal(node) {
          context.report({
            node,
            messageId: "swap",
            fix: (fixer) => fixer.replaceText(node, "2"),
          });
        },
      };
    },
  });
  const plugin = definePlugin({ name: "probe", rules: [rule] });
  const [diagnostic] = Deno.lint.runPlugin(
    plugin,
    "snippet.ts",
    "const x = 1;",
  );
  assertEquals(diagnostic?.fix, [{ range: [10, 11], text: "2" }]);
});

Deno.test("a rule creator fills in the documentation url", () => {
  const create = ruleCreator((name) => `https://example.com/${name}.md`);
  const rule = create({
    name: "documented",
    meta: { docs: { description: "d" }, messages: { m: "m" } },
    defaultOptions: [],
    create: () => ({}),
  });
  assertEquals(rule.meta.docs?.url, "https://example.com/documented.md");
});
