import type ts from "typescript";

import { currentProject, currentSourceFile } from "#project";

import { nodeMap } from "./node-map.ts";

/**
 * Type information for the file being linted.
 *
 * This is the counterpart of typescript-eslint's `ESLintUtils.getParserServices`
 * — the seam where a rule stops looking at syntax and starts asking the compiler
 * what something means.
 *
 * @module
 */

/** The compiler's view of the file a rule is currently visiting. */
export interface TypeServices {
  /** The whole program, resolved the way Deno resolves modules. */
  readonly program: ts.Program;
  /** The checker for that program. */
  readonly checker: ts.TypeChecker;
  /** The parsed file the rule is visiting. */
  readonly sourceFile: ts.SourceFile;
  /** The TypeScript node a lint node covers, or undefined when unmatched. */
  getTSNode(node: Deno.lint.Node): ts.Node | undefined;
  /** The type of a lint node, or undefined when it maps to nothing. */
  getTypeAtLocation(node: Deno.lint.Node): ts.Type | undefined;
  /** The symbol a lint node resolves to, or undefined when it has none. */
  getSymbolAtLocation(node: Deno.lint.Node): ts.Symbol | undefined;
}

/** What a rule needs to locate its file; a full `RuleContext` satisfies it. */
export interface ServiceSource {
  readonly filename: string;
  readonly sourceCode: { readonly text: string };
}

/**
 * Type services for the file being linted, or null when unavailable.
 *
 * Null means the program was never built or does not contain this file — a
 * project the Deno loader could not resolve, or a file outside it. A rule that
 * needs types should go silent rather than guess; a wrong diagnostic costs more
 * than a missing one.
 */
export function tryGetTypeServices(
  context: ServiceSource,
): TypeServices | null {
  const source = currentSourceFile(context.filename, context.sourceCode.text);
  const project = currentProject();
  if (source === null || project === null) {
    return null;
  }
  // Read the program after the source, since resolving the source may have
  // rebuilt it, and the checker has to be the one that knows this parse.
  const program = project.program;
  const checker = program.getTypeChecker();
  const map = nodeMap(source);
  return {
    program,
    checker,
    sourceFile: source,
    getTSNode(node) {
      return map.find(node);
    },
    getTypeAtLocation(node) {
      const found = map.find(node);
      return found === undefined ? undefined : checker.getTypeAtLocation(found);
    },
    getSymbolAtLocation(node) {
      const found = map.find(node);
      return found === undefined
        ? undefined
        : checker.getSymbolAtLocation(found);
    },
  };
}

/**
 * Type services for the file being linted, throwing when unavailable.
 *
 * Prefer `tryGetTypeServices` in a rule that ships. This exists for the case
 * where a missing program is a bug worth surfacing rather than a project the
 * loader could not read.
 */
export function getTypeServices(context: ServiceSource): TypeServices {
  const services = tryGetTypeServices(context);
  if (services === null) {
    throw new Error(
      `No type information for ${context.filename}. The program is built at ` +
        `plugin load by importing "@cunarist/typescript-deno-lint/types"; a ` +
        `file outside the project has none.`,
    );
  }
  return services;
}

export { nodeMap } from "./node-map.ts";
export type { NodeMap } from "./node-map.ts";
