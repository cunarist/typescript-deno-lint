# typescript-deno-lint

Type-aware Deno lint rules, authored the way typescript-eslint rules are.

`deno lint` hands a rule one parsed file and nothing else — no types, no
cross-file resolution, no configuration. This package supplies the rest: a
TypeScript program resolved the way Deno resolves modules, a map from lint nodes
onto it, named messages, and per-rule options read from `deno.json`.

```ts
import { createRule, definePlugin } from "jsr:@cunarist/typescript-deno-lint";
import { tryGetTypeServices } from "jsr:@cunarist/typescript-deno-lint/types";

const noFloatingPromises = createRule({
  name: "no-floating-promises",
  meta: { messages: { floating: "This {{what}} is not awaited." } },
  defaultOptions: [{ ignoreVoid: false }],
  create(context) {
    const [{ ignoreVoid }] = context.options;
    const services = tryGetTypeServices(context);
    if (services === null) return {};
    return {
      ExpressionStatement(node) {
        let expression = node.expression;
        if (
          expression.type === "UnaryExpression" &&
          expression.operator === "void"
        ) {
          if (ignoreVoid) return;
          expression = expression.argument;
        }
        const type = services.getTypeAtLocation(expression);
        if (type?.getSymbol()?.getName() !== "Promise") return;
        context.report({
          node: expression,
          messageId: "floating",
          data: { what: services.checker.typeToString(type) },
        });
      },
    };
  },
});

export default definePlugin({ name: "demo", rules: [noFloatingPromises] });
```

Users add the plugin to `deno.json` and nothing else. They never write a wrapper
file.

```jsonc
{
  "lint": { "plugins": ["jsr:@scope/my-plugin"] },
  "lintOptions": {
    "demo/no-floating-promises": { "ignoreVoid": true }
  }
}
```

## Two entry points

| Entry     | What it gives                                      | Cost                    |
| --------- | -------------------------------------------------- | ----------------------- |
| `.`       | `createRule`, `definePlugin`, `ruleCreator`        | none                    |
| `./types` | `getTypeServices`, `tryGetTypeServices`, `nodeMap` | builds the program once |

Importing `./types` builds the project's TypeScript program at plugin load,
roughly a quarter second for a mid-sized project. A plugin with no type-aware
rule should never import it.

## Type services

`tryGetTypeServices(context)` is this package's `getParserServices`. It returns
`null` when the program does not have the file — a project the Deno loader could
not resolve, or a file outside it — so a rule goes silent rather than guesses.

```ts
const services = tryGetTypeServices(context);
services.getTSNode(node); //         ts.Node covering the lint node
services.getTypeAtLocation(node); //  its type
services.getSymbolAtLocation(node); // what it resolves to
services.checker; //                  the whole checker, for anything else
services.program;
services.sourceFile;
```

## Options

Deno's plugin API has no channel for configuration, so options are read from a
top-level `lintOptions` key in the project's `deno.json`, keyed by rule id.
Objects merge over `defaultOptions` key by key, so setting one option does not
reset the others. A configured array replaces.

```jsonc
// positional options, for the rare rule that takes more than one
"lintOptions": { "demo/naming": ["always", { "depth": 2 }] }
```

## What is not reproduced

Three things ESLint has that `Deno.lint.ReportData` gives no room for:

- **`suggest`** — several candidate fixes offered to the user. A single `fix`
  works and passes straight through.
- **Per-rule severity.** Every plugin diagnostic is an error.
- **`meta.schema` validation.** The field is accepted and ignored; nothing
  validates a user's options, so a typo in `deno.json` leaves the rule on its
  default.

Scope analysis (`context.getScope()`) and the token API (`getFirstToken`,
`getTokenAfter`) are absent too, for different reasons. The checker's
`getSymbolAtLocation` answers what scope analysis was mostly used for, and
tokens matter almost only to formatting rules, which `deno fmt` already owns.

## Why the program is built at load

Resolving modules the way Deno does is asynchronous and a lint rule is not, so
there is no moment inside a rule when a program could be built. `deno lint`
awaits a plugin's top-level `await` before running any rule, which is the one
window available. The program stays in a module variable for the isolate's life;
nothing is written into the project being linted.

An editor lints a buffer that no longer matches the file on disk. When the text
differs, that one file is reparsed and the program rebuilt against the old one —
every unchanged file is handed back to TypeScript as the identical object, so
only the edited file is parsed.

## Requirements

Deno 2.9 or newer, and a project with a `deno.json` or `deno.jsonc`.
