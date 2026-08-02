import { configuredOptions } from "#options";

/**
 * Rule authoring shaped like typescript-eslint's.
 *
 * Deno gives a rule a bare `create(context)` and a context with no options and
 * no message table. What is added here is what an ESLint rule takes for granted:
 * named messages with interpolated data, and options read from the project's
 * configuration and merged over the rule's defaults.
 *
 * Deliberately not reproduced, because `Deno.lint.ReportData` has no field for
 * them: `suggest` (several candidate fixes offered to the user) and per-rule
 * severity. Every plugin diagnostic is an error. `meta.schema` is accepted and
 * ignored — Deno validates nothing, and pulling in a JSON Schema validator to do
 * it costs more than it returns.
 *
 * @module
 */

/** Values interpolated into a message's `{{placeholder}}` slots. */
export type MessageData = Readonly<Record<string, string | number>>;

/** Where a diagnostic points and what it says. */
export type ReportDescriptor<MessageIds extends string> =
  & ({ readonly node: Deno.lint.Node } | { readonly range: Deno.lint.Range })
  & (
    | { readonly messageId: MessageIds; readonly data?: MessageData }
    | { readonly message: string }
  )
  & {
    readonly hint?: string;
    readonly fix?: (
      fixer: Deno.lint.Fixer,
    ) => Deno.lint.Fix | Iterable<Deno.lint.Fix>;
  };

/** What a rule is handed while it visits a file. */
export interface RuleContext<
  Options extends readonly unknown[],
  MessageIds extends string,
> {
  /** The running rule id: `<plugin-name>/<rule-name>`. */
  readonly id: string;
  /** Name of the file being linted. */
  readonly filename: string;
  /** Helpers for working with the raw source. */
  readonly sourceCode: Deno.lint.SourceCode;
  /** Configured options, merged over the rule's defaults. */
  readonly options: Options;
  /** Reports a diagnostic. */
  report(descriptor: ReportDescriptor<MessageIds>): void;
}

/** Everything about a rule that is not its behaviour. */
export interface RuleMeta<MessageIds extends string> {
  readonly docs?: {
    readonly description: string;
    readonly url?: string;
  };
  /** Message templates, keyed by the id a report refers to them by. */
  readonly messages: Readonly<Record<MessageIds, string>>;
  /** Accepted for parity with ESLint; Deno applies fixes regardless. */
  readonly fixable?: "code" | "whitespace";
  readonly type?: "problem" | "suggestion" | "layout";
  /** Accepted and ignored — nothing validates it. */
  readonly schema?: unknown;
}

/** A rule definition, before it is bound to a plugin. */
export interface RuleDefinition<
  Options extends readonly unknown[],
  MessageIds extends string,
> {
  /** The rule's name, which becomes the second half of its id. */
  readonly name: string;
  readonly meta: RuleMeta<MessageIds>;
  /** Options used where the project configures none. */
  readonly defaultOptions: Options;
  create(context: RuleContext<Options, MessageIds>): Deno.lint.LintVisitor;
}

/** A rule with its type parameters erased, as a plugin holds it. */
// deno-lint-ignore no-explicit-any
export type AnyRule = RuleDefinition<any, any>;

/**
 * Declares a rule.
 *
 * A pass-through that exists for inference: it pins `MessageIds` to the keys of
 * `meta.messages`, so reporting an id the rule never declared is a type error
 * rather than a message that renders as its own id.
 */
export function createRule<
  const Options extends readonly unknown[],
  MessageIds extends string,
>(
  definition: RuleDefinition<Options, MessageIds>,
): RuleDefinition<Options, MessageIds> {
  return definition;
}

/**
 * Builds a `createRule` that fills in each rule's documentation URL.
 *
 * The counterpart of typescript-eslint's `ESLintUtils.RuleCreator`.
 */
export function ruleCreator(
  urlOf: (name: string) => string,
): typeof createRule {
  return (definition) => {
    const { docs } = definition.meta;
    if (docs === undefined) {
      return definition;
    }
    return {
      ...definition,
      meta: {
        ...definition.meta,
        docs: { ...docs, url: docs.url ?? urlOf(definition.name) },
      },
    };
  };
}

/** A plugin's name and the rules it carries. */
export interface PluginDefinition {
  readonly name: string;
  readonly rules: readonly AnyRule[];
}

/**
 * Assembles rules into the plugin `deno.json` loads.
 *
 * Options are resolved once per rule, at load, rather than per file: the
 * configuration cannot change during a lint run, and a rule that reads it on
 * every visit would read it thousands of times.
 */
export function definePlugin(definition: PluginDefinition): Deno.lint.Plugin {
  const rules: Record<string, Deno.lint.Rule> = {};
  for (const rule of definition.rules) {
    const id = `${definition.name}/${rule.name}`;
    const options = resolveOptions(rule.defaultOptions, configuredOptions(id));
    rules[rule.name] = {
      create(context) {
        return rule.create({
          id: context.id,
          filename: context.filename,
          sourceCode: context.sourceCode,
          options,
          report: (descriptor) => {
            context.report(toReportData(rule, descriptor));
          },
        });
      },
    };
  }
  return { name: definition.name, rules };
}

/** Turns a described report into the shape Deno's `report` accepts. */
function toReportData(
  rule: AnyRule,
  descriptor: ReportDescriptor<string>,
): Deno.lint.ReportData {
  const message = "message" in descriptor ? descriptor.message : interpolate(
    messageTemplate(rule, descriptor.messageId),
    descriptor.data,
  );
  const where = "node" in descriptor
    ? { node: descriptor.node }
    : { range: descriptor.range };
  return {
    ...where,
    message,
    ...(descriptor.hint === undefined ? {} : { hint: descriptor.hint }),
    ...(descriptor.fix === undefined ? {} : { fix: descriptor.fix }),
  };
}

/**
 * The template for a message id, or a loud stand-in when the rule declared
 * none.
 *
 * Throwing would be the ESLint answer, but Deno catches whatever a visitor
 * throws and replaces it with `Visitor "x" of plugin "y" errored`, which names
 * no cause. The typed `messageId` already rejects this at compile time; a plugin
 * that got past that reports a diagnostic saying exactly what is wrong, at the
 * place it went wrong, rather than a message that quietly reads as its own id.
 */
function messageTemplate(rule: AnyRule, messageId: string): string {
  const template = rule.meta.messages[messageId];
  if (typeof template !== "string") {
    return `Rule "${rule.name}" reported unknown messageId "${messageId}".`;
  }
  return template;
}

/** Fills a message's `{{placeholder}}` slots, leaving unmatched ones alone. */
function interpolate(template: string, data: MessageData | undefined): string {
  if (data === undefined) {
    return template;
  }
  return template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (whole, key: string) => {
    const value = data[key];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Merges configured options over a rule's defaults.
 *
 * ESLint options are positional, but a rule with more than one is rare, so a
 * lone object in the configuration is taken as the first position. Objects merge
 * key by key so that setting one option does not silently reset the others;
 * arrays and primitives replace, since a configured list means that list.
 */
function resolveOptions(
  defaults: readonly unknown[],
  configured: unknown,
): readonly unknown[] {
  if (configured === undefined) {
    return defaults;
  }
  const provided = Array.isArray(configured) ? configured : [configured];
  return defaults.map((fallback, index) =>
    index < provided.length ? merge(fallback, provided[index]) : fallback
  ).concat(provided.slice(defaults.length));
}

/** Overlays a configured value on a default, one key deep for records. */
function merge(fallback: unknown, provided: unknown): unknown {
  if (!isRecord(fallback) || !isRecord(provided)) {
    return provided;
  }
  const merged: Record<string, unknown> = { ...fallback };
  for (const [key, value] of Object.entries(provided)) {
    merged[key] = merge(fallback[key], value);
  }
  return merged;
}

/** Whether a value is a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
