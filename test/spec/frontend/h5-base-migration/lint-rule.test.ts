// DSX-47 (规划/05 §3.11.3, 编排 D10-837 ②): couli-style gains `no-raw-pressable` — on H5 page code a
// JSX `<button>`, or onClick on a native element that is not a link with href (div / li / span /
// section / a without href …), is reported once per element, on the line of its opening tag. The
// rule is syntactic. Scope: files under apps/h5/src/** except apps/h5/src/components/base/** (the
// base components are where native buttons live) and apps/h5/src/entries/conformance/**; nothing
// under apps/admin is reported. An intended non-interactive click (a scrim tap) is exempted with
// the existing `eslint-disable-next-line couli-style/no-raw-pressable -- <reason>`.
//
// The rule is tested on its own: lint/style/index.js is loaded directly and only its rules run
// (typescript-eslint parser, no eslint.config.js). eslint.config.js already turns every rule of
// `styleRules` on for H5 / admin sources, so exporting the rule there is all the wiring it needs.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Linter, type ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, it } from 'vitest';
import { APP_ENTRY, REPO, isUnder, readRepo, sourceFiles } from './support.ts';

const RULE_NAME = 'no-raw-pressable';
const RULE = `couli-style/${RULE_NAME}`;
const EXEMPTION = 'couli-style/exemption-reason';
const STYLE_MODULE = resolve(REPO, 'lint/style/index.js');
const BASELINE = 'lint/style/baseline.json';
const PAGE_PROBE = 'apps/h5/src/entries/app/pages/dsx47-probe/probe.tsx';
const TIMEOUT = 60_000;

interface StyleModule {
  plugin: ESLint.Plugin;
  styleRules: Record<string, unknown>;
}

/** Loads lint/style/index.js and asserts the rule exists before anything uses it. */
async function loadStyle(): Promise<StyleModule> {
  const loaded: unknown = await import(/* @vite-ignore */ pathToFileURL(STYLE_MODULE).href);
  const style = (loaded ?? {}) as {
    stylePlugin?: { rules?: Record<string, unknown> };
    styleRules?: Record<string, unknown>;
  };
  const rules = Object.keys(style.stylePlugin?.rules ?? {});
  expect(rules, `lint/style/index.js stylePlugin.rules has ${RULE_NAME}`).toContain(RULE_NAME);
  return {
    plugin: style.stylePlugin as unknown as ESLint.Plugin,
    styleRules: style.styleRules ?? {},
  };
}

const linter = new Linter({ cwd: REPO });

interface Report {
  ruleId: string | null;
  line: number;
}

/** Reports of `rules` (all as errors) for `code` linted as the repo-relative `path`. */
function lint(
  plugin: ESLint.Plugin,
  code: string,
  path: string,
  rules: readonly string[],
): Report[] {
  const config = [
    {
      files: ['**/*.ts', '**/*.tsx'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      linterOptions: { reportUnusedDisableDirectives: 'off' },
      plugins: { 'couli-style': plugin },
      rules: Object.fromEntries(rules.map((rule) => [rule, 'error'])),
    },
  ] as unknown as Linter.Config[];
  const messages = linter.verify(code, config, resolve(REPO, path));
  const broken = messages.filter(
    (message) => message.fatal === true || /No matching configuration/.test(message.message),
  );
  expect(
    broken.map((message) => message.message),
    `${path}: parse / config errors`,
  ).toEqual([]);
  return messages.map((message) => ({ ruleId: message.ruleId, line: message.line }));
}

function linesOf(reports: readonly Report[], ruleId: string): number[] {
  return reports
    .filter((report) => report.ruleId === ruleId)
    .map((report) => report.line)
    .sort((a, b) => a - b);
}

/** The 1-based line of `fragment`, which must occur on exactly one line of `code`. */
function lineOf(code: string, fragment: string): number {
  const hits = code
    .split('\n')
    .flatMap((line, index) => (line.includes(fragment) ? [index + 1] : []));
  expect(hits, `fixture fragment ${fragment} sits on exactly one line`).toHaveLength(1);
  return hits[0] ?? 0;
}

/** Eight raw pressables, one per line. */
const RAW = [
  "import { useState, type ReactElement } from 'react';",
  '',
  'export function Probe({ go }: { go: () => void }): ReactElement {',
  '  const [open, setOpen] = useState(false);',
  '  return (',
  '    <div className="flex">',
  '      <button type="button" onClick={go}>raw-button</button>',
  '      <button type="submit">raw-submit</button>',
  '      <div onClick={go}>raw-div</div>',
  '      <ul>',
  '        <li onClick={() => setOpen(!open)}>raw-li</li>',
  '      </ul>',
  '      <span role="button" tabIndex={0} onClick={go}>raw-span</span>',
  '      <a onClick={go}>raw-anchor</a>',
  '      <section onClick={go}>raw-section</section>',
  '      <button type="button" aria-label="raw-icon" onClick={go} />',
  '    </div>',
  '  );',
  '}',
  '',
].join('\n');
const RAW_FRAGMENTS = [
  'raw-button<',
  'raw-submit',
  'raw-div',
  'raw-li',
  'raw-span',
  'raw-anchor',
  'raw-section',
  'raw-icon',
] as const;

/** Clickables from the base components, a real link, touch / form handlers, a plain container. */
const CLEAN = [
  "import type { ReactElement, TouchEvent } from 'react';",
  "import { Button, Card, Chip, ListRow, Segmented } from '../../../../components/base/index.ts';",
  '',
  'export function Probe({',
  '  go,',
  '  touch,',
  '}: {',
  '  go: () => void;',
  '  touch: (event: TouchEvent) => void;',
  '}): ReactElement {',
  '  return (',
  '    <main onTouchStart={touch} onTouchMove={touch} onTouchEnd={go} onTouchCancel={go}>',
  '      <Button variant="text" onClick={go}>more</Button>',
  '      <Button variant="icon" aria-label="close" onClick={go}>x</Button>',
  '      <Card onClick={go}>card</Card>',
  '      <ListRow title="row" onClick={go} />',
  '      <Chip selected={false} onSelectedChange={go}>chip</Chip>',
  '      <Segmented aria-label="period" options={[]} value="a" onChange={go} />',
  '      <a href="https://example.invalid/help" onClick={go}>help</a>',
  '      <form onSubmit={go}>',
  '        <input aria-label="code" onChange={go} />',
  '      </form>',
  '      <div className="flex">plain</div>',
  '    </main>',
  '  );',
  '}',
  '',
].join('\n');

/** One exemption with a reason, one without. */
const EXEMPT = [
  "import type { ReactElement } from 'react';",
  '',
  'export function Probe({ go }: { go: () => void }): ReactElement {',
  '  return (',
  '    <div className="relative">',
  '      {/* eslint-disable-next-line couli-style/no-raw-pressable -- scrim tap closes the sheet; the close button is the accessible control */}',
  '      <div aria-hidden="true" className="absolute inset-0" onClick={go} />',
  '      {/* eslint-disable-next-line couli-style/no-raw-pressable */}',
  '      <div aria-hidden="true" className="absolute inset-0" onClick={go} />',
  '    </div>',
  '  );',
  '}',
  '',
].join('\n');

it('[AC-DSX-47-LINT#1] couli-style 插件导出 no-raw-pressable，并在 styleRules 里以 error 开启', async () => {
  const { styleRules } = await loadStyle();
  expect(styleRules[RULE]).toBe('error');
});

it('[AC-DSX-47-LINT#2] H5 页面里的 <button>、挂 onClick 的 div / li / span / section / 无 href 的 a 每处报一次，报在开标签那一行', async () => {
  const { plugin } = await loadStyle();
  const reports = lint(plugin, RAW, PAGE_PROBE, [RULE]);
  const expected = RAW_FRAGMENTS.map((fragment) => lineOf(RAW, fragment)).sort((a, b) => a - b);
  expect(linesOf(reports, RULE)).toEqual(expected);
});

it('[AC-DSX-47-LINT#3] 基础件（Button / Card / ListRow / Chip / Segmented）、带 href 的链接、触摸与表单事件、无 onClick 的容器都不报', async () => {
  const { plugin } = await loadStyle();
  expect(linesOf(lint(plugin, CLEAN, PAGE_PROBE, [RULE]), RULE)).toEqual([]);
});

it('[AC-DSX-47-LINT#4] 作用范围：apps/h5/src 下的页面代码报；components/base、conformance 入口与 apps/admin 下同样的代码不报', async () => {
  const { plugin } = await loadStyle();
  const expected = RAW_FRAGMENTS.length;
  const reported = [
    PAGE_PROBE,
    'apps/h5/src/entries/app/dsx47-probe.tsx',
    'apps/h5/src/entries/app/pages/help/dsx47-probe.tsx',
  ];
  for (const path of reported) {
    expect(linesOf(lint(plugin, RAW, path, [RULE]), RULE), path).toHaveLength(expected);
  }
  const quiet = [
    'apps/h5/src/components/base/Dsx47Probe.tsx',
    // lint-style-web lints committed files again at a sibling __lint_style_raw__ path.
    'apps/h5/src/components/base/__lint_style_raw__/Dsx47Probe.tsx',
    'apps/h5/src/entries/conformance/dsx47-probe.tsx',
    'apps/admin/src/pages/dsx47-probe/Probe.tsx',
    'apps/admin/src/components/dsx47-probe/Probe.tsx',
  ];
  for (const path of quiet) {
    expect(linesOf(lint(plugin, RAW, path, [RULE]), RULE), path).toEqual([]);
  }
});

it('[AC-DSX-47-LINT#5] 有理由的 eslint-disable-next-line couli-style/no-raw-pressable -- 理由 可豁免（如遮罩点击），无理由的豁免由 exemption-reason 报出', async () => {
  const { plugin } = await loadStyle();
  const reports = lint(plugin, EXEMPT, PAGE_PROBE, [RULE, EXEMPTION]);
  expect(linesOf(reports, RULE)).toEqual([]);
  expect(linesOf(reports, EXEMPTION)).toEqual([lineOf(EXEMPT, 'couli-style/no-raw-pressable */}')]);
});

it(
  '[AC-DSX-47-LINT#6] 迁移后 apps/h5/src/entries/app 下每个源码文件按该规则 0 报，baseline.json 也不给这些文件留额度',
  async () => {
    const { plugin } = await loadStyle();
    const left: string[] = [];
    for (const file of sourceFiles(APP_ENTRY)) {
      for (const line of linesOf(lint(plugin, readRepo(file), file, [RULE]), RULE)) {
        left.push(`${file}:${line}`);
      }
    }
    expect(left, `${RULE} reports in ${APP_ENTRY}`).toEqual([]);
    const baseline = JSON.parse(readRepo(BASELINE)) as Record<string, Record<string, unknown>>;
    const allowances = Object.entries(baseline[RULE] ?? {}).filter(([file]) =>
      isUnder(file, APP_ENTRY),
    );
    expect(allowances, `${BASELINE} allowances of ${RULE} in ${APP_ENTRY}`).toEqual([]);
  },
  TIMEOUT,
);
