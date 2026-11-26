import { isDeepStrictEqual } from 'node:util';
import { expect, it } from 'vitest';
import { darkBlocks, leaves, serializedExports } from './dark-kit.ts';
import {
  block,
  declarations,
  fixturePath,
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

// v0.5.2 → v0.5.3 (planning c404003, couli #32; D10-3141): seven light values change from → to;
// no token is added or removed and dark values stay. Copied verbatim from the two fixtures.
const v053Values: Readonly<Record<string, readonly [string, string]>> = {
  'color.background.canvas': ['#F2EEE6', '#F6F5F3'],
  'color.background.muted': ['#EFEAE2', '#F2F1EF'],
  'color.status.pending.background': ['#EFEAE2', '#F2F1EF'],
  'color.background.placeholder': ['#E9E2D9', '#EBEAE7'],
  'color.button.primary.disabled.background': ['#E9E2D9', '#EBEAE7'],
  'color.border.subtle': ['#E4DED5', '#E6E5E3'],
  'color.source.border': ['#E4DED5', '#E6E5E3'],
};

// v0.5.3 also rewords four token descriptions (text only).
const v053Descriptions: Readonly<Record<string, string>> = {
  'color.brand.primary': '狸橙；主要行动底色与品牌图形，不用于页面底上的普通小字',
  'color.background.canvas':
    'App 页面背景（近中性暖白）；2026-11-25 由 #F2EEE6 调整（2026-10-04 曾由 #F6F3ED 调为 #F2EEE6），管理后台用 admin-canvas',
  'color.rebate.text':
    '返利金额与其标签词（预估返、推广收益）的强调文字，用于白底、页面底与 rebate.background 上',
  'color.border.control': '必要控件边界，已验证对白色与 App / 后台页面底至少 3:1',
};

// The exact v0.5.3 form of a token that existed before v0.5.3: only the listed fields change.
function upgradedTo053(path: string, token: Record<string, unknown>): Record<string, unknown> {
  const next = { ...token };
  const value = v053Values[path];
  if (value) {
    expect(token.value, path).toBe(value[0]);
    next.value = value[1];
  }
  const description = v053Descriptions[path];
  if (description !== undefined) next.description = description;
  return next;
}

it('[AC-CT-11ba#1] 升级只新增七个令牌，完整保留 v0.4.0 的既有令牌', () => {
  // CT-11bv: only 0.5.3 is accepted; other versions fail in pin().
  const branch = pin().version;
  const previous = record(
    JSON.parse(requiredText('test/spec/frontend/ui-tokens/fixtures/design-tokens.49bb4ad.json')),
  );
  const oldLeaves = leaves(previous.tokens);
  const current = leaves(snapshot().tokens);
  const actual = new Map(current.map(({ path, token }) => [path.join('.'), token]));
  // v0.4.0 tokens are kept whole, except the exact v0.5.3 value and description changes.
  for (const { path, token } of oldLeaves)
    expect(actual.get(path.join('.')), path.join('.')).toEqual(
      upgradedTo053(path.join('.'), token),
    );
  const oldPaths = new Set(oldLeaves.map(({ path }) => path.join('.')));
  expect(branch).toBe('0.5.3');
  // Since v0.4.0: the seven tokens of v0.5.1 plus the motion group of v0.5.2 (v0.5.3 adds none).
  expect([...actual.keys()].filter((path) => !oldPaths.has(path)).sort()).toEqual(
    [...additions.map(({ path }) => path), ...motion].sort(),
  );
});

it('[AC-DSX-48-UPGRADE#1] v0.5.1 → v0.5.2 只新增 motion 组 15 个令牌，完整保留 v0.5.1 的既有令牌', () => {
  const branch = pin().version;
  const previous = record(
    JSON.parse(requiredText('test/spec/frontend/ui-tokens/fixtures/design-tokens.f088f04.json')),
  );
  expect(record(previous.metadata).version).toBe('0.5.1');
  // The contract is now v0.5.3; the v0.5.2 side is the verbatim c98ae93 fixture
  // ([AC-CT-11bv#1] ties that fixture to the contract).
  expect(branch).toBe('0.5.3');
  const next = record(
    JSON.parse(requiredText('test/spec/frontend/ui-tokens/fixtures/design-tokens.c98ae93.json')),
  );
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

it('[AC-CT-11bv#1] v0.5.2 → v0.5.3 只改七个浅色取值，不加不删键，深色取值与 admin-canvas 不变', () => {
  expect(pin().version).toBe('0.5.3');
  const previous = record(JSON.parse(requiredText(fixturePath('design-tokens.c98ae93.json'))));
  const next = record(snapshot());
  const oldMeta = record(previous.metadata);
  const newMeta = record(next.metadata);
  expect(oldMeta.version).toBe('0.5.2');
  // Top level and metadata: same keys; metadata changes only version, date and description.
  expect(Object.keys(next).sort()).toEqual(Object.keys(previous).sort());
  expect(next.schemaVersion).toEqual(previous.schemaVersion);
  expect(Object.keys(newMeta).sort()).toEqual(Object.keys(oldMeta).sort());
  expect(newMeta.version).toBe('0.5.3');
  expect(newMeta.date).toBe('2026-11-25');
  expect(typeof newMeta.description).toBe('string');
  for (const key of Object.keys(oldMeta).filter(
    (k) => !['version', 'date', 'description'].includes(k),
  ))
    expect(newMeta[key], `metadata.${key}`).toEqual(oldMeta[key]);
  // Tokens: same leaf paths, each leaf whole-equal to its v0.5.2 form plus the listed changes.
  const oldLeaves = leaves(previous.tokens);
  const actual = new Map(leaves(next.tokens).map(({ path, token }) => [path.join('.'), token]));
  expect([...actual.keys()].sort()).toEqual(oldLeaves.map(({ path }) => path.join('.')).sort());
  const changed: string[] = [];
  for (const { path, token } of oldLeaves) {
    const key = path.join('.');
    const after = record(actual.get(key));
    expect(after, key).toEqual(upgradedTo053(key, token));
    expect(after.dark, `${key} dark`).toEqual(token.dark);
    if (!isDeepStrictEqual(after.value, token.value)) changed.push(key);
  }
  expect(changed.sort()).toEqual(Object.keys(v053Values).sort());
  expect(Object.keys(v053Descriptions).every((key) => actual.has(key))).toBe(true);
  expect(actual.get('color.background.admin-canvas')).toEqual(
    oldLeaves.find(({ path }) => path.join('.') === 'color.background.admin-canvas')?.token,
  );
  // Whole tree (including any group-level fields) equals v0.5.2 with the listed changes applied.
  const expected = structuredClone(previous.tokens);
  for (const [key, [, to]] of Object.entries(v053Values)) {
    let node: unknown = expected;
    for (const segment of key.split('.')) node = record(node)[segment];
    record(node).value = to;
  }
  for (const [key, text] of Object.entries(v053Descriptions)) {
    let node: unknown = expected;
    for (const segment of key.split('.')) node = record(node)[segment];
    record(node).description = text;
  }
  expect(next.tokens).toEqual(expected);
  // Planning CSS fixtures: same lines except the seven light declarations.
  const oldCss = requiredText(fixturePath('variables.c98ae93.css')).split('\n');
  const newCss = requiredText(fixturePath(pin().css)).split('\n');
  expect(newCss).toHaveLength(oldCss.length);
  const diff = newCss.flatMap((line, index) =>
    line === oldCss[index] ? [] : [[oldCss[index]!.trim(), line.trim()]],
  );
  expect(diff.sort()).toEqual(
    Object.entries(v053Values)
      .map(([key, [from, to]]) => {
        const variable = `--${key.replaceAll('.', '-')}`;
        return [`${variable}: ${from};`, `${variable}: ${to};`];
      })
      .sort(),
  );
});
