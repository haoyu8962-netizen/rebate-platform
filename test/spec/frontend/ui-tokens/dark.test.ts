import * as committedTheme from '../../../../packages/ui-tokens/src/theme.gen.ts';
import { generateTailwindCss, generateThemeTs, generateTokensCss } from '@couli/ui-tokens';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { baseline, baselineDeclarations, record, requiredText, rootDeclarations } from './kit.ts';
import {
  darkBlocks,
  expectValueTheme,
  generatedCss,
  leaves,
  serializedExports,
  succeeds,
} from './dark-kit.ts';

function plannedDark(): Map<string, string> {
  // The planning CSS includes optional classes after the token blocks; this package emits tokens.
  const css = requiredText('test/spec/frontend/ui-tokens/fixtures/variables.f088f04.css');
  return darkBlocks(css.split('/* Optional foundations:')[0]!)[0];
}

it('[AC-CT-11b-CSS-DARK#1] 两个深色块完整匹配规划值，仅覆盖含 dark 的叶子', () => {
  const input = baseline();
  const expected = plannedDark();
  const [system, explicit] = darkBlocks(generatedCss(input));
  expect(system).toEqual(explicit);
  const names = leaves(input.tokens)
    .filter(({ token }) => 'dark' in token)
    .map(({ variable }) => variable)
    .sort();
  for (const actual of [system, explicit]) {
    expect(actual.get('color-scheme')).toBe('dark');
    expect([...actual.keys()].filter((key) => key.startsWith('--')).sort()).toEqual(names);
    expect(actual.has('--shadow-none')).toBe(false);
    expect(actual).toEqual(expected);
  }
});

it('[AC-CT-11b-CSS-DARK#2] 深色值遵循浅色的转换规则，含透明色和两层阴影', () => {
  const input = baseline();
  record(record(record(input.tokens.color).overlay).scrim).dark = '#12345680';
  record(record(input.tokens.shadow).card).dark = [
    { x: -2, y: 3, blur: 6, spread: 1, color: '#123456', opacity: 0.25 },
    { x: 0, y: 4, blur: 12, spread: -1, color: '#ABCDEF', opacity: 0.5 },
  ];
  const [dark, explicit] = darkBlocks(generatedCss(input));
  expect(dark).toEqual(explicit);
  expect(dark.get('--color-overlay-scrim')).toBe('rgba(18, 52, 86, 0.5)');
  expect(dark.get('--shadow-card')).toBe(
    '-2px 3px 6px 1px rgba(18, 52, 86, 0.25), 0px 4px 12px -1px rgba(171, 205, 239, 0.5)',
  );
  const projected = structuredClone(input);
  for (const { token } of leaves(projected.tokens)) if ('dark' in token) token.value = token.dark;
  const light = rootDeclarations(generatedCss(projected));
  for (const [name, value] of dark)
    if (name.startsWith('--')) expect(value, name).toBe(light.get(name));
});

it('[AC-CT-11b-CSS-DARK#3] 按 dark 字段存在性覆盖，同值仍覆盖、缺省不覆盖、空阴影覆盖为 none', () => {
  const input = baseline();
  const brand = record(record(input.tokens.color).brand);
  delete record(brand.emphasis).dark;
  brand.probe = { type: 'color', value: '#123ABC', dark: '#123ABC' };
  brand.fallback = { type: 'color', value: '#AABBCC' };
  record(record(input.tokens.shadow).floating).dark = [];
  const [dark, explicit] = darkBlocks(generatedCss(input));
  expect(dark).toEqual(explicit);
  expect(dark.has('--color-brand-emphasis')).toBe(false);
  expect(dark.has('--color-brand-fallback')).toBe(false);
  expect(dark.get('--color-brand-probe')).toBe('#123ABC');
  expect(dark.get('--shadow-floating')).toBe('none');
  const resolved = new Map([...rootDeclarations(generatedCss(input)), ...dark]);
  expectValueTheme(serializedExports(generateThemeTs(input)), input, 'dark', resolved);
});

it('[AC-CT-11b-THEME#1] 入库深色主题覆盖全部令牌，无 dark 的尺寸字体与空阴影回退 value', () => {
  const input = baseline();
  const light = baselineDeclarations();
  const dark = new Map([...light, ...plannedDark()]);
  expectValueTheme(committedTheme, input, 'dark', dark);
});

it('[AC-CT-11b-THEME#2] 主题序列化读取输入 dark，不把深色值写死在模板中', () => {
  const input = baseline();
  const original = generateThemeTs(input);
  record(record(record(input.tokens.color).brand).primary).dark = '#13579B';
  const before = structuredClone(input);
  const generated = generateThemeTs(input);
  expect(generated).not.toBe(original);
  const dark = new Map([
    ...baselineDeclarations(),
    ...plannedDark(),
    ['--color-brand-primary', '#13579B'],
  ]);
  expectValueTheme(serializedExports(generated), input, 'dark', dark);
  expect(input).toEqual(before);
  expect(generateThemeTs(input)).toBe(generated);
});

it('[AC-CT-11b-SOURCE#1] 生成器无 I/O 和硬编码颜色，深色变化只来自入参且不污染后续调用', () => {
  const text = requiredText('packages/ui-tokens/src/generate.ts');
  const source = ts.createSourceFile('generate.ts', text, ts.ScriptTarget.Latest, true);
  const forbidden: string[] = [];
  const inspect = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^(?:node:)?(?:fs|fs\/promises|http|https|http2|net|tls|dns|dgram|child_process|worker_threads)$/.test(
        node.moduleSpecifier.text,
      )
    )
      forbidden.push(node.getText(source));
    if (
      ts.isIdentifier(node) &&
      /^(?:fetch|XMLHttpRequest|process|console|require|eval|Function|Deno|Bun|Date)$/.test(
        node.text,
      )
    )
      forbidden.push(node.text);
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Math' &&
      node.name.text === 'random'
    )
      forbidden.push(node.getText(source));
    if (
      ts.isStringLiteralLike(node) &&
      /#[\da-f]{6}(?:[\da-f]{2})?\b|rgba?\(\s*\d/i.test(node.text)
    )
      forbidden.push(node.text);
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  expect(forbidden).toEqual([]);
  const input = baseline();
  const before = structuredClone(input);
  const original = succeeds(() => generateTokensCss(input));
  const changed = structuredClone(input);
  record(record(record(changed.tokens.color).brand).primary).dark = '#13579B';
  const changedBefore = structuredClone(changed);
  expect(succeeds(() => generateTokensCss(changed))).not.toBe(original);
  expect(generateTokensCss(input)).toBe(original);
  expect(input).toEqual(before);
  expect(changed).toEqual(changedBefore);
  expect(generateTailwindCss(changed)).toBe(generateTailwindCss(input));
});
