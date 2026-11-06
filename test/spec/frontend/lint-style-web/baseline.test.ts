// F1-01w (LINT-STYLE-web, 规划/05 §3.11.3, D10-643 ⑧): the violations still in apps/h5 and
// apps/admin are recorded in lint/style/baseline.json, which may only shrink. Every app source file
// is linted in full (its committed text at a sibling path outside the baseline) and compared with
// the baseline; the committed file at its own path must lint clean, and one more violation than
// the baseline allows must fail. An independent scan (TypeScript AST, no lint/style code) of
// apps/admin/src/pages/**, apps/admin/src/components/** and apps/h5/src/** checks that the rules
// do report the hard-coded styles it finds. Contract: see ./support.ts.
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  ADMIN_PROBE,
  H5_PROBE,
  PREFIX,
  SCAN_TIMEOUT,
  TIMEOUT,
  isError,
  lintAs,
  overBaseline,
  rawReports,
  readBaseline,
  readRepo,
  styleRulesFor,
  type Linted,
} from './support.ts';

const ADMIN_PAGES = 'apps/admin/src/pages/';
const ADMIN_COMPONENTS = 'apps/admin/src/components/';
const ADMIN_COMPONENT_PROBE = 'apps/admin/src/components/lint-style-probe/Probe.tsx';
const H5 = 'apps/h5/src/';
const FALLBACK_SAMPLE = 'apps/h5/src/entries/app/pages/page-pending.tsx';

it(
  '[AC-F1-01w-BASELINE#1] 基线入库且只减不增：每个文件每条规则的当前违规数 ≤ 基线计数，基线之外的文件为 0',
  async () => {
    const baseline = readBaseline();
    const linted = await rawReports();
    expect(linted.some((entry) => entry.file.startsWith(H5))).toBe(true);
    expect(linted.some((entry) => entry.file.startsWith('apps/admin/src/'))).toBe(true);
    expect(overBaseline(linted, baseline)).toEqual([]);
  },
  SCAN_TIMEOUT,
);

it(
  '[AC-F1-01w-BASELINE#2] 按 eslint.config.js 原路径 lint：入库文件不报，比基线多出违规即报错',
  async () => {
    const baseline = readBaseline();
    const files = new Set<string>();
    for (const counts of baseline.values()) for (const file of counts.keys()) files.add(file);
    const sample = [...files].filter((file) => file.endsWith('.tsx')).sort()[0] ?? FALLBACK_SAMPLE;
    const text = readRepo(sample);
    expect(await lintAs(text, sample), `${sample} as committed`).toEqual([]);
    let allowance = 0;
    for (const counts of baseline.values())
      allowance = Math.max(allowance, counts.get(sample) ?? 0);
    const rows = Array.from(
      { length: allowance + 1 },
      (_, index) =>
        `      <p key={${index}} className="text-[13px] text-couli-footnote text-couli-brand-primary" style={{ fontSize: 13, padding: 16, color: '#123456' }}>x</p>`,
    );
    const grown = [
      text,
      'export function LintStyleBaselineProbe() {',
      '  return (',
      '    <>',
      ...rows,
      '    </>',
      '  );',
      '}',
      '',
    ].join('\n');
    const reports = await lintAs(grown, sample);
    expect(reports.length, `${sample} with ${rows.length} extra violating rows`).toBeGreaterThan(0);
  },
  TIMEOUT,
);

// --- independent scan --------------------------------------------------------------------------

interface Finding {
  start: number;
  end: number;
  what: string;
}

const HEX = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;
const LITERAL_VALUE = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%)?$|^#[\da-f]{3,8}$/i;
const SMALL_TEXT = new Set(['text-couli-caption', 'text-couli-footnote']);

/** The utility of a class without its variants (`focus-visible:`, `before:` …). */
function utilityOf(cls: string): string {
  let depth = 0;
  for (let i = cls.length - 1; i >= 0; i -= 1) {
    const ch = cls[i];
    if (ch === ']' || ch === ')') depth += 1;
    else if (ch === '[' || ch === '(') depth -= 1;
    else if (ch === ':' && depth === 0) return cls.slice(i + 1);
  }
  return cls;
}

/** A Tailwind arbitrary value holding a literal length, percentage or hex (not a var()). */
function literalArbitrary(cls: string): boolean {
  const match = /^-?[a-z][a-z\d-]*-\[([^\]]+)\]$/.exec(utilityOf(cls));
  return match !== null && LITERAL_VALUE.test(match[1] ?? '');
}

function isNumber(node: ts.Expression): boolean {
  if (ts.isNumericLiteral(node)) return true;
  return (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  );
}

function nameOf(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

/** The template a template head / middle / tail belongs to, or null when it is not in one. */
function templateOf(node: ts.Node): ts.Node | null {
  let host: ts.Node | undefined = node;
  while (host !== undefined) {
    if (ts.isTemplateExpression(host) || ts.isTemplateLiteralTypeNode(host)) return host;
    host = host.parent as ts.Node | undefined;
  }
  return null;
}

/** A string in a type position (`'a' | 'b'`, `` `2${string}` ``): not a style value. */
function inType(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  return (
    parent !== undefined &&
    (ts.isLiteralTypeNode(parent) ||
      ts.isTemplateLiteralTypeNode(parent) ||
      ts.isTemplateLiteralTypeSpan(parent))
  );
}

/** Hard-coded styles in a source file, each with the line range a report must fall in. */
function scan(file: string, text: string): Finding[] {
  const tsx = file.endsWith('.tsx');
  const kind = tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const lineAt = (position: number): number =>
    source.getLineAndCharacterOfPosition(position).line + 1;
  const out: Finding[] = [];
  const push = (node: ts.Node, what: string): void => {
    out.push({ start: lineAt(node.getStart(source)), end: lineAt(node.getEnd()), what });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && nameOf(node.name) === 'fontSize') {
      if (isNumber(node.initializer)) push(node, `fontSize: ${node.initializer.getText(source)}`);
    }
    const part = ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    const literal =
      (part || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      !inType(node);
    const text = literal ? (node as ts.LiteralLikeNode).text : null;
    // A report on a template literal may sit anywhere in it: use the whole template's lines.
    const host: ts.Node | null = part ? templateOf(node) : node;
    if (text !== null && host !== null && !ts.isTemplateLiteralTypeNode(host)) {
      if (tsx && HEX.test(text.trim())) push(host, text);
      const classes = text.split(/\s+/).filter((cls) => cls !== '');
      for (const cls of classes) if (literalArbitrary(cls)) push(host, cls);
      if (
        classes.includes('text-couli-brand-primary') &&
        classes.some((cls) => SMALL_TEXT.has(cls))
      )
        push(host, 'small text in text-couli-brand-primary');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Exempted by an eslint-disable comment naming a couli-style rule (line, next-line or block). */
function exempted(lines: readonly string[], finding: Finding): boolean {
  const directive = /eslint-disable(?:-next-line|-line)?\s[^\n]*couli-style\//;
  for (let line = Math.max(1, finding.start - 1); line <= finding.end; line += 1) {
    if (directive.test(lines[line - 1] ?? '')) return true;
  }
  const block = /\/\*\s*eslint-disable\s[^\n]*couli-style\//;
  return lines.slice(0, finding.start - 1).some((line) => block.test(line));
}

function missed(entries: readonly Linted[]): string[] {
  const out: string[] = [];
  for (const { file, reports } of entries) {
    const text = readRepo(file);
    const lines = text.split(/\r?\n/);
    const reported = new Set(reports.map((report) => report.line));
    for (const finding of scan(file, text)) {
      if (exempted(lines, finding)) continue;
      let hit = false;
      for (let line = finding.start; line <= finding.end; line += 1) {
        if (reported.has(line)) hit = true;
      }
      if (!hit) out.push(`${file}:${finding.start} ${finding.what}`);
    }
  }
  return out;
}

it(
  '[AC-F1-01w-SCAN#1] 扫描范围含后台 src/pages/** 与 src/components/**（及 H5 src/**）：数字 fontSize、TSX hex、字面任意值、小字品牌色都被规则报出，后台这两处没有基线外违规',
  async () => {
    // Without the rules or the baseline this fails here, on an assertion, before any scanning.
    for (const path of [ADMIN_PROBE, ADMIN_COMPONENT_PROBE, H5_PROBE]) {
      const rules = await styleRulesFor(path);
      const loaded = rules.size > 0 && [...rules.values()].every(isError);
      expect(loaded, `${PREFIX}* rules are on as errors for ${path}`).toBe(true);
    }
    const baseline = readBaseline();
    const linted = await rawReports();
    const admin = linted.filter(
      (entry) => entry.file.startsWith(ADMIN_PAGES) || entry.file.startsWith(ADMIN_COMPONENTS),
    );
    expect(admin.some((entry) => entry.file.startsWith(ADMIN_PAGES))).toBe(true);
    expect(admin.some((entry) => entry.file.startsWith(ADMIN_COMPONENTS))).toBe(true);
    const h5 = linted.filter((entry) => entry.file.startsWith(H5));
    expect(h5.length).toBeGreaterThan(0);
    expect(missed([...admin, ...h5]), 'hard-coded styles the rules do not report').toEqual([]);
    expect(overBaseline(admin, baseline)).toEqual([]);
  },
  SCAN_TIMEOUT,
);
