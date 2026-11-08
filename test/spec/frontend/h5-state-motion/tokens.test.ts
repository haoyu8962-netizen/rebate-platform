// DSX-48 (编排 D10-838): design tokens v0.5.2 and its motion group in the contracts snapshot and in
// the generated files of @couli/ui-tokens. Values come from expected.ts (hand written from the
// planning change note), never from the generator.
//
// Note for the implementation: test/spec/frontend/ui-tokens/dark-kit.ts (frozen) requires
// tokens.gen.css to hold exactly the light :root block and the two dark blocks, nothing else; the
// reduced-motion / forced-colors rules of ui-tokens therefore go into another generated CSS file
// (source.test.ts, A11Y-CSS#1), and TOKENS#3 keeps the three-block shape.
import {
  generateTailwindCss,
  generateThemeTs,
  generateTokensCss,
  themeFromTokens,
  themeValuesFromTokens,
  tokenTheme,
  tokenValues,
  type DesignTokens,
} from '@couli/ui-tokens';
import { expect, it } from 'vitest';
import {
  cssVariable,
  DESIGN_SOURCE_COMMIT,
  MOTION_LEAVES,
  PREVIOUS_SNAPSHOT,
  PREVIOUS_SOURCE_COMMIT,
  TOKENS_VERSION,
} from './expected.ts';
import {
  at,
  declarations,
  EXPLICIT_DARK,
  lightDeclarations,
  record,
  requiredJson,
  requiredText,
  SYSTEM_DARK,
  tokenLeaves,
  withoutComments,
} from './kit.ts';

const CONTRACT = 'contracts/design-tokens.json';

/** Runs a generator; a throw is reported as an assertion failure, not an uncaught error. */
function generated<T>(label: string, run: () => T): T {
  let result: T | undefined;
  expect(() => {
    result = run();
  }, label).not.toThrow();
  return result as T;
}

function contractTokens(): DesignTokens {
  return requiredJson(CONTRACT) as unknown as DesignTokens;
}

/** The v0.5.1 snapshot with `tokens.motion` replaced by `motion`. */
function probeDocument(motion: Record<string, unknown>): DesignTokens {
  const doc = requiredJson(PREVIOUS_SNAPSHOT) as unknown as DesignTokens;
  doc.tokens.motion = motion;
  return doc;
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

// That every v0.5.1 token is kept and only the motion group is new is checked once, in
// test/spec/frontend/ui-tokens/upgrade.test.ts ([AC-DSX-48-UPGRADE#1]); the byte-for-byte copy of
// the planning file in snapshot.test.ts ([AC-CT-11a#1]). This case pins the motion values by hand.
it('[AC-DSX-48-TOKENS#1] 契约令牌整份升到 0.5.2：metadata 其余字段不变，motion 组 15 个令牌的类型与取值正确', () => {
  const current = requiredJson(CONTRACT);
  const previous = requiredJson(PREVIOUS_SNAPSHOT);
  const metadata = record(current.metadata, 'metadata');
  expect(metadata.version, 'metadata.version').toBe(TOKENS_VERSION);
  expect(current.schemaVersion).toBe(previous.schemaVersion);
  const previousMetadata = record(previous.metadata, 'v0.5.1 metadata');
  for (const key of ['name', 'theme', 'modes', 'darkThemePhase', 'colorSpace', 'cssFontBase']) {
    expect(metadata[key], `metadata.${key}`).toEqual(previousMetadata[key]);
  }
  const leaves = tokenLeaves(at(current, 'tokens.motion', CONTRACT), 'motion');
  expect([...leaves.keys()].sort()).toEqual(MOTION_LEAVES.map((leaf) => leaf.path).sort());
  for (const expected of MOTION_LEAVES) {
    const token = record(leaves.get(expected.path), expected.path);
    expect(token.type, `${expected.path}.type`).toBe(expected.type);
    expect(token.value, `${expected.path}.value`).toEqual(expected.value);
    if (expected.type === 'duration') expect(token.unit, `${expected.path}.unit`).toBe('ms');
    expect('dark' in token, `${expected.path} has no dark value`).toBe(false);
  }
});

it('[AC-DSX-48-TOKENS#2] contracts/README 的 design-tokens.json 行改记 0.5.2 与来源提交 c98ae93f…', () => {
  const readme = requiredText('contracts/README.md');
  const delivered = readme.split('## 以后会放在这里的文件')[0] ?? '';
  const rows = delivered
    .split('\n')
    .filter((line) => /^\|\s*`design-tokens\.json`\s*\|/.test(line));
  expect(rows).toHaveLength(1);
  const row = rows[0] ?? '';
  expect(row).toContain(TOKENS_VERSION);
  expect(row).toContain(DESIGN_SOURCE_COMMIT);
  expect(row, 'the old source commit is replaced, not kept beside the new one').not.toContain(
    PREVIOUS_SOURCE_COMMIT,
  );
});

it('[AC-DSX-48-TOKENS#3] tokens.gen.css 的 :root 含 15 个 --motion-* 且写法为 250ms / cubic-bezier(…)，深色块不覆盖，文件仍只有三块且与契约重新生成一致', () => {
  const css = requiredText('packages/ui-tokens/src/tokens.gen.css');
  const light = lightDeclarations(css);
  for (const leaf of MOTION_LEAVES) {
    const variable = cssVariable(leaf.path);
    expect(light.get(variable), variable).toBe(leaf.css);
  }
  expect([...light.keys()].filter((name) => name.startsWith('--motion-')).sort()).toEqual(
    MOTION_LEAVES.map((leaf) => cssVariable(leaf.path)).sort(),
  );
  const clean = withoutComments(css);
  for (const pattern of [SYSTEM_DARK, EXPLICIT_DARK]) {
    const blocks = [...clean.matchAll(pattern)];
    expect(blocks, String(pattern)).toHaveLength(1);
    const dark = declarations(blocks[0]?.[1] ?? '');
    expect([...dark.keys()].filter((name) => name.startsWith('--motion-'))).toEqual([]);
  }
  // Shape kept for the frozen ui-tokens rule tests: one bare :root block and the two dark blocks.
  expect(clean.match(/:root\s*\{/g) ?? []).toHaveLength(1);
  expect(
    clean
      .replace(/:root\s*\{[^{}]*\}/g, '')
      .replace(SYSTEM_DARK, '')
      .replace(EXPLICIT_DARK, '')
      .trim(),
  ).toBe('');
  expect(css).toBe(
    generated('generateTokensCss(contract)', () => generateTokensCss(contractTokens())),
  );
});

it('[AC-DSX-48-TOKENS#4] 生成器认 duration / cubicBezier 两种类型，非法值（负数、非 ms、非四元、x 越界、非数）一律报错并指出令牌路径', () => {
  const duration = (value: unknown, extra: Record<string, unknown> = { unit: 'ms' }) => ({
    type: 'duration',
    value,
    ...extra,
  });
  const bezier = (value: unknown) => ({ type: 'cubicBezier', value });
  const valid = probeDocument({
    duration: { zero: duration(0), short: duration(75), long: duration(2000) },
    easing: { plain: bezier([0.2, 0, 0, 1]), overshoot: bezier([0.3, -0.5, 0.7, 1.5]) },
  });
  const expected: Record<string, string> = {
    '--motion-duration-zero': '0ms',
    '--motion-duration-short': '75ms',
    '--motion-duration-long': '2000ms',
    '--motion-easing-plain': 'cubic-bezier(0.2, 0, 0, 1)',
    // Only x1 and x2 are limited to 0..1; y may overshoot.
    '--motion-easing-overshoot': 'cubic-bezier(0.3, -0.5, 0.7, 1.5)',
  };
  const light = lightDeclarations(generated('generateTokensCss', () => generateTokensCss(valid)));
  for (const [variable, value] of Object.entries(expected)) {
    expect(light.get(variable), variable).toBe(value);
  }
  const tailwind = generated('generateTailwindCss', () => generateTailwindCss(valid));
  const theme = generated('themeFromTokens', () => themeFromTokens(valid));
  const values = generated('themeValuesFromTokens', () => ({
    light: themeValuesFromTokens(valid, 'light'),
    dark: themeValuesFromTokens(valid, 'dark'),
  }));
  generated('generateThemeTs', () => generateThemeTs(valid));
  for (const [variable, value] of Object.entries(expected)) {
    const path = variable.slice(2).split('-');
    const dotted = [path[0], path[1], path.slice(2).join('-')].join('.');
    expect(occurrences(tailwind, `var(${variable})`), `tailwind alias of ${variable}`).toBe(1);
    expect(at(theme, dotted, 'tokenTheme')).toBe(`var(${variable})`);
    expect(at(values.light, dotted, 'light values')).toBe(value);
    expect(at(values.dark, dotted, 'dark values (falls back to value)')).toBe(value);
  }

  const invalid: [string, string, unknown][] = [
    ['negative duration', 'duration', duration(-1)],
    ['string duration', 'duration', duration('250')],
    ['infinite duration', 'duration', duration(Number.POSITIVE_INFINITY)],
    ['duration in seconds', 'duration', duration(250, { unit: 's' })],
    ['duration without unit', 'duration', duration(250, {})],
    ['duration with dark', 'duration', duration(250, { unit: 'ms', dark: 100 })],
    ['three numbers', 'easing', bezier([0.2, 0, 1])],
    ['five numbers', 'easing', bezier([0.2, 0, 0, 1, 1])],
    ['keyword', 'easing', bezier('ease-in-out')],
    ['string member', 'easing', bezier(['0.2', 0, 0, 1])],
    ['non-finite member', 'easing', bezier([Number.NaN, 0, 0, 1])],
    ['x1 above 1', 'easing', bezier([1.2, 0, 0, 1])],
    ['x2 below 0', 'easing', bezier([0.2, 0, -0.1, 1])],
  ];
  for (const [name, group, token] of invalid) {
    const doc = probeDocument({ [group]: { bad: token } });
    expect(() => generateTokensCss(doc), name).toThrow(`motion.${group}.bad`);
  }
});

it('[AC-DSX-48-TOKENS#5] 入库 tailwind.gen.css 与 theme.gen.ts 含全部 motion 令牌（var 引用与浅深解析值），且与契约重新生成一致', () => {
  const tailwind = requiredText('packages/ui-tokens/src/tailwind.gen.css');
  for (const leaf of MOTION_LEAVES) {
    const variable = cssVariable(leaf.path);
    expect(occurrences(tailwind, `var(${variable})`), `tailwind alias of ${variable}`).toBe(1);
    expect(at(tokenTheme, leaf.path, 'tokenTheme')).toBe(`var(${variable})`);
    expect(at(tokenValues.light, leaf.path, 'tokenValues.light')).toBe(leaf.css);
    expect(at(tokenValues.dark, leaf.path, 'tokenValues.dark')).toBe(leaf.css);
  }
  const contract = contractTokens();
  expect(tailwind).toBe(
    generated('generateTailwindCss(contract)', () => generateTailwindCss(contract)),
  );
  expect(requiredText('packages/ui-tokens/src/theme.gen.ts')).toBe(
    generated('generateThemeTs(contract)', () => generateThemeTs(contract)),
  );
});
