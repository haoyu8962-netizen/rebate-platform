// F1-01w (LINT-STYLE-web, 规划/05 §3.11.3, D10-643 ⑧) test support for the style lint rules and
// their baseline. Nothing here imports lint/style: every check goes through eslint.config.js, the
// way `pnpm lint` runs it. The contract the implementation is held to:
//   - eslint.config.js loads the rules from lint/style/** and turns each of them on as an error,
//     under the `couli-style/` namespace, for apps/h5/src/**/*.{ts,tsx} and
//     apps/admin/src/**/*.{ts,tsx};
//   - the rules are syntactic (they run with type-aware parsing switched off, as here) and report
//     on the line of the offending literal or property;
//   - the exemption comment is ESLint's own `eslint-disable-next-line <rule id> -- <reason>`;
//   - lint/style/baseline.json maps rule id (`couli-style/…`) → repo-relative POSIX path of a file
//     under apps/h5/src or apps/admin/src → positive integer count. Linting a file tolerates up to
//     that many reports of that rule in that file and fails with more. Any path that is not in the
//     baseline (a fixture, or a copy of a real file at another path) gets every report.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import { expect } from 'vitest';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const PREFIX = 'couli-style/';
export const BASELINE = 'lint/style/baseline.json';
export const APP_ROOTS = ['apps/h5/src', 'apps/admin/src'] as const;
export const H5_PROBE = 'apps/h5/src/entries/app/pages/lint-style-probe/probe.tsx';
export const H5_NAV_BAR_PROBE = 'apps/h5/src/entries/app/lint-style-probe/nav-bar.ts';
export const ADMIN_PROBE = 'apps/admin/src/pages/lint-style-probe/Probe.tsx';
export const TIMEOUT = 120_000;
export const SCAN_TIMEOUT = 900_000;

// Only the style rules run, with the entries eslint.config.js gives each path. Fixture paths do
// not exist on disk, so type-aware parsing is switched off (as in test/spec/orders/
// platform-literal-lint), and the rules must not need type information.
const eslint = new ESLint({
  cwd: REPO,
  overrideConfigFile: join(REPO, 'eslint.config.js'),
  overrideConfig: { languageOptions: { parserOptions: { projectService: false } } },
  ruleFilter: ({ ruleId }) => ruleId.startsWith(PREFIX),
});

export interface Report {
  ruleId: string;
  line: number;
  message: string;
}

function isStyleMessage(
  message: Linter.LintMessage,
): message is Linter.LintMessage & { ruleId: string } {
  return typeof message.ruleId === 'string' && message.ruleId.startsWith(PREFIX);
}

/** Style-rule reports for `code` linted as the repo-relative `path` (the code must parse). */
export async function lintAs(code: string, path: string): Promise<Report[]> {
  const results = await eslint.lintText(code, { filePath: join(REPO, path) });
  const messages = results.flatMap((result) => result.messages);
  expect(
    messages.filter((message) => message.fatal === true).map((message) => message.message),
    `${path}: parse errors`,
  ).toEqual([]);
  return messages
    .filter(isStyleMessage)
    .map((message) => ({ ruleId: message.ruleId, line: message.line, message: message.message }));
}

/** Sorted distinct lines of the reports. */
export function linesOf(reports: readonly Report[]): number[] {
  return [...new Set(reports.map((report) => report.line))].sort((a, b) => a - b);
}

/** The 1-based line of `fragment`, which must occur on exactly one line of `code`. */
export function lineOf(code: string, fragment: string): number {
  const hits = code
    .split('\n')
    .flatMap((line, index) => (line.includes(fragment) ? [index + 1] : []));
  expect(hits, `fixture fragment ${fragment} sits on exactly one line`).toHaveLength(1);
  return hits[0] ?? 0;
}

/** Sorted distinct lines of the fragments. */
export function linesFor(code: string, fragments: readonly string[]): number[] {
  return [...new Set(fragments.map((fragment) => lineOf(code, fragment)))].sort((a, b) => a - b);
}

/** Style rules in the effective eslint.config.js config of a repo-relative path. */
export async function styleRulesFor(path: string): Promise<Map<string, unknown>> {
  const config = (await eslint.calculateConfigForFile(join(REPO, path))) as
    { rules?: Record<string, unknown> } | undefined;
  return new Map(Object.entries(config?.rules ?? {}).filter(([id]) => id.startsWith(PREFIX)));
}

export function isError(setting: unknown): boolean {
  const level: unknown = Array.isArray(setting) ? (setting as unknown[])[0] : setting;
  return level === 2 || level === 'error';
}

// --- the app sources ---------------------------------------------------------------------------

const NOT_SOURCE = /\.(?:test|spec)\.tsx?$|\.gen\.ts$|\.d\.ts$/;

/** Repo-relative POSIX paths of the non-test .ts / .tsx sources of apps/h5 and apps/admin. */
export function sourceFiles(): string[] {
  const out: string[] = [];
  for (const root of APP_ROOTS) {
    const absolute = resolve(REPO, root);
    expect(existsSync(absolute), root).toBe(true);
    for (const entry of readdirSync(absolute, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = relative(REPO, join(entry.parentPath, entry.name)).split(sep).join('/');
      if (/\.tsx?$/.test(path) && !NOT_SOURCE.test(path)) out.push(path);
    }
  }
  return out.sort();
}

export function readRepo(path: string): string {
  return readFileSync(resolve(REPO, path), 'utf8');
}

/** A sibling path of `file` that is not in the baseline, so linting there reports everything. */
export function rawPath(file: string): string {
  return posix.join(posix.dirname(file), '__lint_style_raw__', posix.basename(file));
}

export interface Linted {
  file: string;
  reports: Report[];
}

let raw: Promise<Linted[]> | undefined;

/** Every app source file linted in full (its committed text at `rawPath`), computed once. */
export function rawReports(): Promise<Linted[]> {
  raw ??= (async () => {
    const out: Linted[] = [];
    for (const file of sourceFiles()) {
      out.push({ file, reports: await lintAs(readRepo(file), rawPath(file)) });
    }
    return out;
  })();
  return raw;
}

// --- the baseline ------------------------------------------------------------------------------

/** rule id → file → tolerated count. */
export type Baseline = Map<string, Map<string, number>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads lint/style/baseline.json, asserting its shape. */
export function readBaseline(): Baseline {
  const path = resolve(REPO, BASELINE);
  expect(existsSync(path), `${BASELINE} is committed`).toBe(true);
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(existsSync(path) ? readFileSync(path, 'utf8') : '');
  } catch {
    parsed = undefined;
  }
  expect(isRecord(parsed), `${BASELINE} is a JSON object: rule id → file → count`).toBe(true);
  const baseline: Baseline = new Map();
  for (const [rule, files] of Object.entries(isRecord(parsed) ? parsed : {})) {
    expect(rule.startsWith(PREFIX), `${BASELINE}: rule id ${rule} starts with ${PREFIX}`).toBe(
      true,
    );
    expect(isRecord(files), `${BASELINE}: ${rule} maps files to counts`).toBe(true);
    const counts = new Map<string, number>();
    for (const [file, count] of Object.entries(isRecord(files) ? files : {})) {
      const valid = typeof count === 'number' && Number.isInteger(count) && count > 0;
      expect(valid, `${BASELINE}: ${rule} → ${file} is a positive integer`).toBe(true);
      expect(
        APP_ROOTS.some((root) => file.startsWith(`${root}/`)) && !file.includes('\\'),
        `${BASELINE}: ${file} is a repo-relative POSIX path under apps/h5/src or apps/admin/src`,
      ).toBe(true);
      expect(existsSync(resolve(REPO, file)), `${BASELINE}: ${file} exists`).toBe(true);
      counts.set(file, typeof count === 'number' ? count : 0);
    }
    baseline.set(rule, counts);
  }
  return baseline;
}

/** `file: rule count > allowed` for every rule whose reports in a file exceed the baseline. */
export function overBaseline(linted: readonly Linted[], baseline: Baseline): string[] {
  const over: string[] = [];
  for (const { file, reports } of linted) {
    const counts = new Map<string, number>();
    for (const report of reports) counts.set(report.ruleId, (counts.get(report.ruleId) ?? 0) + 1);
    const rules = [...counts.keys()].sort((a, b) => a.localeCompare(b));
    for (const rule of rules) {
      const count = counts.get(rule) ?? 0;
      const allowed = baseline.get(rule)?.get(file) ?? 0;
      if (count > allowed) over.push(`${file}: ${rule} ${count} > baseline ${allowed}`);
    }
  }
  return over;
}
