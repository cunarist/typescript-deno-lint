import ts from "typescript";

/**
 * Maps a Deno lint AST node onto the TypeScript node covering the same source.
 *
 * typescript-eslint gets this for free: its parser produces both trees, so it
 * records the correspondence as it converts. Deno parses on its own and hands
 * out no such map, so the two trees have to be lined up afterwards — by source
 * offset, which is the one thing they agree on exactly.
 *
 * Verified on Deno 2.9.3: Deno lint node ranges are UTF-16 code unit offsets,
 * the same units `ts.Node.getStart` counts in, not the UTF-8 byte offsets the
 * underlying parser works in. A file of Korean text and emoji produces identical
 * ranges from both trees, so no width conversion is needed.
 *
 * @module
 */

/** A lookup from source range to TypeScript node, built once per source file. */
export interface NodeMap {
  /** The TypeScript node for a Deno lint node, or undefined when unmatched. */
  find(node: Deno.lint.Node): ts.Node | undefined;
}

/** Node maps kept per source file object, discarded when the file is reparsed. */
const maps = new WeakMap<ts.SourceFile, NodeMap>();

/** The node map for a source file, built on first use. */
export function nodeMap(source: ts.SourceFile): NodeMap {
  const existing = maps.get(source);
  if (existing !== undefined) {
    return existing;
  }
  const built = buildMap(source);
  maps.set(source, built);
  return built;
}

/** Indexes every node in a file by the range it starts at. */
function buildMap(source: ts.SourceFile): NodeMap {
  // Nodes are appended in pre-order, so a bucket runs outermost to innermost and
  // the last entry matching a range is the deepest node covering it.
  const byStart = new Map<number, ts.Node[]>();
  const visit = (node: ts.Node): void => {
    const start = node.getStart(source);
    const bucket = byStart.get(start);
    if (bucket === undefined) {
      byStart.set(start, [node]);
    } else {
      bucket.push(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  return {
    find(node: Deno.lint.Node): ts.Node | undefined {
      // The file itself is never reached by the walk above, and its start skips
      // any leading comment while the lint tree's `Program` does not.
      if (node.type === "Program") {
        return source;
      }
      const [start, end] = node.range;
      const exact = (byStart.get(start) ?? []).filter((candidate) =>
        candidate.getEnd() === end
      );
      if (exact.length > 0) {
        return preferred(node.type, exact);
      }
      return innermostContaining(source, start, end);
    },
  };
}

/**
 * Picks which of several equally-ranged nodes a lint node means.
 *
 * TypeScript wraps where the lint tree does not: `Foo` as a type is both a type
 * reference and the identifier naming it, over the very same characters. The
 * deepest node is right far more often than not — a bare `foo()` statement is an
 * expression statement wrapping a call, and a rule visiting `CallExpression`
 * wants the call — so that is the default, and only the node types that need the
 * wrapper are listed.
 */
function preferred(type: string, candidates: ts.Node[]): ts.Node {
  const wanted = KIND_PREFERENCE[type];
  if (wanted !== undefined) {
    const matched = candidates.find((candidate) => wanted(candidate));
    if (matched !== undefined) {
      return matched;
    }
  }
  return candidates[candidates.length - 1] as ts.Node;
}

/** Lint node types whose TypeScript counterpart is not the deepest match. */
const KIND_PREFERENCE: Record<string, (node: ts.Node) => boolean> = {
  TSTypeReference: ts.isTypeReferenceNode,
  TSTypeQuery: ts.isTypeQueryNode,
  TSImportType: ts.isImportTypeNode,
  TSQualifiedName: ts.isQualifiedName,
  TSInterfaceDeclaration: ts.isInterfaceDeclaration,
  TSTypeAliasDeclaration: ts.isTypeAliasDeclaration,
  TSEnumDeclaration: ts.isEnumDeclaration,
  TSModuleDeclaration: ts.isModuleDeclaration,
  TSTypeAnnotation: (node) => !ts.isIdentifier(node),
  ExpressionStatement: ts.isExpressionStatement,
  VariableDeclaration: ts.isVariableStatement,
  ClassDeclaration: ts.isClassDeclaration,
  FunctionDeclaration: ts.isFunctionDeclaration,
  ImportDeclaration: ts.isImportDeclaration,
  ExportNamedDeclaration: ts.isExportDeclaration,
  ExportDefaultDeclaration: ts.isExportAssignment,
};

/** The deepest node whose span contains the range, when none matches exactly. */
function innermostContaining(
  source: ts.SourceFile,
  start: number,
  end: number,
): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (node.getStart(source) > start || node.getEnd() < end) {
      return;
    }
    found = node;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}
