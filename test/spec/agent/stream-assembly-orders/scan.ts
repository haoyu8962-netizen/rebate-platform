// B3-08g static helpers (no database, no Nest): the BR-AI-02 tool set and denylist (细则 ① ② 原文),
// the allowlist file, source listings and the ③ import scan over the TypeScript AST.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect } from 'vitest';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const MODULES = join(ROOT, 'apps/api/src/modules');
export const AGENT = join(MODULES, 'agent');
export const REGISTRY_DIR = join(AGENT, 'tools/registry');
export const ALLOWLIST = join(ROOT, 'specs/agent-tools.allowlist');
export const APP_MODULE = join(ROOT, 'apps/api/src/app.module.ts');

/** BR-AI-02 细则 ② 原文正则，大小写不敏感。 */
export const DENYLIST =
  /withdraw|payout|balance|ledger|payee|payout_account|inviter|bind_parent|change_phone|reward|prize|taolijin.*(create|issue|claim)/iu;

/**
 * 注册表（= allowlist）的精确集合。B3-08l（D10-327 / D10-808）：加 search_rules，6 → 7；
 * get_my_earnings 仍不在。
 */
export const EXPECTED_TOOLS = [
  'search_products',
  'get_rebate_quote',
  'list_my_orders',
  'explain_order',
  'prefill_claim',
  'handoff_to_human',
  'search_rules',
] as const;

/** 本段新注册的四个工具（开关种子也是这四个）。 */
export const NEW_TOOLS = ['handoff_to_human', 'prefill_claim', 'list_my_orders', 'explain_order'];

/** 不得出现在下发定义里的名字：本段不注册的工具、内部步骤与意图（B3-08l 起 search_rules 已注册，移出）。 */
export const NEVER_OFFERED = [
  'get_my_earnings',
  'parse_input',
  'resolve_link',
  'register_links',
  'clarify',
  'page_guide',
  'create_watch',
  'list_watches',
  'cancel_watch',
];

export function switchKey(name: string): string {
  return `agent.tools.${name}.enabled`;
}

export function allowlistText(): string {
  return readFileSync(ALLOWLIST, 'utf8');
}

/** Non-empty, non-comment lines of specs/agent-tools.allowlist, trimmed, in file order. */
export function allowlistNames(): string[] {
  return allowlistText()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** Set equality, duplicates counted as a difference (one more or one less is false). */
export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (new Set(a).size !== a.length || new Set(b).size !== b.length) return false;
  const other = new Set(b);
  return a.length === b.length && a.every((name) => other.has(name));
}

/** Every file under `dir`, recursively, as absolute paths in sorted order. */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** apps/api/src/modules/agent/** TypeScript sources, test files excluded. */
export function agentSources(): SourceFile[] {
  return filesUnder(AGENT)
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }));
}

/** BR-AI-02 ③: B-level operations and the composition root's factories agent must never name. */
export const FORBIDDEN_IDENTIFIERS = [
  'createOrderQueries',
  'createClaimEntryReader',
  'createOrderClaim',
  'createClaim',
  'openLink',
];

/** The module directory a relative specifier of `file` lands in, and whether it is its index.ts. */
function targetOf(file: string, specifier: string): { module: string; index: boolean } | null {
  if (!specifier.startsWith('.')) return null;
  const parts = relative(MODULES, resolve(dirname(file), specifier)).split(sep);
  const head = parts[0];
  if (head === undefined || head === '..' || head === '' || parts.length < 2) return null;
  return { module: head, index: parts.length === 2 && parts[1] === 'index.ts' };
}

function literal(node: ts.Node | undefined): string | null {
  return node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

/**
 * BR-AI-02 ③ for orders / linking as written in the B3-08g brief: an import or re-export reaching
 * modules/orders/ or modules/linking/ must target that module's index.ts and be type-only
 * (`import type` / `export type`); dynamic import() and require() of them are never allowed. Any
 * identifier in FORBIDDEN_IDENTIFIERS is a violation wherever it appears in code.
 */
export function importViolations(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(
      file.path,
      file.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const where = (node: ts.Node): string => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      return `${relative(ROOT, file.path)}:${String(line + 1)}`;
    };
    const check = (
      node: ts.Node,
      specifier: string | null,
      typeOnly: boolean,
      dynamic: boolean,
    ) => {
      if (specifier === null) return;
      const target = targetOf(file.path, specifier);
      if (target === null || (target.module !== 'orders' && target.module !== 'linking')) return;
      if (dynamic) out.push(`${where(node)} dynamic load of ${specifier}`);
      else if (!target.index) out.push(`${where(node)} ${specifier} is not the module index.ts`);
      else if (!typeOnly) out.push(`${where(node)} value import of ${specifier}`);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        check(node, literal(node.moduleSpecifier), node.importClause?.isTypeOnly === true, false);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
        check(node, literal(node.moduleSpecifier), node.isTypeOnly, false);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        check(node, literal(node.moduleReference.expression), false, false);
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const loader =
          callee.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(callee) && callee.text === 'require');
        if (loader) check(node, literal(node.arguments[0]), false, true);
      } else if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.includes(node.text)) {
        out.push(`${where(node)} names ${node.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

/** Names of every function called anywhere in `text` (plain identifiers only). */
export function calledNames(path: string, text: string): Set<string> {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      names.add(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/**
 * Every string a model receives in one tool definition: name, description, every object key
 * (property names included), every string value (enum values, descriptions at each level), with
 * local `$ref`s expanded against the parameter schema (the JSON Schema root). A non-local `$ref`
 * fails the test.
 */
export function definitionStrings(definition: { readonly parameters: unknown }): string[] {
  const out: string[] = [];
  const pointer = (ref: string): unknown => {
    let node: unknown = definition.parameters;
    const path = ref.slice(2).split('/');
    for (const raw of path) {
      const key = raw.replace(/~1/gu, '/').replace(/~0/gu, '~');
      node =
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[key]
          : undefined;
    }
    return node;
  };
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out.push(key);
      if (key === '$ref' && typeof value === 'string') {
        expect(value.startsWith('#/'), `only local $ref: ${value}`).toBe(true);
        if (!seen.has(value)) {
          seen.add(value);
          visit(pointer(value));
        }
      }
      visit(value);
    }
  };
  visit(definition);
  return out;
}
