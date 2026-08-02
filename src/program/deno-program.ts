import { type Loader, ResolutionMode, Workspace } from "@deno/loader";
import {
  dirname,
  fromFileUrl,
  join,
  relative,
  resolve as resolvePath,
} from "@std/path";
import ts from "typescript";

/**
 * A TypeScript program that resolves modules the way Deno does.
 *
 * A plain `ts.createProgram` knows nothing about Deno's import map, workspaces,
 * or remote modules, so an aliased or `https:` import resolves to nothing.
 * `@deno/loader` is Deno's own resolver: given a project's config it resolves
 * any specifier — alias, workspace member, `npm:` subpath, remote — against the
 * importing file, which a global `paths` map cannot express. A compiler host
 * hands each of those resolutions to TypeScript.
 *
 * A `node_modules` file is left to TypeScript's node resolution, which reads its
 * types out of the package; only a project or remote file, whose source the
 * loader resolved to a path, is answered here.
 */

/** Compiler options the analyzer runs every project under. */
const OPTIONS: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ESNext,
  lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  allowJs: true,
  checkJs: false,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
};

/** A program kept alive so one changed file can be rebuilt against it. */
export interface DenoProgram {
  /** The program as it stands, from the scan or the last rebuild. */
  readonly program: ts.Program;
  /**
   * Rebuilds with one file's text replaced, or null when it cannot.
   *
   * Every unchanged file is handed back to TypeScript as the same `SourceFile`
   * object, which is what lets it reuse the old program instead of parsing the
   * project again; only the replaced file is parsed. A specifier the loader
   * never warmed — an import added since the scan — resolves to nothing, since
   * warming it would need an await; the rest of the file's facts are still
   * right. Null means the program never had the file at all.
   */
  rebuild(path: string, text: string): ts.Program | null;
}

/** Builds a program over the given files, resolving modules through Deno. */
export async function createDenoProgram(
  files: string[],
  configPath: string,
): Promise<DenoProgram> {
  // The loader and its native resources are held for the isolate's life rather
  // than released here, because a rebuild resolves through the same loader.
  const workspace = new Workspace({ configPath: resolvePath(configPath) });
  const loader = await workspace.createLoader();
  // Entrypoints let the loader build its npm and jsr graph up front, so the
  // per-import `resolveSync` the host calls needs no further await.
  await loader.addEntrypoints(files.map(fileUrl));
  const sources = new Map<string, ts.SourceFile>();
  const host = denoHost(loader, sources);
  let program = ts.createProgram(files, OPTIONS, host);
  return {
    get program(): ts.Program {
      return program;
    },
    rebuild(path: string, text: string): ts.Program | null {
      const previous = program.getSourceFile(path);
      if (previous === undefined) {
        return null;
      }
      const replaced = ts.createSourceFile(
        previous.fileName,
        text,
        ts.ScriptTarget.ESNext,
        true,
      );
      const restore = sources.get(sourceKey(previous.fileName));
      sources.set(sourceKey(previous.fileName), replaced);
      try {
        program = ts.createProgram(files, OPTIONS, host, program);
        return program;
      } catch {
        if (restore !== undefined) {
          sources.set(sourceKey(previous.fileName), restore);
        }
        return null;
      }
    },
  };
}

/** The key a source file is cached under, matching how the host is called. */
function sourceKey(fileName: string): string {
  const path = fileName.replaceAll("\\", "/");
  return ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase();
}

/** A compiler host that answers module resolution through the loader first. */
function denoHost(
  loader: Loader,
  sources: Map<string, ts.SourceFile>,
): ts.CompilerHost {
  const host = ts.createCompilerHost(OPTIONS, true);
  // A rebuild reuses the old program only for files it is handed back as the
  // very same object, so every parse is cached rather than repeated.
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const key = sourceKey(fileName);
    const cached = sources.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const source = readSource(fileName, languageVersion, onError, shouldCreate);
    if (source !== undefined) {
      sources.set(key, source);
    }
    return source;
  };
  host.resolveModuleNameLiterals = (
    literals,
    containingFile,
    redirectedReference,
    options,
  ) => {
    const referrer = fileUrl(containingFile);
    return literals.map((literal) => {
      const target = resolveThroughDeno(loader, literal.text, referrer);
      if (target !== null) {
        return {
          resolvedModule: {
            resolvedFileName: target,
            extension: extensionOf(target),
          },
        };
      }
      return ts.resolveModuleName(
        literal.text,
        containingFile,
        options,
        host,
        undefined,
        redirectedReference,
      );
    });
  };
  return host;
}

/** The file the loader resolves a specifier to, preferring its declarations. */
function resolveThroughDeno(
  loader: Loader,
  specifier: string,
  referrer: string,
): string | null {
  let resolved: string;
  try {
    resolved = loader.resolveSync(specifier, referrer, ResolutionMode.Import);
  } catch {
    return null;
  }
  if (!resolved.startsWith("file:")) {
    return null;
  }
  const path = normalize(fromFileUrl(resolved));
  // Inside `node_modules`, node resolution reads the package's `package.json`
  // to find types wherever they live, which is more thorough than the sibling
  // guess below, so that case is handed back to it.
  if (path.includes("/node_modules/")) {
    return null;
  }
  return declarationOf(path);
}

// Without a `node_modules` tree, node resolution has nowhere to read a package's
// types from, so its declaration file — which the flat cache keeps beside the
// compiled file — is handed to TypeScript directly. A `.ts` source is its own
// types.
/** The declaration file beside a compiled file, or the file itself. */
function declarationOf(path: string): string {
  const compiled = path.match(/\.[mc]?js$/);
  if (compiled === null) {
    return path;
  }
  const sibling = `${path.slice(0, compiled.index)}.d${
    path.slice(compiled.index).replace("js", "ts")
  }`;
  if (ts.sys.fileExists(sibling)) {
    return sibling;
  }
  return packageDeclaration(path) ?? path;
}

/** A package-exported declaration corresponding to a resolved JS file. */
function packageDeclaration(path: string): string | null {
  let directory = dirname(path);
  while (true) {
    const manifestPath = join(directory, "package.json");
    if (ts.sys.fileExists(manifestPath)) {
      return declarationFromManifest(directory, path, manifestPath);
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

/** Reads a package's `types` export for one of its runtime targets. */
function declarationFromManifest(
  root: string,
  runtimePath: string,
  manifestPath: string,
): string | null {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(Deno.readTextFileSync(manifestPath));
  } catch {
    return null;
  }
  const runtimeTarget = `./${
    relative(root, runtimePath).replaceAll("\\", "/")
  }`;
  const exported = exportedDeclaration(manifest.exports, runtimeTarget);
  if (exported !== null) {
    return existingTarget(root, exported);
  }
  const entry = stringValue(manifest.module) ?? stringValue(manifest.main);
  const types = stringValue(manifest.types) ?? stringValue(manifest.typings);
  return entry === runtimeTarget.replace(/^\.\//, "") && types !== null
    ? existingTarget(root, types)
    : null;
}

/** Finds the `types` condition beside the branch selecting `runtimeTarget`. */
function exportedDeclaration(
  exportsValue: unknown,
  runtimeTarget: string,
): string | null {
  if (!isRecord(exportsValue)) {
    return null;
  }
  const keys = Object.keys(exportsValue);
  const branches = keys.some((key) => key.startsWith("."))
    ? Object.values(exportsValue)
    : [exportsValue];
  for (const branch of branches) {
    if (!containsTarget(branch, runtimeTarget) || !isRecord(branch)) {
      continue;
    }
    const types = firstString(branch.types);
    if (types !== null) {
      return types;
    }
  }
  return null;
}

/** Whether a conditional export branch contains a particular target. */
function containsTarget(value: unknown, target: string): boolean {
  if (typeof value === "string") {
    return value === target;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsTarget(item, target));
  }
  return isRecord(value) &&
    Object.values(value).some((item) => containsTarget(item, target));
}

/** The first string nested in a condition value. */
function firstString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item);
      if (found !== null) {
        return found;
      }
    }
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) {
      const found = firstString(item);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/** A string value, or null for every other JSON shape. */
function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Whether a JSON value is an object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves a package-relative target when it exists. */
function existingTarget(root: string, target: string): string | null {
  const path = join(root, target);
  return ts.sys.fileExists(path) ? normalize(path) : null;
}

/** A file URL for an absolute path, tolerant of either separator. */
function fileUrl(path: string): string {
  const forward = normalize(resolvePath(path));
  return `file:///${forward.replace(/^\//, "")}`;
}

/** Rewrites platform separators as forward slashes. */
function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}

// Longest suffixes first, so `.d.ts` is matched before `.ts`.
/** File suffixes paired with the TypeScript extension constant. */
const EXTENSIONS: [string, ts.Extension][] = [
  [".d.ts", ts.Extension.Dts],
  [".tsx", ts.Extension.Tsx],
  [".ts", ts.Extension.Ts],
  [".jsx", ts.Extension.Jsx],
  [".mts", ts.Extension.Mts],
  [".cts", ts.Extension.Cts],
  [".mjs", ts.Extension.Mjs],
  [".cjs", ts.Extension.Cjs],
  [".json", ts.Extension.Json],
];

/** Maps a file name to the TypeScript extension constant it ends with. */
function extensionOf(file: string): ts.Extension {
  for (const [suffix, extension] of EXTENSIONS) {
    if (file.endsWith(suffix)) {
      return extension;
    }
  }
  return ts.Extension.Js;
}
