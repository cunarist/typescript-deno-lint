# typescript-deno-lint

A Deno lint framework giving rules type information and configuration, published
to jsr.io. `@cunarist/deno-lint-plugin-lit` is the first consumer.

---

## Working style

Keep responses short. State the decision and what changed. Detail belongs in
this file, not in chat.

## Project conventions

- `deno.json` is the only config. Strict TS.
- File names under `src/` are kebab-case.
- `deno fmt`, `deno check`, `deno lint`, and `deno test -A` must all pass.
- Annotate a plugin as `Deno.lint.Plugin` — JSR's slow-types check needs the
  explicit public type.
- Avoid `typeof` in type position. Write the type out by name.

### Two entry points, and why

`.` is rule authoring and builds nothing. `./types` builds the project's
TypeScript program under a top-level `await` at plugin load. They are separate
so a plugin with no type-aware rule pays nothing; merging them would put a
quarter second on every consumer.

### Layers

- `#program` — `createDenoProgram`, a `@deno/loader` host (import maps,
  workspaces, `npm:`/`jsr:`/`https:`, no `node_modules` needed) feeding
  `ts.createProgram`. Ported from `deno-lint-plugin-lit`'s scanner; keep them in
  sync when either changes.
- `#project` — the top-level `await` that builds it, plus the store that holds
  it and reparses one changed file.
- `#services` — the node map and `tryGetTypeServices`.
- `#options` — reads `lintOptions` out of the project's config file.
- `#rule` — `createRule`, `ruleCreator`, `definePlugin`.

`#services` imports `#project`, which is what makes importing `./types` build
the program. Nothing else may import `#project`.

### Verified environment facts

Checked empirically against Deno 2.9.3 — do not re-litigate:

- **`RuleContext` has no options channel.** It is
  `{ id, filename, sourceCode,
  report }` plus two deprecated getters, and
  `Plugin` is `{ name, rules }`. There is no `meta`, no schema, no severity, no
  presets.
- **Deno lint node ranges are UTF-16 code unit offsets**, the same units
  `ts.Node.getStart` counts in — not the UTF-8 byte offsets the underlying
  parser works in. A file of Korean text and emoji produces identical ranges
  from both trees, so mapping by offset needs no width conversion. This is the
  fact the whole node map rests on.
- **Deno's lint AST uses typescript-eslint's ESTree node names**, including the
  TypeScript ones: `TSTypeAnnotation`, `TSPropertySignature`,
  `TSAbstractMethodDefinition`, `TSEnumBody`. A rule ported from
  typescript-eslint visits the same node types.
- **`Deno.lint.Fixer` matches ESLint's method for method** — `insertTextAfter`,
  `insertTextBefore`, `remove`, `replaceText`, and the `…Range` variants. Fixes
  pass straight through.
- **`ReportData` has no `suggest` and no severity.** Both are unreachable, not
  merely unimplemented.
- **An unknown top-level key in `deno.json` is accepted; an unknown key inside
  `lint` is not** —
  `unknown field 'pluginOptions', expected one of 'rules',
  'include', 'exclude', 'files', 'report', 'plugins'`.
  That is why options live at the top level under `lintOptions`.
- **Deno catches whatever a visitor throws** and replaces it with
  `Visitor "x" of plugin "y" errored`, naming no cause. A rule authoring mistake
  must therefore surface as a diagnostic, not an exception — see
  `messageTemplate`.
- A lint plugin can read files: `Deno.readTextFileSync` works inside a real
  `deno lint` run with no permission flag.
- A lint plugin can import `npm:` packages, and JSR accepts npm dependencies.

### Node mapping

The two trees are lined up by source offset. Exact-range matches win; among
several nodes sharing a range the **deepest** is taken, because TypeScript wraps
where ESTree does not — a bare `foo()` statement is an expression statement
around a call, and a rule visiting `CallExpression` wants the call. Only the
node types that need the wrapper instead are listed in `KIND_PREFERENCE`. When
no range matches exactly, the deepest containing node is used.

`Program` is special-cased to the `SourceFile`: `SourceFile.getStart()` skips a
leading comment and the lint tree's `Program` does not.

### Testing

Unit tests use `Deno.lint.runPlugin`, which is only available under `deno test`.
Run them as `deno test -A` — the program build reads the module graph.

Type-aware tests lint a **real file inside this project** (`tests/fixtures/`),
so the program built at plugin load already contains it. That is the deployment
path; a synthetic snippet is not in any program and would silently exercise the
null branch.

Before release, also run real `deno lint` from a separate consumer project.
Because internal imports use `#` aliases, a consumer cannot point at `src/**` by
file path unless it copies those aliases into its own import map — which is what
the pre-publish check does. After publishing, consume it the way real users do.

## Deliberately excluded

- **`meta.schema` validation.** Deno validates nothing, and a JSON Schema
  validator costs more than it returns. The field is accepted and ignored.
- **Scope analysis** (`context.getScope`, `getDeclaredVariables`). The checker's
  `getSymbolAtLocation` answers what it was mostly used for, more accurately.
- **The token API** (`getFirstToken`, `getTokenAfter`). It serves formatting
  rules, which `deno fmt` already owns. `ts.createScanner` makes it buildable if
  demand ever appears.
- **A `setup(options)` factory**, the pattern `@hugoalh/deno-lint-rules` uses.
  It works, but it forces every user to write a wrapper file before they can
  configure anything. Reading `deno.json` keeps `deno.json` sufficient.
