// B3-16d · BR-AI-02 ③④ (D32; FU-B316B-RELAY, B3-16b spec-test r1 S2): a reader of the two
// read-only entries (ledger/read.ts, payout/read.ts) must not hand the imported functions on.
// B3-16b's consumerScan (../read-exports/kit.ts) only sees references that carry a module
// specifier; `import { getWalletSummary } from './modules/ledger/read.ts'` followed by a bare
// `export { getWalletSummary }` (no moduleSpecifier) slipped through. Static only (no database, no
// Nest, no network), written with the TypeScript compiler API, never with grep.
//
// relayProblems(files): in each file, every binding an ImportDeclaration takes from a read entry
//   (named, aliased, default or namespace; the entry found from the specifier as consumerScan
//   does: relative by path with .ts / .js / extensionless / index forms, bare through the
//   compiler's module resolution) is followed to each of its references by the checker's symbols
//   (so a shadowing local of the same name is not it). A reference is allowed only
//     - as the callee of a call, `x(…)` (what is handed on is the result, not the function), or
//     - inside a type query, `typeof x` (types carry no value).
//   Anything else hands the function itself on and fails:
//     [relay-export]  export { x } / export { x as y } / export { x as default } without from;
//     [relay-default] export default x (or any expression of it holding x);
//     [relay-equals]  export = x;
//     [relay-value]   any other value use: `export const y = x`, `export const api = { x }`,
//                     `const y = x; export { y }`, `[x]`, `f(x)`, `x.bind(…)`, `return x`, …
//   Other exports of the file, not built from such a binding, are left alone.
//
// Each file is compiled alone (noResolve, noLib) from text, in memory: binding local names to
// symbols needs no other file, so the in-memory samples and the real files run the same code path.
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { READ_ENTRIES, abs, rel, type SourceText } from '../read-exports/kit.ts';

/** One binding imported from a read entry. */
export interface EntryBinding {
  readonly where: string;
  readonly file: string;
  readonly entry: string;
  /** The local name in the reader file. */
  readonly local: string;
}

export interface RelayScan {
  readonly bindings: readonly EntryBinding[];
  readonly problems: readonly string[];
}

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  allowImportingTsExtensions: true,
  experimentalDecorators: true,
  noEmit: true,
  noLib: true,
  noResolve: true,
  types: [],
  skipLibCheck: true,
};

const RESOLUTION_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  allowImportingTsExtensions: true,
};

const RESOLUTION_CACHE = ts.createModuleResolutionCache(
  resolve(abs('.')),
  (name) => name,
  RESOLUTION_OPTIONS,
);

/** A program over the one file `file`, read from memory (never from or to the disk). */
function singleFileProgram(file: SourceText): { program: ts.Program; source: ts.SourceFile } {
  const path = abs(file.path);
  const host = ts.createCompilerHost(OPTIONS, true);
  // The sample's folders must exist for the host even when they are not on disk (B3-16b r2).
  const dirs = new Set<string>();
  for (let dir = dirname(path); !dirs.has(dir); dir = dirname(dir)) {
    dirs.add(dir);
    if (dirname(dir) === dir) break;
  }
  const fileExists = host.fileExists.bind(host);
  const directoryExists = host.directoryExists?.bind(host);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (name) => resolve(name) === path || fileExists(name);
  host.directoryExists = (name) =>
    dirs.has(resolve(name)) || (directoryExists === undefined ? true : directoryExists(name));
  host.readFile = (name) => (resolve(name) === path ? file.text : readFile(name));
  host.getSourceFile = (name, language, onError, shouldCreate) =>
    resolve(name) === path
      ? ts.createSourceFile(name, file.text, language, true, ts.ScriptKind.TS)
      : getSourceFile(name, language, onError, shouldCreate);
  const program = ts.createProgram({ rootNames: [path], options: OPTIONS, host });
  const source = program.getSourceFile(path);
  if (source === undefined) throw new Error(`no source file for ${file.path}`);
  return { program, source };
}

/** The read entry a specifier written in `file` points to, or null (as consumerScan). */
function entryTarget(specifier: string, file: string): string | null {
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(abs(file)), specifier);
    const candidates = [
      base,
      `${base}.ts`,
      base.replace(/\.(?:js|mjs|cjs|mts|cts)$/u, '.ts'),
      join(base, 'index.ts'),
    ];
    for (const candidate of candidates) {
      const path = rel(candidate);
      if (READ_ENTRIES.includes(path)) return path;
    }
    return null;
  }
  const result = ts.resolveModuleName(
    specifier,
    abs(file),
    RESOLUTION_OPTIONS,
    ts.sys,
    RESOLUTION_CACHE,
  );
  const resolved = result.resolvedModule?.resolvedFileName;
  if (resolved === undefined) return null;
  const path = rel(resolved);
  return READ_ENTRIES.includes(path) ? path : null;
}

function lineOf(source: ts.SourceFile, file: string, node: ts.Node): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${file}:${String(line + 1)}`;
}

/** The local identifiers an import declaration binds. */
function boundNames(node: ts.ImportDeclaration): ts.Identifier[] {
  const clause = node.importClause;
  if (clause === undefined) return [];
  const names: ts.Identifier[] = [];
  if (clause.name !== undefined) names.push(clause.name);
  const bindings = clause.namedBindings;
  if (bindings !== undefined) {
    if (ts.isNamespaceImport(bindings)) names.push(bindings.name);
    else for (const element of bindings.elements) names.push(element.name);
  }
  return names;
}

/** The symbol an identifier stands for at its place (the local value it reads, for shorthands). */
function symbolOf(checker: ts.TypeChecker, node: ts.Identifier): ts.Symbol | undefined {
  const parent = node.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
    return checker.getShorthandAssignmentValueSymbol(parent);
  }
  if (ts.isExportSpecifier(parent) && (parent.propertyName ?? parent.name) === node) {
    if (parent.parent.parent.moduleSpecifier !== undefined) return undefined;
    return checker.getExportSpecifierLocalTargetSymbol(parent);
  }
  return checker.getSymbolAtLocation(node);
}

function inTypeQuery(node: ts.Node): boolean {
  for (let at: ts.Node = node; !ts.isSourceFile(at); at = at.parent) {
    if (ts.isTypeQueryNode(at)) return true;
  }
  return false;
}

function isCallee(node: ts.Identifier): boolean {
  const parent = node.parent;
  return ts.isCallExpression(parent) && parent.expression === node;
}

function exportAssignmentOf(node: ts.Node): ts.ExportAssignment | null {
  for (let at: ts.Node = node; !ts.isSourceFile(at); at = at.parent) {
    if (ts.isExportAssignment(at)) return at;
  }
  return null;
}

/** relayProblems over `files` (see the header); [] problems when no entry binding is handed on. */
export function relayScan(files: readonly SourceText[]): RelayScan {
  const bindings: EntryBinding[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const { program, source } = singleFileProgram(file);
    const checker = program.getTypeChecker();
    for (const diagnostic of program.getSyntacticDiagnostics(source)) {
      problems.push(
        `[syntax] ${file.path}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
      );
    }
    const tracked = new Map<ts.Symbol, EntryBinding>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!ts.isStringLiteral(specifier)) continue;
      const entry = entryTarget(specifier.text, file.path);
      if (entry === null) continue;
      for (const name of boundNames(statement)) {
        const binding: EntryBinding = {
          where: lineOf(source, file.path, name),
          file: file.path,
          entry,
          local: name.text,
        };
        bindings.push(binding);
        const symbol = checker.getSymbolAtLocation(name);
        if (symbol === undefined) {
          problems.push(`[binding] ${binding.where}: ${name.text} of ${entry} has no symbol`);
        } else {
          tracked.set(symbol, binding);
        }
      }
    }
    if (tracked.size === 0) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isIdentifier(node)) {
        const symbol = symbolOf(checker, node);
        const binding = symbol === undefined ? undefined : tracked.get(symbol);
        if (binding !== undefined) {
          const where = lineOf(source, file.path, node);
          const what = `${binding.local} (from ${binding.entry})`;
          const assignment = exportAssignmentOf(node);
          if (ts.isExportSpecifier(node.parent)) {
            const exported = node.parent.name.text;
            problems.push(`[relay-export] ${where}: ${what} exported again as ${exported}`);
          } else if (inTypeQuery(node)) {
            // typeof x: a type, no value is handed on.
          } else if (assignment !== null) {
            problems.push(
              assignment.isExportEquals === true
                ? `[relay-equals] ${where}: export = ${what}`
                : `[relay-default] ${where}: export default ${what}`,
            );
          } else if (!isCallee(node)) {
            problems.push(
              `[relay-value] ${where}: ${what} used as a value (only x(…) or typeof x allowed)`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { bindings, problems };
}
