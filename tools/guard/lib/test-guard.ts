// Static checks on test files, vitest configs and package scripts
// (规划/11 §2.3 step 5, §4.1, §4.2, §4.3; conventions C5).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Change } from '../../lib/git.ts';
import type { ProtectedConfig, ProtectedHit } from './protected.ts';
import { findProtectedHits } from './protected.ts';
import { compareTestFile, testBlockSpans } from './test-blocks.ts';

export type Finding = { file: string; line: number; rule: string; message: string };

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const INT_TEST_FILE = /\.int\.test\.[cm]?[jt]sx?$/;
const VITEST_CONFIG = /(^|\/)vitest[^/]*\.config\.[^/]+$|(^|\/)vitest\.shared\.ts$/;
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const RULE_TEST_DIR = /^test\/(spec|properties)\//;
const ACCEPTANCE_DIR = /^test\/acceptance\//;

// Modules a unit test must not import: they need a database, Docker or the network.
const INTEGRATION_ONLY = ['pg', 'pg-boss', 'testcontainers', '@couli/db/testing'];
const INTEGRATION_ONLY_SCOPES = ['@testcontainers/'];

const SKIP_OR_ONLY = /\.\s*(skip|only|skipIf|runIf|todo)\b(?=\s*[(.`])/;
const X_PREFIXED = /(?<![\w$.])(xit|xtest|xdescribe|fit|fdescribe)\s*\(/;
const RETRY_KEY = /\bretry\s*:\s*([^\s,})]+)/;
const RETRY_SHORTHAND = /[{,]\s*retry\s*[,}]/;
// Vitest's test API: the options object (with `retry`) is the second argument of these calls,
// of their modifier chains (`.concurrent`, `.each(table)`, `.for(cases)`, `.skipIf(c)`, …) and
// of the test functions made from them with `.extend(...)`.
const TEST_API_ROOTS = ['it', 'test', 'describe', 'suite'];
const CALL_ROOT = /(?<![\w$.])([A-Za-z_$][\w$]*)((?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?=[(`])/g;
const EXTENDED_TEST =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\.\s*extend\b/g;
const NOT_A_CALLEE = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return']);
const RETRY_PROPERTY = /^(?:retry|'retry'|"retry"|\[\s*(['"`])retry\1\s*\])\s*(?::([\s\S]*))?$/;
const FUNCTION_LITERAL = /^(?:async\b|function\b|\(|[A-Za-z_$][\w$]*\s*=>)/;
// Funds and attribution test files keep the plain line rule: no `retry` key anywhere in the file
// (规划/11 §4.2「守卫禁止 vitest 配置和资金、归属测试文件里出现 retry」). Other test files may
// use `retry` as an ordinary field name; there only Vitest's retry option is refused.
const FUNDS_STEM =
  /^(?:money|domain|ledger|commission|settlement|payout|withdraw|reconcil|order|linking|union|attribution|fund|clawback)/i;
const PASS_WITH_NO_TESTS = /\bpassWithNoTests\s*:\s*(?!\s|false\b)/;
const ALLOW_ONLY = /\ballowOnly\s*:\s*(?!\s|false\b)/;
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;
const LISTEN_CALL = /\.\s*listen\s*\(/;
const ADMIN_URL = /TEST_PG_ADMIN_URL/g;
// The one accepted reference: asserting that the superuser URL did not leak into a test worker.
const ADMIN_URL_ABSENT =
  /expect\(\s*process\.env(?:\.TEST_PG_ADMIN_URL|\[\s*['"]TEST_PG_ADMIN_URL['"]\s*\])\s*\)\s*\.toBeUndefined\(\)/g;
const DESCRIBE_CALL = /(?<![\w$.])describe\s*(?:\.\s*\w+\s*)*[(`]/;
const MOCK_CALL = /\bvi\s*\.\s*(?:mock|doMock)\s*\(\s*(['"`])([^'"`\n]+)\1/g;
const AC_TAG = /\[AC-[A-Z][A-Z0-9]*-\d+(?:#\d+)?\]/;
const BAD_SCRIPT_FLAG = /--?passWithNoTests\b|--retry\b|--allowOnly\b/;

function isZeroLiteral(value: string): boolean {
  return /^0(?![\d.xXbBoO_])/.test(value);
}

function isIntegrationOnly(specifier: string): boolean {
  return (
    INTEGRATION_ONLY.some((m) => specifier === m || specifier.startsWith(`${m}/`)) ||
    INTEGRATION_ONLY_SCOPES.some((s) => specifier.startsWith(s))
  );
}

function isFundsCoreModule(specifier: string): boolean {
  return (
    specifier === '@couli/money' ||
    specifier.startsWith('@couli/money/') ||
    /(^|\/)packages\/money(\/|$)/.test(specifier) ||
    /(^|\/)ledger(\/|\.|$)/.test(specifier)
  );
}

function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Funds and attribution test files (规划/11 §4.2): the money and domain packages, the funds and
 * attribution modules of apps/api (the MONEY_PATHS of tools/ci/evidence-check.ts, matched by
 * stem), rule tests whose directories or file name carry such a stem, the acceptance and replay
 * suites, and db/.
 */
export function isFundsTestFile(file: string): boolean {
  if (/^(?:db|test\/acceptance|test\/replay)\//.test(file)) return true;
  if (/^packages\/(?:money|domain)\//.test(file)) return true;
  const module = /^apps\/api\/src\/modules\/([^/]+)\//.exec(file);
  if (module) return FUNDS_STEM.test(module[1] ?? '');
  const rule = /^test\/(?:spec|properties)\/(.+)$/.exec(file);
  if (rule) return (rule[1] ?? '').split('/').some((segment) => FUNDS_STEM.test(segment));
  return false;
}

/** Index just after the string literal starting at `start` (a quote or backtick), or -1. */
function skipString(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === quote) return i + 1;
    else if (c === '\n' && quote !== '`') return -1;
  }
  return -1;
}

/** Index just after the `)` matching the `(` at `open`, or -1. */
function skipParens(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(text, i);
      if (end === -1) return -1;
      i = end - 1;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Titles of `it(...)` / `test(...)` calls; `title` is null when it is not a string literal. */
export function testTitles(text: string): { line: number; title: string | null }[] {
  const out: { line: number; title: string | null }[] = [];
  const call = /(?<![\w$.])(?:it|test)\b((?:\s*\.\s*\w+)*)\s*([(`])/g;
  for (let m = call.exec(text); m !== null; m = call.exec(text)) {
    const line = lineOfOffset(text, m.index);
    let i = m.index + m[0].length - 1;
    if (/\.\s*(each|for)\b/.test(m[1] ?? '')) {
      // `it.each(table)('title', ...)` or it.each`table`('title', ...): skip the table first.
      i = text[i] === '(' ? skipParens(text, i) : skipString(text, i);
      if (i === -1) {
        out.push({ line, title: null });
        continue;
      }
      while (/\s/.test(text[i] ?? '')) i++;
      if (text[i] !== '(') {
        out.push({ line, title: null });
        continue;
      }
    } else if (text[i] !== '(') {
      out.push({ line, title: null });
      continue;
    }
    i++;
    while (/\s/.test(text[i] ?? '')) i++;
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(text, i);
      out.push({ line, title: end === -1 ? null : text.slice(i + 1, end - 1) });
    } else {
      out.push({ line, title: null });
    }
    call.lastIndex = Math.max(call.lastIndex, i);
  }
  return out;
}

function skipSpace(text: string, i: number): number {
  let j = i;
  while (j < text.length && /\s/.test(text[j] ?? '')) j++;
  return j;
}

/** A `/` at `i` starts a regular expression when the token before it cannot end an operand. */
function startsRegex(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j] ?? '')) j--;
  return j < 0 || /[(,=:[!&|?{};+\-*%<>~^]/.test(text[j] ?? '');
}

/** Index just after the regular expression literal starting at `start`, or -1. */
function skipRegex(text: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '\n') return -1;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '/') {
      let j = i + 1;
      while (/[a-z]/i.test(text[j] ?? '')) j++;
      return j;
    }
  }
  return -1;
}

/** Index just after the template literal starting at `start` (with `${…}` nesting), or -1. */
function skipTemplate(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '`') return i + 1;
    else if (c === '$' && text[i + 1] === '{') {
      const end = skipBalanced(text, i + 1);
      if (end === -1) return -1;
      i = end - 1;
    }
  }
  return -1;
}

/**
 * Index just after the comment, string, template or regular expression literal starting at
 * `i`; `i` itself when none starts there; -1 when it is not terminated.
 */
function skipTrivia(text: string, i: number): number {
  const c = text[i];
  if (c === '/' && text[i + 1] === '/') {
    const end = text.indexOf('\n', i);
    return end === -1 ? text.length : end;
  }
  if (c === '/' && text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2);
    return end === -1 ? -1 : end + 2;
  }
  if (c === "'" || c === '"') return skipString(text, i);
  if (c === '`') return skipTemplate(text, i);
  if (c === '/' && startsRegex(text, i)) return skipRegex(text, i);
  return i;
}

/** Index just after the bracket closing the `(`, `[` or `{` at `open`, or -1. */
function skipBalanced(text: string, open: number): number {
  const closers: string[] = [];
  for (let i = open; i < text.length; i++) {
    const end = skipTrivia(text, i);
    if (end === -1) return -1;
    if (end !== i) {
      i = end - 1;
      continue;
    }
    const c = text[i];
    if (c === '(') closers.push(')');
    else if (c === '[') closers.push(']');
    else if (c === '{') closers.push('}');
    else if (c === ')' || c === ']' || c === '}') {
      if (closers.pop() !== c) return -1;
      if (closers.length === 0) return i + 1;
    }
  }
  return -1;
}

/** Offsets of the top-level comma-separated parts of text[from, to); null when unbalanced. */
function splitTopLevel(text: string, from: number, to: number): [number, number][] | null {
  const parts: [number, number][] = [];
  let start = from;
  for (let i = from; i < to; i++) {
    const end = skipTrivia(text, i);
    if (end === -1 || end > to) return null;
    if (end !== i) {
      i = end - 1;
      continue;
    }
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') {
      const close = skipBalanced(text, i);
      if (close === -1 || close > to) return null;
      i = close - 1;
    } else if (c === ',') {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  parts.push([start, to]);
  return parts;
}

/** Offset of the first character of text[from, to) that is neither whitespace nor a comment. */
function partStart(text: string, from: number, to: number): number {
  let i = skipSpace(text, from);
  while (i < to && text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
    const end = skipTrivia(text, i);
    if (end === -1) return to;
    i = skipSpace(text, end);
  }
  return Math.min(i, to);
}

/** Names that call Vitest's test API: the roots and every `const x = <one of them>.extend(…)`. */
function testApiNames(text: string): Set<string> {
  const names = new Set(TEST_API_ROOTS);
  for (let grew = true; grew;) {
    grew = false;
    EXTENDED_TEST.lastIndex = 0;
    for (let m = EXTENDED_TEST.exec(text); m !== null; m = EXTENDED_TEST.exec(text)) {
      const [, name = '', base = ''] = m;
      if (names.has(base) && !names.has(name)) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

/** Every call in `text`: its root identifier and the parentheses of the last call of its chain. */
function callsIn(text: string): { root: string; open: number; close: number }[] {
  const out: { root: string; open: number; close: number }[] = [];
  const member = /^\.\s*[A-Za-z_$][\w$]*\s*/;
  CALL_ROOT.lastIndex = 0;
  for (let m = CALL_ROOT.exec(text); m !== null; m = CALL_ROOT.exec(text)) {
    const root = m[1] ?? '';
    if (NOT_A_CALLEE.has(root)) continue;
    let i = m.index + m[0].length;
    for (;;) {
      const tagged = text[i] === '`';
      const end = tagged ? skipTemplate(text, i) : text[i] === '(' ? skipBalanced(text, i) : -1;
      if (end === -1) break;
      const next = skipSpace(text, end);
      if (text[next] === '(' || text[next] === '`') {
        i = next;
        continue;
      }
      const chained = member.exec(text.slice(next, next + 200));
      if (chained !== null && /[(`]/.test(text[next + chained[0].length] ?? '')) {
        i = next + chained[0].length;
        continue;
      }
      if (!tagged) out.push({ root, open: i, close: end });
      break;
    }
  }
  return out;
}

/** Offset of the `{` of `const <name> = { … }` (also let / var, with a type annotation), or -1. */
function localObjectLiteral(text: string, name: string): number {
  const escaped = name.replace(/\$/g, '\\$');
  const m = new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*(?::[^=;]*)?=\\s*(?=\\{)`).exec(text);
  return m === null ? -1 : m.index + m[0].length;
}

/**
 * Vitest retry options in a test file that is not a funds or attribution test: a `retry` key
 * (other than an explicit 0) in the options object, the second argument of a test API call;
 * options the guard cannot read (a spread, a variable that is not an object literal of this
 * file); and the same `retry` key in a call shaped like a custom test function (title literal,
 * options object, function literal).
 */
function retryOptionFindings(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const report = (offset: number, message: string): void => {
    findings.push({ file, line: lineOfOffset(text, offset), rule: 'no-retry', message });
  };
  const checkOptions = (open: number, strict: boolean): void => {
    const close = skipBalanced(text, open);
    if (close === -1) return;
    for (const [from, to] of splitTopLevel(text, open + 1, close - 1) ?? []) {
      const start = partStart(text, from, to);
      const property = text.slice(start, to).trim();
      if (strict && property.startsWith('...')) {
        report(start, 'test options must not spread another object, so that retry can be checked');
        continue;
      }
      const retry = RETRY_PROPERTY.exec(property);
      if (retry === null || (retry[2] !== undefined && isZeroLiteral(retry[2].trim()))) continue;
      report(start, 'tests must not use retry');
    }
  };
  const api = testApiNames(text);
  for (const call of callsIn(text)) {
    const parts = splitTopLevel(text, call.open + 1, call.close - 1);
    if (parts === null) continue;
    const args = parts
      .map(([from, to]) => ({ from: partStart(text, from, to), to }))
      .filter(({ from, to }) => text.slice(from, to).trim() !== '');
    const [first, second, third] = args;
    if (second === undefined) continue;
    const isFunction = (arg: { from: number; to: number } | undefined): boolean =>
      arg !== undefined && FUNCTION_LITERAL.test(text.slice(arg.from, arg.to).trim());
    const isObject = text[second.from] === '{';
    if (!api.has(call.root)) {
      // A custom test function the guard cannot trace (for example an imported one).
      if (isObject && /^['"`]/.test(text[first?.from ?? -1] ?? '') && isFunction(third)) {
        checkOptions(second.from, false);
      }
      continue;
    }
    if (isObject) {
      checkOptions(second.from, true);
      continue;
    }
    // (title, fn) and (title, fn, timeout) carry no options; (title, x, () => {}) does.
    if (isFunction(second) || !isFunction(third)) continue;
    const name = text.slice(second.from, second.to).trim();
    const literal = /^[A-Za-z_$][\w$]*$/.test(name) ? localObjectLiteral(text, name) : -1;
    if (literal === -1) {
      report(
        second.from,
        'test options must be an object literal written in this file, so that retry can be checked',
      );
    } else {
      checkOptions(literal, true);
    }
  }
  return findings;
}

function scanTestFile(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const isInt = INT_TEST_FILE.test(file);
  const strictRetry = isFundsTestFile(file);
  text.split('\n').forEach((lineText, index) => {
    const line = index + 1;
    if (SKIP_OR_ONLY.test(lineText) || X_PREFIXED.test(lineText)) {
      findings.push({
        file,
        line,
        rule: 'no-skip-only',
        message: 'tests must not be skipped, focused or left as todo',
      });
    }
    const retry = strictRetry ? RETRY_KEY.exec(lineText) : null;
    if (
      strictRetry &&
      ((retry && !isZeroLiteral(retry[1] ?? '')) || RETRY_SHORTHAND.test(lineText))
    ) {
      findings.push({ file, line, rule: 'no-retry', message: 'tests must not use retry' });
    }
    const references = lineText.match(ADMIN_URL)?.length ?? 0;
    if (references > (lineText.match(ADMIN_URL_ABSENT)?.length ?? 0)) {
      findings.push({
        file,
        line,
        rule: 'admin-url-only-in-global-setup',
        message: 'TEST_PG_ADMIN_URL is read only by the global setup, never by a test file',
      });
    }
    if (isInt) return;
    if (LISTEN_CALL.test(lineText)) {
      findings.push({
        file,
        line,
        rule: 'unit-no-listen',
        message: 'unit tests must not listen on a port (use Fastify inject)',
      });
    }
    IMPORT_SPECIFIER.lastIndex = 0;
    for (let m = IMPORT_SPECIFIER.exec(lineText); m !== null; m = IMPORT_SPECIFIER.exec(lineText)) {
      const specifier = m[2] ?? '';
      if (isIntegrationOnly(specifier)) {
        findings.push({
          file,
          line,
          rule: 'unit-no-db',
          message: `unit tests must not import "${specifier}" (rename the file to *.int.test.ts)`,
        });
      }
    }
  });
  if (strictRetry) return findings;
  // Stable sort: findings of one line keep the order in which the rules are listed above.
  return [...findings, ...retryOptionFindings(file, text)].sort((a, b) => a.line - b.line);
}

function scanVitestConfig(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((lineText, index) => {
    const line = index + 1;
    const retry = RETRY_KEY.exec(lineText);
    if (retry && !isZeroLiteral(retry[1] ?? '')) {
      findings.push({
        file,
        line,
        rule: 'no-retry',
        message: 'vitest config must keep retry at 0',
      });
    }
    if (PASS_WITH_NO_TESTS.test(lineText)) {
      findings.push({
        file,
        line,
        rule: 'no-pass-with-no-tests',
        message: 'passWithNoTests must stay false',
      });
    }
    if (ALLOW_ONLY.test(lineText)) {
      findings.push({ file, line, rule: 'no-skip-only', message: 'allowOnly must stay false' });
    }
  });
  return findings;
}

function scanPackageJson(file: string, text: string): Finding[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [{ file, line: 1, rule: 'package-json', message: 'package.json is not valid JSON' }];
  }
  if (typeof doc !== 'object' || doc === null) return [];
  const scripts = (doc as Record<string, unknown>)['scripts'];
  if (typeof scripts !== 'object' || scripts === null) return [];
  const findings: Finding[] = [];
  const lines = text.split('\n');
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command !== 'string' || !BAD_SCRIPT_FLAG.test(command)) continue;
    const at = lines.findIndex((l) => l.includes(JSON.stringify(name)));
    findings.push({
      file,
      line: at === -1 ? 1 : at + 1,
      rule: 'no-pass-with-no-tests',
      message: `script "${name}" must not use --passWithNoTests, --retry or --allowOnly`,
    });
  }
  return findings;
}

function scanRuleTestFile(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((lineText, index) => {
    const line = index + 1;
    if (DESCRIBE_CALL.test(lineText)) {
      findings.push({
        file,
        line,
        rule: 'rule-tests-top-level-it',
        message: 'rule tests use top-level it(), never describe() (规划/11 §4.3)',
      });
    }
    MOCK_CALL.lastIndex = 0;
    for (let m = MOCK_CALL.exec(lineText); m !== null; m = MOCK_CALL.exec(lineText)) {
      const specifier = m[2] ?? '';
      if (isFundsCoreModule(specifier)) {
        findings.push({
          file,
          line,
          rule: 'rule-tests-no-funds-mock',
          message: `rule tests must not mock "${specifier}" (规划/11 §4.3)`,
        });
      }
    }
  });
  return findings;
}

function scanAcceptanceFile(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const { line, title } of testTitles(text)) {
    if (title === null) {
      findings.push({
        file,
        line,
        rule: 'acceptance-title',
        message: 'acceptance test titles must be string literals carrying [AC-...]',
      });
    } else if (!AC_TAG.test(title)) {
      findings.push({
        file,
        line,
        rule: 'acceptance-title',
        message: `acceptance test title lacks an [AC-...] id: "${title}"`,
      });
    }
  }
  return findings;
}

/** Static findings for one file; `text` is its content. */
export function scanFile(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const isTest = TEST_FILE.test(file);
  if (isTest) findings.push(...scanTestFile(file, text));
  if (VITEST_CONFIG.test(file)) findings.push(...scanVitestConfig(file, text));
  if (file === 'package.json' || file.endsWith('/package.json')) {
    findings.push(...scanPackageJson(file, text));
  }
  if (RULE_TEST_DIR.test(file) && SCRIPT_FILE.test(file)) {
    findings.push(...scanRuleTestFile(file, text));
  }
  if (ACCEPTANCE_DIR.test(file) && isTest) findings.push(...scanAcceptanceFile(file, text));
  return findings;
}

function isRelevant(file: string): boolean {
  return (
    TEST_FILE.test(file) ||
    VITEST_CONFIG.test(file) ||
    file === 'package.json' ||
    file.endsWith('/package.json') ||
    (RULE_TEST_DIR.test(file) && SCRIPT_FILE.test(file))
  );
}

/** Runs the static checks over the given repo-relative files of the tree at `root`. */
export function scanTree(root: string, files: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (!isRelevant(file)) continue;
    findings.push(...scanFile(file, readFileSync(join(root, file), 'utf8')));
  }
  return findings;
}

// Explicit timeouts of property tests (CT-06zzzm; orchestrator ruling D10-750, after #2511 and
// #2521, whose new property tests hit Vitest's default timeout of 15 s under verify-props with
// PROP_RUNS=100000): a test block (it / test with any chain: .each, .concurrent, .prop …; not
// describe) whose callback calls propParams() — directly, as an argument, as fc.assert's second
// argument — must register with an explicit timeout of at least PROP_TIMEOUT_MIN: its final call
// (for .each / .for the call after the table) has as third argument a number literal ≥ the
// minimum (`900_000` separators allowed) or an object literal whose `timeout` is one (no spread);
// Vitest's (title, options, callback) form counts with the options as that object. Anything else
// (missing, a name, a smaller number, an unreadable call) is a finding. Only in git mode
// (testGuardCheck with a base, guard-git): the test/spec/**/*.test.ts files the change adds,
// renames or leaves untracked are checked whole; a modified one only in its new or changed blocks
// (tools/guard/lib/test-blocks.ts compareTestFile; a file it judges as a whole, its code outside
// the tests changed, is checked whole). The main branch's existing property tests, frozen class 1
// files green in CI, are not checked after the fact; scanFile / the static mode never run it.

/** The least explicit timeout of a test calling propParams() (D10-750). */
export const PROP_TIMEOUT_MIN = 900_000;

const PROP_TIMEOUT_FILE = /^test\/spec\/.+\.test\.ts$/;
const PROP_TIMEOUT_FIX = 'propParams() 的用例须写显式超时 ≥ 900_000：补 `}, 900_000);`，见 D10-750';

// A call of propParams(): plain, spread (`...propParams()`) or through a namespace
// (`testing.propParams()`); a name that only ends in propParams is not.
const PROP_PARAMS_CALL = /^propParams\s*\(/;

/**
 * Whether `text` calls propParams() (directly, as an argument, spread into an object), outside
 * comments, strings and the static parts of template literals; a call inside a template's `${…}`
 * counts (Codex r1 S2). Text that cannot be read (an unterminated literal): read as is, so a call
 * is never missed.
 */
function callsPropParams(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    if (c === '`') {
      // The static parts are skipped, each `${…}` is searched on its own.
      let j = i + 1;
      for (; j < text.length && text[j] !== '`'; j++) {
        if (text[j] === '\\') {
          j++;
        } else if (text[j] === '$' && text[j + 1] === '{') {
          const end = skipBalanced(text, j + 1);
          if (end === -1) return /(?<![\w$])propParams\s*\(/.test(text.slice(j + 2));
          if (callsPropParams(text.slice(j + 2, end - 1))) return true;
          j = end - 1;
        }
      }
      if (j >= text.length) return /(?<![\w$])propParams\s*\(/.test(text.slice(i));
      i = j;
      continue;
    }
    const end = skipTrivia(text, i);
    if (end === -1) return /(?<![\w$])propParams\s*\(/.test(text.slice(i));
    if (end !== i) {
      i = end - 1;
      continue;
    }
    if (
      c === 'p' &&
      !/[\w$]/.test(text[i - 1] ?? '') &&
      PROP_PARAMS_CALL.test(text.slice(i, i + 40))
    ) {
      return true;
    }
  }
  return false;
}

/** `value` without the whitespace and comments around it (Codex r1 S2: a block comment after `900_000`). */
function withoutComments(value: string): string {
  let out = value.trim();
  for (let changed = true; changed;) {
    changed = false;
    const lead = /^(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))\s*/.exec(out);
    if (lead !== null && lead[0] !== '') {
      out = out.slice(lead[0].length);
      changed = true;
    }
    const block = /\s*\/\*(?:(?!\*\/)[\s\S])*\*\/$/.exec(out);
    const line = /\s*\/\/[^\n'"`]*$/.exec(out);
    const trail = block ?? line;
    if (trail !== null && trail[0] !== '') {
      out = out.slice(0, out.length - trail[0].length);
      changed = true;
    }
    out = out.trim();
  }
  return out;
}

/** The number of a number literal such as `900_000` (comments around it ignored), or null. */
function numberLiteral(value: string): number | null {
  const bare = withoutComments(value);
  return /^\d+(?:_\d+)*$/.test(bare) ? Number(bare.replace(/_/g, '')) : null;
}

/** Why the explicit timeout argument `arg` is not enough, or null when it is. */
function timeoutProblem(
  text: string,
  arg: { from: number; to: number } | undefined,
): string | null {
  if (arg === undefined) return 'no timeout argument';
  const value = withoutComments(text.slice(arg.from, arg.to));
  const n = numberLiteral(value);
  if (n !== null) return n >= PROP_TIMEOUT_MIN ? null : `the timeout ${value} is too small`;
  if (text[arg.from] !== '{') return `the timeout \`${value}\` is not a number literal`;
  const close = skipBalanced(text, arg.from);
  const props = close === -1 ? null : splitTopLevel(text, arg.from + 1, close - 1);
  if (props === null) return 'the options object cannot be read';
  let timeout: string | null = null;
  for (const [from, to] of props) {
    const property = text.slice(partStart(text, from, to), to).trim();
    if (property.startsWith('...')) return 'the options object spreads another object';
    const m = /^(?:timeout|'timeout'|"timeout")\s*:\s*([\s\S]*)$/.exec(property);
    if (m !== null) timeout = withoutComments(m[1] ?? '');
  }
  if (timeout === null) return 'the options object has no timeout';
  const t = numberLiteral(timeout);
  if (t === null) return `the timeout \`${timeout}\` is not a number literal`;
  return t >= PROP_TIMEOUT_MIN ? null : `the timeout ${timeout} is too small`;
}

/**
 * prop-timeout findings of one test file (see above): every block when `base` is null (a new
 * file), else the blocks compareTestFile says are new or changed.
 */
export function propTimeoutFindings(file: string, head: string, base: string | null): Finding[] {
  const findings: Finding[] = [];
  const report = (offset: number, why: string): void => {
    findings.push({
      file,
      line: lineOfOffset(head, offset),
      rule: 'prop-timeout',
      message: `${PROP_TIMEOUT_FIX} (${why})`,
    });
  };
  let spans: ReturnType<typeof testBlockSpans>;
  try {
    spans = testBlockSpans(head);
  } catch (err) {
    if (callsPropParams(head)) {
      report(0, `the test blocks cannot be read (${String(err)})`);
    }
    return findings;
  }
  let changed: boolean[] | null = null;
  if (base !== null) {
    const compared = compareTestFile(base, head);
    if (!compared.whole && compared.blocks.length === spans.length) {
      changed = compared.blocks.map((b) => b.changed);
    }
  }
  spans.forEach((span, i) => {
    if (changed !== null && changed[i] !== true) return;
    const parts = splitTopLevel(head, span.open + 1, span.close - 1);
    if (parts === null) {
      if (callsPropParams(head.slice(span.start, span.end))) {
        report(span.start, 'the call cannot be read');
      }
      return;
    }
    const args = parts
      .map(([from, to]) => ({ from: partStart(head, from, to), to }))
      .filter(({ from, to }) => head.slice(from, to).trim() !== '');
    const [, second, third] = args;
    // (title, callback, timeout) or (title, options, callback).
    const optionsFirst = second !== undefined && head[second.from] === '{' && third !== undefined;
    const callback = optionsFirst ? third : second;
    if (callback === undefined) return;
    const body = head.slice(callback.from, callback.to);
    if (!callsPropParams(body)) return;
    const why = timeoutProblem(head, optionsFirst ? second : third);
    if (why !== null) report(span.start, why);
  });
  return findings;
}

/**
 * prop-timeout findings of a change (git mode only, see above): `readBase` gives the base content
 * of a modified file (null: judged whole), `readHead` the head content (null: skipped).
 */
export function propTimeoutChecks(
  changes: readonly Change[],
  readBase: (path: string) => string | null,
  readHead: (path: string) => string | null,
): Finding[] {
  const findings: Finding[] = [];
  for (const change of changes) {
    if (change.status === 'D' || !PROP_TIMEOUT_FILE.test(change.path)) continue;
    const head = readHead(change.path);
    if (head === null) continue;
    const base = change.status === 'M' ? readBase(change.path) : null;
    findings.push(...propTimeoutFindings(change.path, head, base));
  }
  return findings;
}

/** Class-1 rule (规划/11 §4.4): existing test assets may not be modified, deleted or renamed. */
export function addOnlyViolations(
  changes: readonly Change[],
  cfg: ProtectedConfig,
): ProtectedHit[] {
  const none = { readBase: () => null, readWork: () => null };
  return findProtectedHits(changes, cfg, none).filter((hit) => hit.class === 1);
}
