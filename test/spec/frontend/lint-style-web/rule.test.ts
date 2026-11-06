// F1-01w (LINT-STYLE-web, 规划/05 §3.11.3, D10-643 ⑧): the style rules in eslint.config.js report
// hard-coded styles in apps/h5 and apps/admin page code: Tailwind arbitrary values, small text in
// text-couli-brand-primary, numeric fontSize / borderRadius / margin* / padding* and hex colours in
// style objects and TSX, and hex colours passed to ui.setNavBar. Each fixture mixes counterexamples
// (their lines must be reported) with token-based code (its lines must stay silent); the reported
// lines must equal the counterexample lines exactly. Contract: see ./support.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  ADMIN_PROBE,
  H5_NAV_BAR_PROBE,
  H5_PROBE,
  REPO,
  TIMEOUT,
  isError,
  lineOf,
  linesFor,
  linesOf,
  lintAs,
  readBaseline,
  styleRulesFor,
} from './support.ts';

const ARBITRARY = [
  "import type { ReactElement } from 'react';",
  '',
  "const DISPLAY = 'text-[2rem] leading-couli-display font-couli-bold';",
  "const TOKENS = 'text-couli-title leading-couli-title px-couli-4 py-couli-2 rounded-couli-card';",
  '',
  'export function Probe(): ReactElement {',
  '  return (',
  '    <main className="-mx-couli-4 flex min-h-11 basis-1/2 flex-col gap-couli-3 px-couli-4">',
  '      <p className="text-[13px] text-couli-text-primary">a</p>',
  '      <div className="mt-[7px] h-8" />',
  '      <div className="rounded-[6px] bg-couli-background-surface" />',
  '      <p className={`${TOKENS} p-[3px]`}>b</p>',
  '      <p className={TOKENS}>c</p>',
  '      <p className={DISPLAY}>d</p>',
  '    </main>',
  '  );',
  '}',
  '',
].join('\n');

const SMALL_BRAND = [
  "import type { ReactElement } from 'react';",
  '',
  "const CAPTION_BRAND = 'text-couli-caption leading-couli-caption text-couli-brand-primary';",
  "const FOOTNOTE_LINK = 'text-couli-footnote leading-couli-footnote text-couli-text-link';",
  "const FOOTNOTE_EMPHASIS = 'text-couli-footnote font-couli-medium text-couli-brand-emphasis';",
  "const HEADING_BRAND = 'text-couli-heading font-couli-bold text-couli-brand-primary';",
  "const SOLID_BRAND = 'bg-couli-brand-primary text-couli-footnote text-couli-text-inverse';",
  '',
  'export function Probe(): ReactElement {',
  '  return (',
  '    <div className="flex flex-col gap-couli-2">',
  '      <span className="text-couli-footnote font-couli-medium text-couli-brand-primary">a</span>',
  '      <span className={CAPTION_BRAND}>b</span>',
  '      <a className={FOOTNOTE_LINK} href="#top">',
  '        c',
  '      </a>',
  '      <span className={FOOTNOTE_EMPHASIS}>d</span>',
  '      <h2 className={HEADING_BRAND}>e</h2>',
  '      <span className={SOLID_BRAND}>f</span>',
  '    </div>',
  '  );',
  '}',
  '',
].join('\n');

const NUMERIC = [
  "import type { CSSProperties, ReactElement } from 'react';",
  "import { tokenTheme } from '@couli/ui-tokens';",
  '',
  'const TOKENS: CSSProperties = {',
  '  fontSize: tokenTheme.font.size.footnote,',
  "  padding: tokenTheme.space['4'],",
  '  borderRadius: tokenTheme.radius.card,',
  "  marginBlock: 'var(--space-2)',",
  '};',
  'const LAYOUT: CSSProperties = { flex: 1, zIndex: 2, opacity: 0.5 };',
  'const HARD: CSSProperties = { fontSize: 15 };',
  '',
  'export function Probe(): ReactElement {',
  '  return (',
  '    <div style={TOKENS}>',
  '      <p style={{ fontSize: 13 }}>a</p>',
  '      <div style={{ borderRadius: 6 }} />',
  '      <div style={{ padding: 16 }} />',
  '      <div style={{ marginTop: 4 }} />',
  '      <div style={{ paddingInline: 12 }} />',
  '      <div style={{ margin: -8 }} />',
  '      <div style={LAYOUT} />',
  '      <div style={HARD} />',
  '    </div>',
  '  );',
  '}',
  '',
].join('\n');

const HEX = [
  "import type { CSSProperties, ReactElement } from 'react';",
  '',
  "const BORDER: CSSProperties = { borderColor: '#E4DED5' };",
  "const BRAND = '#C44820';",
  "const ROUTE = '#/orders';",
  "const ANCHOR = '#top';",
  '',
  'export function Probe(): ReactElement {',
  '  return (',
  '    <div style={BORDER}>',
  "      <p style={{ color: '#C44820' }}>a</p>",
  "      <div style={{ backgroundColor: '#fff' }} />",
  "      <div style={{ border: '1px solid #E4DED5' }} />",
  "      <div style={{ outlineColor: '#28251F80' }} />",
  '      <svg aria-hidden="true" viewBox="0 0 1 1">',
  '        <path fill="#c44820" d="M0 0h1v1z" />',
  '      </svg>',
  '      <a href={ANCHOR}>b</a>',
  '      <a href={ROUTE}>c</a>',
  '      <a href="#main">d</a>',
  '      <span style={{ color: BRAND }}>e</span>',
  "      <span style={{ color: 'var(--color-text-link)' }}>f</span>",
  '    </div>',
  '  );',
  '}',
  '',
].join('\n');

const NAV_BAR = [
  "import { call, has } from '@couli/bridge-sdk';",
  '',
  'export function paintNavBar(): void {',
  "  const cap = has('ui.setNavBar');",
  '  if (cap === null) return;',
  '  void call(cap, {',
  "    title: 'Probe',",
  "    bg_color: '#FFFFFF',",
  "    text_color: '#28251F',",
  "    bg_gradient: ['#F2EEE6', '#FBEFE8'],",
  "    status_bar_style: 'dark',",
  '  });',
  '}',
  '',
  'export function paintNavBarFrom(background: string, text: string): void {',
  "  const cap = has('ui.setNavBar');",
  '  if (cap === null) return;',
  '  void call(cap, { bg_color: background, text_color: text });',
  '}',
  '',
].join('\n');

const ADMIN = [
  "import { Tag, Typography, theme } from 'antd';",
  "import type { ReactElement } from 'react';",
  '',
  'export function Probe(): ReactElement {',
  '  const { token } = theme.useToken();',
  '  const secondary = { color: token.colorTextSecondary, fontSize: token.fontSizeSM } as const;',
  '  const hardSecondary = { color: token.colorTextSecondary, fontSize: 12 } as const;',
  '  return (',
  '    <div style={{ padding: token.padding, borderRadius: token.borderRadiusLG }}>',
  '      <Typography.Text style={{ fontSize: 12 }}>a</Typography.Text>',
  '      <Typography.Text style={{ fontSize: token.fontSizeSM }}>b</Typography.Text>',
  '      <span style={secondary}>c</span>',
  '      <span style={hardSecondary}>d</span>',
  '      <div style={{ padding: 16 }} />',
  '      <div style={{ borderRadius: 8 }} />',
  '      <div style={{ marginBottom: token.marginSM }} />',
  '      <Tag color="#C44820">e</Tag>',
  '      <p className="text-[13px]">f</p>',
  '    </div>',
  '  );',
  '}',
  '',
].join('\n');

it(
  '[AC-F1-01w-LINT#1] H5 的 Tailwind 任意值（text-[13px]、text-[2rem]、mt-[7px]、rounded-[6px]、模板串里的 p-[3px]）报错，令牌类名不报',
  async () => {
    const reports = await lintAs(ARBITRARY, H5_PROBE);
    expect(linesOf(reports)).toEqual(
      linesFor(ARBITRARY, ['text-[2rem]', 'text-[13px]', 'mt-[7px]', 'rounded-[6px]', 'p-[3px]']),
    );
  },
  TIMEOUT,
);

it(
  '[AC-F1-01w-LINT#2] 小字（caption / footnote）用 text-couli-brand-primary 报错；text-link、brand-emphasis、大标题、品牌色作底不报',
  async () => {
    const reports = await lintAs(SMALL_BRAND, H5_PROBE);
    expect(linesOf(reports)).toEqual(
      linesFor(SMALL_BRAND, ['CAPTION_BRAND = ', 'text-couli-brand-primary">a']),
    );
  },
  TIMEOUT,
);

it(
  '[AC-F1-01w-LINT#3] style 对象里数字 fontSize / borderRadius / margin* / padding* 报错（含负数与具名常量），令牌值与非尺寸数字不报',
  async () => {
    const reports = await lintAs(NUMERIC, H5_PROBE);
    expect(linesOf(reports)).toEqual(
      linesFor(NUMERIC, [
        'fontSize: 15',
        'fontSize: 13',
        'borderRadius: 6',
        'padding: 16',
        'marginTop: 4',
        'paddingInline: 12',
        'margin: -8',
      ]),
    );
  },
  TIMEOUT,
);

it(
  '[AC-F1-01w-LINT#4] TSX 与 style 里的 hex 色值（3 / 6 / 8 位、嵌在边框简写里、SVG 属性、bg-[#…]）报错，锚点与路由的 # 不报',
  async () => {
    const reports = await lintAs(HEX, H5_PROBE);
    expect(linesOf(reports)).toEqual(
      linesFor(HEX, [
        "borderColor: '#E4DED5'",
        "BRAND = '#C44820'",
        "{ color: '#C44820' }",
        "backgroundColor: '#fff'",
        '1px solid #E4DED5',
        "outlineColor: '#28251F80'",
        'fill="#c44820"',
      ]),
    );
    const arbitraryHex = [
      "import type { ReactElement } from 'react';",
      '',
      'export function Probe(): ReactElement {',
      '  return <div className="bg-[#FBEFE8] px-couli-4" />;',
      '}',
      '',
    ].join('\n');
    expect(linesOf(await lintAs(arbitraryHex, H5_PROBE))).toEqual([4]);
  },
  TIMEOUT,
);

it(
  '[AC-F1-01w-LINT#5] 传给 ui.setNavBar 的 hex 色值（bg_color、text_color、bg_gradient）报错，传入变量不报',
  async () => {
    const reports = await lintAs(NAV_BAR, H5_NAV_BAR_PROBE);
    expect(linesOf(reports)).toEqual(
      linesFor(NAV_BAR, ["bg_color: '#FFFFFF'", "text_color: '#28251F'", 'bg_gradient: [']),
    );
  },
  TIMEOUT,
);

it(
  '[AC-F1-01w-LINT#6] 后台页面里 fontSize: 12（style 与样式常量）、数字 padding / borderRadius、hex、任意值报错，token.fontSizeSM 等 antd 令牌不报',
  async () => {
    const reports = await lintAs(ADMIN, ADMIN_PROBE);
    expect(linesOf(reports)).toEqual(
      linesFor(ADMIN, [
        'fontSize: 12 } as const',
        'style={{ fontSize: 12 }}',
        'padding: 16',
        'borderRadius: 8',
        'color="#C44820"',
        'text-[13px]',
      ]),
    );
  },
  TIMEOUT,
);

it(
  '[AC-F1-01w-LINT#7] 写了 eslint-disable-next-line 豁免注释（带理由）的任意值不报，豁免只管下一行',
  async () => {
    const plain = [
      "export const DISPLAY = 'text-[2rem] leading-couli-display';",
      "export const OTHER = 'text-[15px] leading-couli-body';",
      '',
    ].join('\n');
    const reports = await lintAs(plain, H5_PROBE);
    expect(linesOf(reports)).toEqual([1, 2]);
    const ids = [...new Set(reports.filter((r) => r.line === 1).map((r) => r.ruleId))].sort();
    const exempted = [
      `// eslint-disable-next-line ${ids.join(', ')} -- 邀请码大号数字，设计稿例外`,
      plain,
    ].join('\n');
    expect(linesOf(await lintAs(exempted, H5_PROBE))).toEqual([3]);

    const jsx = (comment: string): string =>
      [
        "import type { ReactElement } from 'react';",
        '',
        'export function Probe(): ReactElement {',
        '  return (',
        '    <div>',
        `      {/* ${comment} */}`,
        '      <p className="text-[2rem] leading-couli-display">a</p>',
        '      <p className="text-[2rem] leading-couli-body">b</p>',
        '    </div>',
        '  );',
        '}',
        '',
      ].join('\n');
    const open = jsx('no exemption here');
    const jsxReports = await lintAs(open, H5_PROBE);
    const first = lineOf(open, 'leading-couli-display">a');
    const second = lineOf(open, 'leading-couli-body">b');
    expect(linesOf(jsxReports)).toEqual([first, second]);
    const jsxIds = [...new Set(jsxReports.filter((r) => r.line === first).map((r) => r.ruleId))];
    const closed = jsx(`eslint-disable-next-line ${jsxIds.sort().join(', ')} -- 设计稿例外`);
    expect(linesOf(await lintAs(closed, H5_PROBE))).toEqual([second]);
  },
  TIMEOUT,
);

it(
  '[AC-F1-01w-LINT#8] eslint.config.js 引用 lint/style 下的规则，对 H5 与后台源码全部以 error 开启；基线里的规则都已开启',
  async () => {
    const config = readFileSync(join(REPO, 'eslint.config.js'), 'utf8');
    expect(
      /\bfrom\s+['"]\.\/lint\/style\/[^'"]+['"]/.test(config),
      'eslint.config.js imports from ./lint/style/',
    ).toBe(true);
    const real = [
      'apps/h5/src/entries/app/pages/earnings/earnings-page.tsx',
      'apps/h5/src/components/base/Toast.tsx',
      'apps/h5/src/shared/texts.ts',
      'apps/admin/src/pages/orders/OrdersPage.tsx',
      'apps/admin/src/components/step-up/StepUpModal.tsx',
      'apps/admin/src/theme.ts',
    ];
    const enabled: Record<string, string[]> = {};
    const errors: Record<string, string[]> = {};
    for (const path of real) {
      const rules = await styleRulesFor(path);
      const on = [...rules.keys()].sort();
      const asErrors = [...rules].filter(([, setting]) => isError(setting)).map(([id]) => id);
      enabled[path] = on;
      errors[path] = asErrors.sort();
      expect(on.length, `${path}: couli-style rules are on`).toBeGreaterThan(0);
    }
    expect(errors, 'every couli-style rule is an error').toEqual(enabled);
    const missing: string[] = [];
    for (const [rule, files] of readBaseline()) {
      for (const file of files.keys()) {
        const rules = await styleRulesFor(file);
        if (!isError(rules.get(rule))) missing.push(`${file}: ${rule}`);
      }
    }
    expect(missing, 'baseline rules are on for their files').toEqual([]);
  },
  TIMEOUT,
);
