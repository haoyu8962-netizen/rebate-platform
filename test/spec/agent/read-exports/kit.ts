// B3-16b · BR-AI-02 ④ 只读入口导出检查 (D32; 规划/05 B3-16 第二张, D10-1226). Static only (no
// database, no Nest, no network), written with the TypeScript compiler API, never with grep.
//
// 契约 · specs/agent-read-exports.yaml（实现方写；解析不了或不合契约都算失败）:
//
//   exports:
//     - entry: apps/api/src/modules/ledger/read.ts
//       name: getWalletSummary
//       declared_in: apps/api/src/modules/ledger/application/wallet-summary.ts
//       original: getWalletSummary
//     - entry: apps/api/src/modules/payout/read.ts
//       name: listWithdrawalsForUser
//       declared_in: apps/api/src/modules/payout/application/withdrawal-reads.ts
//       original: listWithdrawalsForUser
//
// - Read with tools/lib/yaml-lite.ts (the repo's strict YAML subset; `#` comments allowed, plain or
//   quoted scalars). Anything it rejects fails.
// - Top level: a mapping with exactly one key, `exports`: a non-empty sequence of items.
// - Each item: a mapping with exactly the keys entry, name, declared_in, original; every value a
//   non-empty string without surrounding spaces.
// - entry: one of the two read entries, repo-relative posix, exactly as above. Both are listed.
// - name, original: an identifier (not `default`); name equals original (④(b): no renaming).
// - declared_in: repo-relative posix path (no leading `/`, no `.` / `..` / empty segment, no `\`)
//   of a `.ts` file (not `.d.ts`, `.test.ts`, `.spec.ts`) under the entry's own module directory,
//   neither the entry itself nor that module's index.ts.
// - (entry, name) appears once.
//
// ④(a)(b) entryProblems(program, entries, items): for each entry file, every top-level statement
//   is `export { name } from '<file>'` (no `export type`, `type` element, `as`, `export *`,
//   `export * as`, local `export { x }`, import, declaration, `export default`, `export =`, import
//   attributes); each name is registered for that entry and appears once; the module specifier
//   resolves (compiler) to the registered declared_in; the export, resolved through every alias by
//   the checker, lands on value declarations all in declared_in and named `original`; and the
//   compiler's export set of the entry equals the registered names exactly.
// ④(c) consumerScan(files, registered, allowed): every reference in `files` to an entry — static
//   import, re-export (`export … from`), `import x = require(…)`, dynamic `import(…)`, `require(…)`,
//   type-level `import(…)` — is found (relative specifiers by path, `.js` / extensionless / index
//   forms included; bare specifiers through the compiler's module resolution). It must come from a
//   file `allowed` for that entry, never from apps/api/src/modules/agent/**, and be a static import
//   of named values only, each registered for that entry (alias allowed): no namespace, default,
//   side-effect, empty or type-only import, no type element.
//
// Every problem starts with a [tag] so the in-memory samples can say why they fail.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect } from 'vitest';
import { YamlLiteError, parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const MANIFEST = 'specs/agent-read-exports.yaml';
export const LEDGER_READ = 'apps/api/src/modules/ledger/read.ts';
export const PAYOUT_READ = 'apps/api/src/modules/payout/read.ts';
export const READ_ENTRIES: readonly string[] = [LEDGER_READ, PAYOUT_READ];
export const API_SRC = 'apps/api/src';
export const AGENT_DIR = 'apps/api/src/modules/agent';
/** The composition root's earnings reads (D10-1244): get_my_earnings' one reader of both entries. */
export const COMPOSITION_READS = 'apps/api/src/agent-earnings-reads.ts';
export const APP_MODULE = 'apps/api/src/app.module.ts';

/** A file by repo-relative posix path. */
export interface SourceText {
  readonly path: string;
  readonly text: string;
}

/** One registered export (paths repo-relative posix). */
export interface ExportItem {
  readonly entry: string;
  readonly name: string;
  readonly declaredIn: string;
  readonly original: string;
}

export function abs(path: string): string {
  return resolve(ROOT, path);
}

export function rel(path: string): string {
  return relative(ROOT, resolve(path)).split(sep).join('/');
}

// ---------------------------------------------------------------- manifest (④(a))

const ITEM_KEYS = ['entry', 'name', 'declared_in', 'original'] as const;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

export interface ManifestResult {
  /** The items, only when there is no problem. */
  readonly items: readonly ExportItem[];
  readonly problems: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function declaredInProblems(at: string, entry: string, path: string): string[] {
  const problems: string[] = [];
  const segments = path.split('/');
  if (
    path.includes('\\') ||
    path.startsWith('/') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    problems.push(`[declared_in] ${at}: ${path} is not a plain repo-relative posix path`);
  }
  if (!path.endsWith('.ts') || /\.(?:d|test|spec)\.ts$/u.test(path)) {
    problems.push(`[declared_in] ${at}: ${path} is not a source .ts file`);
  }
  const moduleDir = entry.slice(0, entry.lastIndexOf('/') + 1);
  if (!path.startsWith(moduleDir)) {
    problems.push(`[declared_in] ${at}: ${path} is outside ${moduleDir}`);
  }
  if (path === entry || path === `${moduleDir}index.ts`) {
    problems.push(`[declared_in] ${at}: ${path} is the entry or the module's index.ts`);
  }
  return problems;
}

/** Parses and validates the manifest text against the contract above. */
export function parseManifest(text: string): ManifestResult {
  let doc: unknown;
  try {
    doc = parseYamlLite(text);
  } catch (error) {
    if (!(error instanceof YamlLiteError)) throw error;
    return { items: [], problems: [`[yaml] ${error.message}`] };
  }
  if (!isRecord(doc)) {
    return { items: [], problems: ['[shape] the top level must be a mapping (key exports)'] };
  }
  const problems: string[] = [];
  const topKeys = Object.keys(doc);
  if (topKeys.length !== 1 || topKeys[0] !== 'exports') {
    problems.push(`[shape] top-level keys [${topKeys.join(', ')}]; exactly [exports]`);
  }
  const list = doc['exports'];
  if (!Array.isArray(list) || list.length === 0) {
    problems.push('[shape] exports must be a non-empty sequence');
    return { items: [], problems };
  }
  const items: ExportItem[] = [];
  list.forEach((raw: unknown, index) => {
    const at = `exports[${String(index)}]`;
    if (!isRecord(raw)) {
      problems.push(`[shape] ${at} must be a mapping`);
      return;
    }
    const keys = Object.keys(raw).sort();
    const wanted = [...ITEM_KEYS].sort();
    if (keys.join(',') !== wanted.join(',')) {
      problems.push(`[shape] ${at} keys [${keys.join(', ')}]; exactly [${wanted.join(', ')}]`);
    }
    const values: string[] = [];
    for (const key of ITEM_KEYS) {
      const value = raw[key];
      if (typeof value !== 'string' || value === '' || value.trim() !== value) {
        problems.push(`[shape] ${at}.${key} must be a non-empty string, no surrounding spaces`);
      } else {
        values.push(value);
      }
    }
    const [entry, name, declaredIn, original] = values;
    if (
      values.length !== ITEM_KEYS.length ||
      entry === undefined ||
      name === undefined ||
      declaredIn === undefined ||
      original === undefined
    ) {
      return;
    }
    if (!READ_ENTRIES.includes(entry)) {
      problems.push(`[entry] ${at}: ${entry}; only ${READ_ENTRIES.join(', ')}`);
    }
    for (const value of [name, original]) {
      if (!IDENTIFIER.test(value) || value === 'default') {
        problems.push(`[name] ${at}: ${value} is not an identifier other than default`);
      }
    }
    if (name !== original) {
      problems.push(`[name] ${at}: name ${name} differs from original ${original}`);
    }
    problems.push(...declaredInProblems(at, entry, declaredIn));
    items.push({ entry, name, declaredIn, original });
  });
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.entry} ${item.name}`;
    if (seen.has(key)) problems.push(`[duplicate] ${item.name} of ${item.entry} is listed twice`);
    seen.add(key);
  }
  for (const entry of READ_ENTRIES) {
    if (!items.some((item) => item.entry === entry)) {
      problems.push(`[missing-entry] ${entry} has no registered export`);
    }
  }
  return problems.length === 0 ? { items, problems } : { items: [], problems };
}

/** The manifest text of `items`, in the contract's format (values double-quoted). */
export function renderManifest(items: readonly ExportItem[]): string {
  const lines = ['# BR-AI-02 ④ (D32): exports of the read-only entries.', 'exports:'];
  for (const item of items) {
    lines.push(`  - entry: ${JSON.stringify(item.entry)}`);
    lines.push(`    name: ${JSON.stringify(item.name)}`);
    lines.push(`    declared_in: ${JSON.stringify(item.declaredIn)}`);
    lines.push(`    original: ${JSON.stringify(item.original)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The repo's manifest: it exists and meets the contract (fails the test otherwise). */
export function loadManifest(): readonly ExportItem[] {
  expect(existsManifest(), `${MANIFEST} is missing (B3-16b registers it)`).toBe(true);
  const result = parseManifest(readFileSync(abs(MANIFEST), 'utf8'));
  expect(result.problems, MANIFEST).toEqual([]);
  expect(result.items.length, MANIFEST).toBeGreaterThan(0);
  return result.items;
}

function existsManifest(): boolean {
  try {
    return statSync(abs(MANIFEST)).isFile();
  } catch {
    return false;
  }
}

/** entry → its registered names. */
export function registeredNames(
  items: readonly ExportItem[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  for (const item of items) {
    const names = out.get(item.entry) ?? new Set<string>();
    names.add(item.name);
    out.set(item.entry, names);
  }
  return out;
}

// ---------------------------------------------------------------- entries (④(a)(b))

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  allowImportingTsExtensions: true,
  experimentalDecorators: true,
  noEmit: true,
  strict: true,
  skipLibCheck: true,
  types: ['node'],
};

/**
 * A program over `roots` (repo-relative) where the files of `memory` are read from memory (they
 * need not exist and are never written); every other file comes from the disk.
 */
export function exportProgram(
  roots: readonly string[],
  memory: readonly SourceText[] = [],
): ts.Program {
  const host = ts.createCompilerHost(OPTIONS, true);
  const files = new Map(memory.map((file) => [abs(file.path), file.text]));
  // The folders holding in-memory files (and their parents). Module resolution skips every
  // lookup in a folder the host says is missing, so a sample folder that is not on disk must exist.
  const dirs = new Set<string>();
  for (const path of files.keys()) {
    for (let dir = dirname(path); !dirs.has(dir); dir = dirname(dir)) {
      dirs.add(dir);
      if (dirname(dir) === dir) break;
    }
  }
  const fileExists = host.fileExists.bind(host);
  const directoryExists = host.directoryExists?.bind(host);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (path) => files.has(resolve(path)) || fileExists(path);
  host.directoryExists = (path) =>
    dirs.has(resolve(path)) || (directoryExists === undefined ? true : directoryExists(path));
  host.readFile = (path) => files.get(resolve(path)) ?? readFile(path);
  host.getSourceFile = (path, language, onError, shouldCreate) => {
    const text = files.get(resolve(path));
    return text === undefined
      ? getSourceFile(path, language, onError, shouldCreate)
      : ts.createSourceFile(path, text, language, true);
  };
  return ts.createProgram({ rootNames: roots.map(abs), options: OPTIONS, host });
}

function lineOf(source: ts.SourceFile, node: ts.Node): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${rel(source.fileName)}:${String(line + 1)}`;
}

function sourceFileOf(symbol: ts.Symbol | undefined): string | null {
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration === undefined || !ts.isSourceFile(declaration)) return null;
  return rel(declaration.fileName);
}

function exportDeclarationProblems(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  statement: ts.ExportDeclaration,
  registered: readonly ExportItem[],
  seen: Set<string>,
): string[] {
  const where = lineOf(source, statement);
  const problems: string[] = [];
  if (statement.isTypeOnly) problems.push(`[type-only] ${where}: export type`);
  if (statement.attributes !== undefined) {
    problems.push(`[attributes] ${where}: import attributes`);
  }
  const specifier = statement.moduleSpecifier;
  if (specifier === undefined) {
    problems.push(`[local-export] ${where}: export without from (a local binding)`);
  }
  const clause = statement.exportClause;
  if (clause === undefined) {
    problems.push(`[export-star] ${where}: export *`);
    return problems;
  }
  if (ts.isNamespaceExport(clause)) {
    problems.push(`[namespace-export] ${where}: export * as ${clause.name.text}`);
    return problems;
  }
  const fromFile =
    specifier === undefined ? null : sourceFileOf(checker.getSymbolAtLocation(specifier));
  const specifierText =
    specifier !== undefined && ts.isStringLiteral(specifier) ? specifier.text : '(none)';
  for (const element of clause.elements) {
    const name = element.name.text;
    if (!ts.isIdentifier(element.name)) {
      problems.push(`[name] ${where}: string export name "${name}"`);
    }
    if (element.isTypeOnly) problems.push(`[type-only] ${where}: type ${name}`);
    if (element.propertyName !== undefined) {
      problems.push(`[rename] ${where}: ${element.propertyName.text} as ${name}`);
    }
    if (seen.has(name)) problems.push(`[duplicate] ${where}: ${name} exported again`);
    seen.add(name);
    const item = registered.find((candidate) => candidate.name === name);
    if (item === undefined) {
      problems.push(
        `[unregistered] ${where}: ${name} is not registered for ${rel(source.fileName)}`,
      );
      continue;
    }
    if (specifier === undefined) continue;
    if (fromFile !== item.declaredIn) {
      problems.push(
        `[declaration-file] ${where}: ${name} from '${specifierText}' (${fromFile ?? 'unresolved'}); registered ${item.declaredIn}`,
      );
    }
    const alias = checker.getSymbolAtLocation(element.name);
    const target =
      alias !== undefined && (alias.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(alias)
        : alias;
    const declarations = target?.declarations ?? [];
    if (target === undefined || declarations.length === 0) {
      problems.push(`[resolution] ${where}: ${name} resolves to no declaration`);
      continue;
    }
    if ((target.flags & ts.SymbolFlags.Value) === 0) {
      problems.push(`[resolution] ${where}: ${name} resolves to no value`);
    }
    for (const declaration of declarations) {
      const file = rel(declaration.getSourceFile().fileName);
      const declared = ts.getNameOfDeclaration(declaration);
      const declaredName =
        declared !== undefined && ts.isIdentifier(declared) ? declared.text : '(unnamed)';
      if (file !== item.declaredIn || declaredName !== item.original) {
        problems.push(
          `[resolution] ${where}: ${name} resolves to ${declaredName} in ${file}; registered ${item.original} in ${item.declaredIn}`,
        );
      }
    }
  }
  return problems;
}

/** ④(a)(b) over `entries` (repo-relative) with the registered `items`; [] when all hold. */
export function entryProblems(
  program: ts.Program,
  entries: readonly string[],
  items: readonly ExportItem[],
): string[] {
  const checker = program.getTypeChecker();
  const problems: string[] = [];
  for (const item of items) {
    if (!entries.includes(item.entry)) {
      problems.push(`[entry] ${item.name} is registered for ${item.entry}, not a read entry`);
    }
  }
  for (const entry of entries) {
    const registered = items.filter((item) => item.entry === entry);
    const source = program.getSourceFile(abs(entry));
    if (source === undefined) {
      problems.push(`[not-found] ${entry}`);
      continue;
    }
    for (const diagnostic of program.getSyntacticDiagnostics(source)) {
      problems.push(
        `[syntax] ${entry}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
      );
    }
    const seen = new Set<string>();
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement)) {
        problems.push(...exportDeclarationProblems(checker, source, statement, registered, seen));
      } else {
        problems.push(
          `[statement] ${lineOf(source, statement)}: ${ts.SyntaxKind[statement.kind]} is not allowed; only export { name } from '<registered declaration file>'`,
        );
      }
    }
    const moduleSymbol = checker.getSymbolAtLocation(source);
    const actual =
      moduleSymbol === undefined
        ? []
        : checker
            .getExportsOfModule(moduleSymbol)
            .map((symbol) => symbol.getName())
            .sort();
    const expected = registered.map((item) => item.name).sort();
    if (actual.join(',') !== expected.join(',')) {
      problems.push(
        `[export-set] ${entry}: exports [${actual.join(', ')}]; registered [${expected.join(', ')}]`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------- consumers (④(c))

export type ReachKind =
  'import' | 're-export' | 'import-equals' | 'dynamic-import' | 'require' | 'type-import';

export interface Reach {
  readonly where: string;
  /** The consumer file, repo-relative. */
  readonly file: string;
  /** The entry reached, repo-relative. */
  readonly entry: string;
  readonly kind: ReachKind;
}

export interface ConsumerScan {
  readonly reaches: readonly Reach[];
  readonly problems: readonly string[];
}

const RESOLUTION_CACHE = ts.createModuleResolutionCache(ROOT, (name) => name, OPTIONS);

/** The entry a specifier written in `file` points to, or null. */
function entryTarget(specifier: string, file: string, entries: ReadonlySet<string>): string | null {
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
      if (entries.has(path)) return path;
    }
    return null;
  }
  const result = ts.resolveModuleName(specifier, abs(file), OPTIONS, ts.sys, RESOLUTION_CACHE);
  const resolved = result.resolvedModule?.resolvedFileName;
  if (resolved === undefined) return null;
  const path = rel(resolved);
  return entries.has(path) ? path : null;
}

function literalText(node: ts.Node | undefined): string | null {
  if (node === undefined) return null;
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return null;
  return node.text;
}

function importProblems(
  where: string,
  entry: string,
  node: ts.ImportDeclaration,
  names: ReadonlySet<string>,
): string[] {
  const clause = node.importClause;
  if (clause === undefined) {
    return [`[side-effect-import] ${where}: import of ${entry} binds nothing`];
  }
  const problems: string[] = [];
  if (clause.isTypeOnly) problems.push(`[type-import] ${where}: import type from ${entry}`);
  if (clause.name !== undefined) {
    problems.push(`[default-import] ${where}: default import ${clause.name.text} of ${entry}`);
  }
  const bindings = clause.namedBindings;
  if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
    problems.push(`[namespace-import] ${where}: import * as ${bindings.name.text} of ${entry}`);
    return problems;
  }
  const elements = bindings?.elements ?? [];
  if (elements.length === 0 && clause.name === undefined) {
    problems.push(`[side-effect-import] ${where}: import {} of ${entry} binds nothing`);
  }
  for (const element of elements) {
    const imported = (element.propertyName ?? element.name).text;
    if (element.isTypeOnly) {
      problems.push(`[type-import] ${where}: type ${imported} from ${entry}`);
    }
    if (!names.has(imported)) {
      problems.push(`[unregistered] ${where}: ${imported} is not registered for ${entry}`);
    }
  }
  return problems;
}

/**
 * ④(c) over `files`: every reference to a read entry, and the problems among them (see the
 * header). `registered`: entry → its registered names; `allowed`: consumer file → entries it may
 * import.
 */
export function consumerScan(
  files: readonly SourceText[],
  registered: ReadonlyMap<string, ReadonlySet<string>>,
  allowed: ReadonlyMap<string, ReadonlySet<string>>,
): ConsumerScan {
  const entries = new Set(READ_ENTRIES);
  const reaches: Reach[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(
      abs(file.path),
      file.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const reach = (node: ts.Node, specifier: string | null, kind: ReachKind): string | null => {
      const entry = specifier === null ? null : entryTarget(specifier, file.path, entries);
      if (entry === null) return null;
      const where = lineOf(source, node);
      reaches.push({ where, file: file.path, entry, kind });
      if (allowed.get(file.path)?.has(entry) !== true) {
        problems.push(`[consumer] ${where}: ${file.path} may not reach ${entry}`);
      }
      if (file.path.startsWith(`${AGENT_DIR}/`)) {
        problems.push(`[agent] ${where}: agent/** reaches ${entry}`);
      }
      if (kind !== 'import') problems.push(`[${kind}] ${where}: ${kind} of ${entry}`);
      return entry;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const entry = reach(node, literalText(node.moduleSpecifier), 'import');
        if (entry !== null) {
          problems.push(
            ...importProblems(
              lineOf(source, node),
              entry,
              node,
              registered.get(entry) ?? new Set<string>(),
            ),
          );
        }
      } else if (ts.isExportDeclaration(node)) {
        reach(node, literalText(node.moduleSpecifier), 're-export');
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        reach(node, literalText(node.moduleReference.expression), 'import-equals');
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword) {
          reach(node, literalText(node.arguments[0]), 'dynamic-import');
        } else if (ts.isIdentifier(callee) && callee.text === 'require') {
          reach(node, literalText(node.arguments[0]), 'require');
        }
      } else if (ts.isImportTypeNode(node)) {
        const argument = node.argument;
        if (ts.isLiteralTypeNode(argument)) {
          reach(node, literalText(argument.literal), 'type-import');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { reaches, problems };
}

/** Every file under `dir` (absolute), recursively, sorted. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** apps/api/src/** TypeScript sources, test files (*.test.ts, *.spec.ts) excluded. */
export function apiSources(): SourceText[] {
  return filesUnder(abs(API_SRC))
    .filter((path) => /\.[mc]?ts$/u.test(path) && !/\.(?:test|spec)\.[mc]?ts$/u.test(path))
    .map((path) => ({ path: rel(path), text: readFileSync(path, 'utf8') }));
}
