import { expect, it } from 'vitest';
import { darkBlocks, leaves, serializedExports } from './dark-kit.ts';
import {
  block,
  declarations,
  pin,
  record,
  requiredText,
  rootDeclarations,
  snapshot,
} from './kit.ts';

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

// v0.5.1 → v0.5.2 (planning c98ae93, couli #296; DSX-48): only the motion group is new.
const motion = [
  'motion.duration.instant',
  'motion.duration.fast',
  'motion.duration.normal',
  'motion.duration.emphasized',
  'motion.duration.slow',
  'motion.easing.standard',
  'motion.easing.enter',
  'motion.easing.exit',
  'motion.easing.emphasized-enter',
  'motion.easing.emphasized-exit',
  'motion.toast.display',
  'motion.skeleton.shimmer',
  'motion.skeleton.show-delay',
  'motion.skeleton.min-visible',
  'motion.reduced.fade',
] as const;

it('[AC-CT-11ba#1] 升级只新增七个令牌，完整保留 v0.4.0 的既有令牌', () => {
  // CT-11bt: the contract version picks the branch; other versions fail in pin().
  const branch = pin().version;
  const previous = record(
    JSON.parse(requiredText('test/spec/frontend/ui-tokens/fixtures/design-tokens.49bb4ad.json')),
  );
  const oldLeaves = leaves(previous.tokens);
  const current = leaves(snapshot().tokens);
  const actual = new Map(current.map(({ path, token }) => [path.join('.'), token]));
  for (const { path, token } of oldLeaves)
    expect(actual.get(path.join('.')), path.join('.')).toEqual(token);
  const oldPaths = new Set(oldLeaves.map(({ path }) => path.join('.')));
  if (branch === '0.5.1') {
    expect([...actual.keys()].filter((path) => !oldPaths.has(path)).sort()).toEqual(
      additions.map(({ path }) => path).sort(),
    );
  } else {
    expect(branch).toBe('0.5.2');
    // Since v0.4.0: the seven tokens of v0.5.1 plus the motion group of v0.5.2.
    expect([...actual.keys()].filter((path) => !oldPaths.has(path)).sort()).toEqual(
      [...additions.map(({ path }) => path), ...motion].sort(),
    );
  }
});

it('[AC-DSX-48-UPGRADE#1] v0.5.1 → v0.5.2 只新增 motion 组 15 个令牌，完整保留 v0.5.1 的既有令牌', () => {
  const branch = pin().version;
  const previous = record(
    JSON.parse(requiredText('test/spec/frontend/ui-tokens/fixtures/design-tokens.f088f04.json')),
  );
  expect(record(previous.metadata).version).toBe('0.5.1');
  // 0.5.2: the contract itself is the upgraded side. 0.5.1 (CT-11bt): the contract must still be
  // the f088f04 snapshot, so the same full check runs on the pinned c98ae93 fixture instead.
  let next: Record<string, unknown>;
  if (branch === '0.5.1') {
    expect(snapshot()).toEqual(previous);
    next = record(
      JSON.parse(requiredText('test/spec/frontend/ui-tokens/fixtures/design-tokens.c98ae93.json')),
    );
  } else {
    expect(branch).toBe('0.5.2');
    next = record(snapshot());
  }
  const oldLeaves = leaves(previous.tokens);
  const current = leaves(next.tokens);
  const actual = new Map(current.map(({ path, token }) => [path.join('.'), token]));
  for (const { path, token } of oldLeaves)
    expect(actual.get(path.join('.')), path.join('.')).toEqual(token);
  const oldPaths = new Set(oldLeaves.map(({ path }) => path.join('.')));
  expect([...actual.keys()].filter((path) => !oldPaths.has(path)).sort()).toEqual(
    [...motion].sort(),
  );
  expect(record(next.metadata).version).toBe('0.5.2');
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
