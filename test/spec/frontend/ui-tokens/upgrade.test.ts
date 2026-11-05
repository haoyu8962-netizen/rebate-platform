import { expect, it } from 'vitest';
import { darkBlocks, leaves, serializedExports } from './dark-kit.ts';
import { block, declarations, record, requiredText, rootDeclarations, snapshot } from './kit.ts';

// Fixed v0.5.1 expectations, independent of the generator and the implementation snapshot.
// Alpha 0x8C / 255 rounds to 0.55; logical dimensions are emitted in px.
const additions = [
  {
    path: 'color.platform.tag.taobao',
    value: '#D53D00',
    alias: '--color-couli-platform-tag-taobao',
  },
  { path: 'color.platform.tag.tmall', value: '#EA0031', alias: '--color-couli-platform-tag-tmall' },
  { path: 'color.platform.tag.jd', value: '#E02018', alias: '--color-couli-platform-tag-jd' },
  { path: 'color.platform.tag.pdd', value: '#EB0007', alias: '--color-couli-platform-tag-pdd' },
  {
    path: 'color.overlay.on-image',
    value: 'rgba(0, 0, 0, 0.55)',
    alias: '--color-couli-overlay-on-image',
  },
  { path: 'radius.tag', value: '4px', alias: '--radius-couli-tag' },
  { path: 'radius.avatar', value: '10px', alias: '--radius-couli-avatar' },
] as const;

it('[AC-CT-11ba#1] 升级只新增七个令牌，完整保留 v0.4.0 的既有令牌', () => {
  const previous = record(
    JSON.parse(requiredText('test/spec/frontend/ui-tokens/fixtures/design-tokens.49bb4ad.json')),
  );
  const oldLeaves = leaves(previous.tokens);
  const current = leaves(snapshot().tokens);
  const actual = new Map(current.map(({ path, token }) => [path.join('.'), token]));
  for (const { path, token } of oldLeaves)
    expect(actual.get(path.join('.')), path.join('.')).toEqual(token);
  const oldPaths = new Set(oldLeaves.map(({ path }) => path.join('.')));
  expect([...actual.keys()].filter((path) => !oldPaths.has(path)).sort()).toEqual(
    additions.map(({ path }) => path).sort(),
  );
});

it('[AC-CT-11ba#2] 入库 CSS 含七个新令牌，五个同值颜色仍进入两个深色块', () => {
  const css = requiredText('packages/ui-tokens/src/tokens.gen.css');
  const light = rootDeclarations(css);
  const dark = darkBlocks(css);
  for (const { path, value } of additions) {
    const variable = `--${path.replaceAll('.', '-')}`;
    expect(light.get(variable), variable).toBe(value);
    for (const mode of dark) {
      if (path.startsWith('color.')) expect(mode.get(variable), variable).toBe(value);
      else expect(mode.has(variable), variable).toBe(false);
    }
  }
});

it('[AC-CT-11ba#3] 入库 TS 主题含七个新引用及浅深色解析值，圆角在深色回退', () => {
  const exported = serializedExports(requiredText('packages/ui-tokens/src/theme.gen.ts'));
  const values = record(exported.tokenValues);
  for (const { path, value } of additions) {
    for (const [theme, expected] of [
      [exported.tokenTheme, `var(--${path.replaceAll('.', '-')})`],
      [values.light, value],
      [values.dark, value],
    ] as const) {
      let actual: unknown = theme;
      for (const key of path.split('.')) actual = record(actual)[key];
      expect(actual, path).toBe(expected);
    }
  }
});

it('[AC-CT-11ba#4] 入库 Tailwind 为七个新令牌提供对应命名空间的变量引用', () => {
  const css = requiredText('packages/ui-tokens/src/tailwind.gen.css');
  const aliases = declarations(block(css, /@theme\s+inline\s*\{([^{}]*)\}/g));
  for (const { path, alias } of additions) {
    expect(aliases.get(alias), alias).toBe(`var(--${path.replaceAll('.', '-')})`);
  }
});
