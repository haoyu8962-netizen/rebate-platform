// B3-16a · static checks (no database, no Nest). BR-AI-02: get_my_earnings is in
// specs/agent-tools.allowlist (D32, 随 05 B3-16 合入时同时进注册表与 allowlist); ③ the earnings reads
// reach ledger / payout only through ledger/read.ts and payout/read.ts and only their registered
// functions (getWalletSummary, listWithdrawalsForUser). D10-1244 / approvals 71: those reads live in
// the composition root's apps/api/src/agent-earnings-reads.ts (beside app.module, so the existing
// depcruise modules-only-via-index and B3-08k foreign-db-handoff gates stay as they are); the agent
// module (and so tools/registry, 05 B3-16: 收益读取放在 tools/registry 之外) reaches neither ledger
// nor payout at all. This task pins the agent module and that one file only; the repo-wide export
// check of the read entries is B3-16b's.
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  MODULES,
  ROOT,
  agentSources,
  allowlistNames,
  allowlistText,
  calledNames,
  type SourceFile,
} from '../stream-assembly-orders/scan.ts';
import { DENYLIST, TOOL } from './kit.ts';

/** The composition root's earnings reads (D10-1244): the one place that may import the read entries. */
const COMPOSITION_READS = join(ROOT, 'apps/api/src/agent-earnings-reads.ts');

/** BR-AI-02 正文：模型可调用工具的全集（含 P1 三个）。 */
const BR_AI_02_TOOLS = [
  'search_products',
  'get_rebate_quote',
  'list_my_orders',
  'explain_order',
  'prefill_claim',
  'search_rules',
  'handoff_to_human',
  'get_my_earnings',
  'create_watch',
  'list_watches',
  'cancel_watch',
];

/** The one registered function of each read entry (BR-AI-02 ③④, D32). */
const READ_ENTRIES: Readonly<Record<string, string>> = {
  'ledger/read.ts': 'getWalletSummary',
  'payout/read.ts': 'listWithdrawalsForUser',
};

interface Reach {
  readonly where: string;
  readonly file: string;
  /** `<module>/<rest>` under apps/api/src/modules. */
  readonly target: string;
  readonly kind: 'import' | 'export' | 'dynamic';
  readonly typeOnly: boolean;
  /** Imported names (original names); '*' for a namespace, 'default' for a default import. */
  readonly names: readonly string[];
  /** Imported names that are value imports (not `type`). */
  readonly valueNames: readonly string[];
  /** Local binding names of the value imports (what a call in the file uses). */
  readonly locals: readonly string[];
}

function literal(node: ts.Node | undefined): string | null {
  return node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

/** Every import / re-export / dynamic load of `files` that lands in modules/ledger or payout. */
function ledgerPayoutReaches(files: readonly SourceFile[]): Reach[] {
  const out: Reach[] = [];
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
    const targetOf = (specifier: string | null): string | null => {
      if (specifier === null || !specifier.startsWith('.')) return null;
      const parts = relative(MODULES, resolve(dirname(file.path), specifier)).split(sep);
      const head = parts[0];
      if (head !== 'ledger' && head !== 'payout') return null;
      return parts.join('/');
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const target = targetOf(literal(node.moduleSpecifier));
        if (target !== null) {
          const clause = node.importClause;
          const typeOnly = clause?.isTypeOnly === true;
          const names: string[] = [];
          const valueNames: string[] = [];
          const locals: string[] = [];
          if (clause?.name !== undefined) {
            names.push('default');
            if (!typeOnly) {
              valueNames.push('default');
              locals.push(clause.name.text);
            }
          }
          const bindings = clause?.namedBindings;
          if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
            names.push('*');
            if (!typeOnly) {
              valueNames.push('*');
              locals.push(bindings.name.text);
            }
          } else if (bindings !== undefined) {
            for (const element of bindings.elements) {
              const name = (element.propertyName ?? element.name).text;
              names.push(name);
              if (!typeOnly && !element.isTypeOnly) {
                valueNames.push(name);
                locals.push(element.name.text);
              }
            }
          }
          out.push({
            where: where(node),
            file: file.path,
            target,
            kind: 'import',
            typeOnly,
            names,
            valueNames,
            locals,
          });
        }
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const target = targetOf(literal(node.moduleReference.expression));
        if (target !== null) {
          out.push({
            where: where(node),
            file: file.path,
            target,
            kind: 'dynamic',
            typeOnly: node.isTypeOnly,
            names: [],
            valueNames: [],
            locals: [],
          });
        }
      } else if (ts.isExportDeclaration(node)) {
        const target = targetOf(literal(node.moduleSpecifier));
        if (target !== null) {
          out.push({
            where: where(node),
            file: file.path,
            target,
            kind: 'export',
            typeOnly: node.isTypeOnly,
            names: [],
            valueNames: [],
            locals: [],
          });
        }
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const loader =
          callee.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(callee) && callee.text === 'require');
        const target = loader ? targetOf(literal(node.arguments[0])) : null;
        if (target !== null) {
          out.push({
            where: where(node),
            file: file.path,
            target,
            kind: 'dynamic',
            typeOnly: false,
            names: [],
            valueNames: [],
            locals: [],
          });
        }
      } else if (ts.isImportTypeNode(node)) {
        const argument = node.argument;
        const target = ts.isLiteralTypeNode(argument) ? targetOf(literal(argument.literal)) : null;
        if (target !== null) {
          out.push({
            where: where(node),
            file: file.path,
            target,
            kind: 'import',
            typeOnly: true,
            names: [],
            valueNames: [],
            locals: [],
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

it('[AC-B3-16a#14][BR-AI-02] specs/agent-tools.allowlist 含 get_my_earnings 恰一次；其余行仍是 BR-AI-02 工具集合的子集、无重复、不命中 denylist', () => {
  const names = allowlistNames();
  expect(names.filter((name) => name === TOOL)).toEqual([TOOL]);
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) expect(BR_AI_02_TOOLS, name).toContain(name);
  expect(allowlistText()).not.toMatch(DENYLIST);
});

it('[AC-B3-16a#15][BR-AI-02] agent 模块（测试文件除外，含 tools/registry）对 ledger / payout 没有任何依赖；收益取数只在组装根 apps/api/src/agent-earnings-reads.ts：它对 ledger / payout 恰有两处具名值导入——ledger/read.ts 的 getWalletSummary 与 payout/read.ts 的 listWithdrawalsForUser，两者都确实被调用；ledger / payout 的其他文件、其他名字、类型 / 命名空间 / 默认 / 动态导入与转出一律没有', () => {
  // The agent module: no import, type import, re-export or dynamic load of ledger / payout at all.
  expect(
    ledgerPayoutReaches(agentSources()).map(
      (reach) =>
        `${reach.where} ${reach.kind}${reach.typeOnly ? ' (type)' : ''} of ${reach.target}`,
    ),
    'agent/** reaches ledger / payout',
  ).toEqual([]);

  // The composition root's file: exactly one named value import of each registered function.
  const file: SourceFile = {
    path: COMPOSITION_READS,
    text: readFileSync(COMPOSITION_READS, 'utf8'),
  };
  const reaches = ledgerPayoutReaches([file]);
  const problems: string[] = [];
  for (const reach of reaches) {
    const allowed = READ_ENTRIES[reach.target];
    if (allowed === undefined) {
      problems.push(`${reach.where} reaches ${reach.target} (only ledger/read.ts, payout/read.ts)`);
      continue;
    }
    if (reach.kind !== 'import') problems.push(`${reach.where} ${reach.kind} of ${reach.target}`);
    if (reach.typeOnly) problems.push(`${reach.where} type-only import of ${reach.target}`);
    if (
      reach.names.length !== 1 ||
      reach.names[0] !== allowed ||
      reach.valueNames.length !== 1 ||
      reach.valueNames[0] !== allowed
    ) {
      problems.push(
        `${reach.where} imports [${reach.names.join(', ')}] (values [${reach.valueNames.join(', ')}]) from ${reach.target}; only the value ${allowed}`,
      );
    }
  }
  expect(problems).toEqual([]);
  expect(
    reaches.map((reach) => reach.target).sort(),
    'one import of each read entry, nothing more',
  ).toEqual(Object.keys(READ_ENTRIES).sort());

  // Both registered functions are actually used: each imported binding is called in the file.
  const called = calledNames(file.path, file.text);
  for (const reach of reaches) {
    expect(reach.locals, `${reach.where} binds one value`).toHaveLength(1);
    for (const local of reach.locals) {
      expect(called.has(local), `${reach.where} ${local} is called`).toBe(true);
    }
  }
});
