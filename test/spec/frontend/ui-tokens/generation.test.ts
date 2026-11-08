import { generateTailwindCss, generateThemeTs, themeFromTokens } from '@couli/ui-tokens';
import { format } from 'prettier';
import { expect, it } from 'vitest';
import {
  baseline,
  baselineDeclarations,
  block,
  declarations,
  pin,
  record,
  rootDeclarations,
  themeLeaves,
  tokenLeaves,
  withoutComments,
} from './kit.ts';
import {
  darkBlocks,
  expectValueTheme,
  generatedCss as generateTokensCss,
  serializedExports,
  succeeds,
} from './dark-kit.ts';

it('[AC-CT-11a#3] CSS 的每个叶子令牌与规划 :root 的变量名、值逐项一致', () => {
  const input = baseline();
  const actual = rootDeclarations(generateTokensCss(input));
  expect(actual).toEqual(baselineDeclarations());
  expect([...actual.keys()].filter((key) => key.startsWith('--')).sort()).toEqual(
    tokenLeaves(input.tokens)
      .map(([name]) => name)
      .sort(),
  );
});

it('[AC-CT-11a#4] 代表值覆盖新背景、语义颜色、字号、字体、单位、阴影和焦点', () => {
  const actual = rootDeclarations(generateTokensCss(baseline()));
  // Expected values copied verbatim from planning variables.css at SOURCE_COMMIT.
  for (const [name, value] of Object.entries({
    '--color-background-canvas': '#F2EEE6',
    '--color-background-admin-canvas': '#F6F3ED',
    '--color-background-placeholder': '#E9E2D9',
    '--color-rebate-text': '#A83B1F',
    '--color-price-text': '#28251F',
    '--color-status-pending-text': '#655E57',
    '--color-source-background': '#FFFFFF',
    '--font-family-system':
      'system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
    '--font-size-body': '1.0625rem',
    '--font-line-height-body': '1.5',
    '--font-weight-semibold': '600',
    '--space-0': '0px',
    '--space-4': '16px',
    '--radius-card': '16px',
    '--shadow-none': 'none',
    '--shadow-card': '0px 2px 8px 0px rgba(40, 37, 31, 0.06)',
    '--focus-width': '2px',
    '--interaction-target-minimum': '44px',
    '--component-control-border-width': '1px',
  })) {
    expect(actual.get(name), name).toBe(value);
  }
});

it('[AC-CT-11a#5] 浅色基准不再强制 only light，并提供系统与显式深色覆盖', () => {
  const css = withoutComments(generateTokensCss(baseline()));
  expect(rootDeclarations(css).get('color-scheme')).toBe('light');
  expect(css).not.toContain('only light');
  const [system, explicit] = darkBlocks(css);
  expect(system).toEqual(explicit);
  expect(system.get('color-scheme')).toBe('dark');
});

it('[AC-CT-11a#6] Tailwind 4 主题使用有效命名空间并引用全部令牌，不能自引用', () => {
  const branch = pin().version;
  const input = baseline();
  const css = succeeds(() => generateTailwindCss(input));
  const aliases = declarations(block(css, /@theme(?:\s+(?:inline|static))*\s*\{([^{}]*)\}/g));
  const leaves = tokenLeaves(input.tokens);
  expect([...aliases.values()].sort()).toEqual(leaves.map(([name]) => `var(${name})`).sort());
  // Alias names are implementation choices; namespaces must generate the relevant utilities.
  for (const [alias, value] of aliases) {
    expect(alias).toMatch(/^--[a-z0-9-]+$/);
    expect(value).not.toBe(`var(${alias})`);
    const source = value.slice(4, -1);
    const type = leaves.find(([name]) => name === source)?.[1];
    const namespace: Record<string, string> = {
      color: '--color-',
      fontFamily: '--font-',
      fontSize: '--text-',
      lineHeight: '--leading-',
      fontWeight: '--font-weight-',
      shadow: '--shadow-',
      dimension: source.startsWith('--radius-') ? '--radius-' : '--spacing-',
    };
    if (branch === '0.5.2') {
      // v0.5.2 (DSX-48): easings feed Tailwind 4's ease-* utilities.
      namespace.cubicBezier = '--ease-';
    }
    expect(type).toBeDefined();
    if (branch === '0.5.1') {
      if (type !== 'number') expect(alias.startsWith(namespace[type!]!), alias).toBe(true);
    } else {
      expect(branch).toBe('0.5.2');
      // Tailwind 4 has no theme namespace for plain numbers or durations (duration-* takes numbers).
      if (type !== 'number' && type !== 'duration')
        expect(alias.startsWith(namespace[type!]!), alias).toBe(true);
    }
  }
});

it('[AC-CT-11a#7] TS 主题每个叶子只引用一个 CSS 令牌，覆盖全部令牌', () => {
  const input = baseline();
  expect(themeLeaves(themeFromTokens(input)).sort()).toEqual(
    tokenLeaves(input.tokens)
      .map(([name]) => `var(${name})`)
      .sort(),
  );
  // Preserve the CSS-reference theme and additionally expose resolved dark values.
  const css = generateTokensCss(input);
  const dark = new Map([...rootDeclarations(css), ...darkBlocks(css)[0]]);
  expectValueTheme(serializedExports(generateThemeTs(input)), input, 'dark', dark);
});

it('[AC-CT-11a#8] 生成器使用入参中的值和新增令牌，不能硬编码固定快照', () => {
  const input = baseline();
  const brand = record(record(input.tokens.color).brand);
  record(brand.primary).value = '#123ABC';
  brand.probe = { type: 'color', value: '#ABCDEF' };
  record(record(record(input.tokens.font).size).body).value = 20;
  record(record(input.tokens.space)['4']).value = 28;
  const before = structuredClone(input);
  const css = rootDeclarations(generateTokensCss(input));
  expect(css.get('--color-brand-primary')).toBe('#123ABC');
  expect(css.get('--color-brand-probe')).toBe('#ABCDEF');
  expect(css.get('--font-size-body')).toBe('1.25rem');
  expect(css.get('--space-4')).toBe('28px');
  const tailwind = generateTailwindCss(input);
  expect(tailwind).toContain('var(--color-brand-probe)');
  expect(tailwind).not.toContain('#ABCDEF');
  expect(themeLeaves(themeFromTokens(input))).toContain('var(--color-brand-probe)');
  expect(input).toEqual(before);
  expect(generateTokensCss(input)).toBe(generateTokensCss(input));
  expect(generateTailwindCss(input)).toBe(tailwind);
  expect(themeFromTokens(input)).toEqual(themeFromTokens(input));
});

it('[AC-CT-11a#9] 两份 CSS 生成结果已经过仓库 Prettier 定型', async () => {
  const input = baseline();
  for (const output of [generateTokensCss(input), generateTailwindCss(input)]) {
    expect(output).toBe(
      await format(output, {
        parser: 'css',
        singleQuote: true,
        trailingComma: 'all',
        printWidth: 100,
      }),
    );
  }
});
