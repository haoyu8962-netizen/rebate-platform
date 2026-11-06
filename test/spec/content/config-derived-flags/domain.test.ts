// F1-02zzze §9.3: the pure assembly of features.flags; expected values from ./derived-flags-oracle.ts.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  buildClientConfig,
  CLIENT_CONFIG_KEYS,
  type ClientConfig,
} from '../../../../apps/api/src/modules/content/domain/client-config.ts';
import {
  ALL_DERIVED,
  JD_PLUS_NOTE,
  NEW_DERIVED,
  PRODUCT_FEEDBACK,
  derivedFlags,
  expectedFlags,
} from './derived-flags-oracle.ts';

const REQUIRED: Record<string, unknown> = {
  h5_base_url: 'https://h5.example.test/',
  'h5_release.stable': 'stable-v1',
  kf: { url: 'https://kf.example.test/chat' },
  'legal.privacy.version': 7,
  'legal.privacy.min_version': 3,
  'legal.agreement.version': 5,
};
const PATTERNS = { version: 'lp-1', rules: [] } as NonNullable<ClientConfig['link_patterns']>;

function flagsOf(extra: Record<string, unknown>) {
  const missing: string[] = [];
  const invalid: string[] = [];
  const config = buildClientConfig({
    values: new Map(Object.entries({ ...REQUIRED, ...extra })),
    viewer: { appId: 'f102zzze', userId: null },
    deviceId: null,
    linkPatterns: PATTERNS,
    rankPlatforms: [],
    report: { missing: (k) => missing.push(k), invalid: (k) => invalid.push(k) },
  });
  expect(missing).toEqual([]);
  expect(config, 'config built').toBeDefined();
  return { flags: config?.features.flags, invalid };
}

/** Source values that are not exactly JSON false, look-alikes of false included. */
const NOT_FALSE: [string, unknown][] = [
  ['true', true],
  ["'off'", 'off'],
  ['0', 0],
  ['null', null],
  ["'false'", 'false'],
  ["'FALSE'", 'FALSE'],
  ["''", ''],
  ["'on'", 'on'],
  ['1', 1],
  ['[]', []],
  ['[false]', [false]],
  ['{}', {}],
  ['{ enabled: false }', { enabled: false }],
  ['存在但 undefined', undefined],
];

it('[AC-F1-02zzze#1] 两源键都无行：product_feedback、jd_plus_note 均为 true，四个派生键齐全且不报 invalid', () => {
  const { flags, invalid } = flagsOf({});
  expect(flags).toEqual({
    'external_page.union_host_block': true,
    'earnings.dashboard.visible': true,
    product_feedback: true,
    jd_plus_note: true,
  });
  expect(invalid).toEqual([]);
});

it.each(NEW_DERIVED)(
  '[AC-F1-02zzze#2] $source 为 JSON false 只关闭 $flag，其余三个派生键仍为 true',
  ({ flag, source }) => {
    const { flags } = flagsOf({ [source]: false });
    expect(flags?.[flag]).toBe(false);
    expect(flags).toEqual(derivedFlags({ [source]: false }));
    expect(Object.values(flags ?? {}).filter((v) => v === false)).toHaveLength(1);
  },
);

it.each(
  NEW_DERIVED.flatMap(({ flag, source }) =>
    NOT_FALSE.map(([label, value]) => ({ flag, source, label, value })),
  ),
)(
  '[AC-F1-02zzze#3] $source = $label 不是严格 false，$flag 仍为 true',
  ({ flag, source, value }) => {
    const { flags } = flagsOf({ [source]: value });
    expect(flags?.[flag]).toBe(true);
    expect(flags).toEqual(derivedFlags({ [source]: value }));
  },
);

it.each([
  ['两源键无行', {}],
  ['两源键 false', { [PRODUCT_FEEDBACK.source]: false, [JD_PLUS_NOTE.source]: false }],
  ['两源键 true', { [PRODUCT_FEEDBACK.source]: true, [JD_PLUS_NOTE.source]: true }],
  ["两源键 'false'", { [PRODUCT_FEEDBACK.source]: 'false', [JD_PLUS_NOTE.source]: 'false' }],
] satisfies [string, Record<string, unknown>][])(
  '[AC-F1-02zzze#4] %s：基础字典里相反取值的同名键被派生值覆盖，其他基础键保留',
  (_label, sources) => {
    // The base dictionary always says the opposite of the derived value.
    const base: Record<string, boolean> = {
      custom: true,
      'ui.grayscale': false,
      [PRODUCT_FEEDBACK.flag]: !derivedFlags(sources)[PRODUCT_FEEDBACK.flag],
      [JD_PLUS_NOTE.flag]: !derivedFlags(sources)[JD_PLUS_NOTE.flag],
    };
    const { flags, invalid } = flagsOf({ 'features.flags': base, ...sources });
    expect(flags).toEqual(expectedFlags({ custom: true, 'ui.grayscale': false }, sources));
    expect(invalid).not.toContain('features.flags');
  },
);

it('[AC-F1-02zzze#5] 一个源 false、另一个无行：基础字典同名键（true / false）各自被覆盖', () => {
  const sources = { [PRODUCT_FEEDBACK.source]: false };
  const { flags } = flagsOf({
    'features.flags': { [PRODUCT_FEEDBACK.flag]: true, [JD_PLUS_NOTE.flag]: false, custom: false },
    ...sources,
  });
  expect(flags).toEqual({
    custom: false,
    'external_page.union_host_block': true,
    'earnings.dashboard.visible': true,
    product_feedback: false,
    jd_plus_note: true,
  });
});

it.each(ALL_DERIVED)(
  '[AC-F1-02zzze#6] 只关闭 $source：只有 $flag 为 false，四个派生键互不干扰',
  ({ flag, source }) => {
    const { flags } = flagsOf({ [source]: false });
    expect(flags).toEqual(derivedFlags({ [source]: false }));
    expect(Object.entries(flags ?? {}).filter(([, v]) => v === false)).toEqual([[flag, false]]);
  },
);

it('[AC-F1-02zzze#7] 四个源都关闭：四个派生键都为 false', () => {
  const sources = Object.fromEntries(ALL_DERIVED.map(({ source }) => [source, false]));
  const { flags } = flagsOf(sources);
  expect(flags).toEqual({
    'external_page.union_host_block': false,
    'earnings.dashboard.visible': false,
    product_feedback: false,
    jd_plus_note: false,
  });
});

it('[AC-F1-02zzze#8] 任意源取值与任意基础字典：派生键只在源严格 false 时为 false，且总是覆盖同名基础键', () => {
  // No row, a JSON false row (drawn often), or a row of any JSON value.
  type Drawn = { readonly row: false } | { readonly row: true; readonly value: unknown };
  const sourceValue = fc.oneof(
    fc.constant<Drawn>({ row: false }),
    fc.constant<Drawn>({ row: true, value: false }),
    fc.jsonValue({ maxDepth: 2 }).map((value): Drawn => ({ row: true, value })),
  );
  // A base dictionary entry of the derived name: true, false, or none (null).
  const baseFlag = fc.constantFrom(true, false, null);
  const count = ALL_DERIVED.length;
  fc.assert(
    fc.property(
      fc.array(sourceValue, { minLength: count, maxLength: count }),
      fc.array(baseFlag, { minLength: count, maxLength: count }),
      fc.dictionary(fc.constantFrom('custom', 'ui.grayscale', 'home.fallback'), fc.boolean()),
      (values, baseDerived, others) => {
        const sources: Record<string, unknown> = {};
        const base: Record<string, boolean> = { ...others };
        for (const [i, { flag, source }] of ALL_DERIVED.entries()) {
          const drawn = values[i];
          if (drawn !== undefined && drawn.row === true) sources[source] = drawn.value;
          const baseValue = baseDerived[i];
          if (baseValue !== undefined && baseValue !== null) base[flag] = baseValue;
        }
        const { flags } = flagsOf({ 'features.flags': base, ...sources });
        expect(flags).toEqual(expectedFlags(others, sources));
        return true;
      },
    ),
    propParams(),
  );
});

it('[AC-F1-02zzze#9] 两源键进 GET /v1/config 的读取集合各恰一次，派生键名本身不作为配置键读取', () => {
  for (const { source } of NEW_DERIVED) {
    expect(CLIENT_CONFIG_KEYS.filter((key) => key === source)).toEqual([source]);
  }
  expect(CLIENT_CONFIG_KEYS).not.toContain(PRODUCT_FEEDBACK.flag);
  expect(CLIENT_CONFIG_KEYS).not.toContain(JD_PLUS_NOTE.flag);
  expect(new Set(CLIENT_CONFIG_KEYS).size).toBe(CLIENT_CONFIG_KEYS.length);
});
