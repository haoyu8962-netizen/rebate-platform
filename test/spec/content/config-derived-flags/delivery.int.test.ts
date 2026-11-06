// F1-02zzze §9.3: GET /v1/config through Fastify inject over the real content assembly and an
// in-memory ContentStore (./derived-flags-kit.ts); expected values from ./derived-flags-oracle.ts.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { harness, read, readsOf, success, type Harness, type Json } from './derived-flags-kit.ts';
import {
  ALL_DERIVED,
  JD_PLUS_NOTE,
  NEW_DERIVED,
  PRODUCT_FEEDBACK,
  derivedFlags,
  expectedFlags,
} from './derived-flags-oracle.ts';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.close();
});

/** The reader's cache lifetime is 60 s: one millisecond more makes the next read fresh. */
const PAST_CACHE_MS = 60_001;

it('[AC-F1-02zzze#10] HTTP 两源键都无行：四个派生键都为 true，两源键各读一次', async () => {
  const id = h.configured();
  const { data } = await success(h, id);
  expect(data.features.flags).toEqual({
    'external_page.union_host_block': true,
    'earnings.dashboard.visible': true,
    product_feedback: true,
    jd_plus_note: true,
  });
  const keys = readsOf(h, id);
  for (const { source } of NEW_DERIVED) {
    expect(keys.filter((key) => key === source)).toEqual([source]);
  }
  expect(keys).not.toContain(PRODUCT_FEEDBACK.flag);
  expect(keys).not.toContain(JD_PLUS_NOTE.flag);
});

const SOURCE_VALUES: [string, Json][] = [
  ['false', false],
  ['true', true],
  ["'off'", 'off'],
  ['0', 0],
  ['null', null],
  ["'false'", 'false'],
  ["''", ''],
  ['1', 1],
  ['[]', []],
  ['{}', {}],
];

it.each(
  NEW_DERIVED.flatMap(({ flag, source }) =>
    SOURCE_VALUES.map(([label, value]) => ({ flag, source, label, value })),
  ),
)(
  '[AC-F1-02zzze#11] HTTP $source = $label：只有严格 false 关闭 $flag，其余派生键不受影响',
  async ({ flag, source, value }) => {
    const id = h.configured({ [source]: value });
    const { data } = await success(h, id);
    expect(data.features.flags[flag]).toBe(value !== false);
    expect(data.features.flags).toEqual(derivedFlags({ [source]: value }));
  },
);

it.each([
  ['两源键无行', {}],
  ['两源键 false', { [PRODUCT_FEEDBACK.source]: false, [JD_PLUS_NOTE.source]: false }],
  ['两源键 true', { [PRODUCT_FEEDBACK.source]: true, [JD_PLUS_NOTE.source]: true }],
  ['一个 false、一个无行', { [PRODUCT_FEEDBACK.source]: false }],
  ['一个无行、一个 false', { [JD_PLUS_NOTE.source]: false }],
] satisfies [string, Record<string, Json>][])(
  '[AC-F1-02zzze#12] HTTP %s：基础字典 features.flags 里相反取值的同名键被派生值覆盖',
  async (_label, sources) => {
    const derived = derivedFlags(sources);
    const others = { custom: true, 'ui.grayscale': false };
    const id = h.configured({
      'features.flags': {
        ...others,
        [PRODUCT_FEEDBACK.flag]: !derived[PRODUCT_FEEDBACK.flag],
        [JD_PLUS_NOTE.flag]: !derived[JD_PLUS_NOTE.flag],
      },
      ...sources,
    });
    const { data } = await success(h, id);
    expect(data.features.flags).toEqual(expectedFlags(others, sources));
  },
);

it.each(ALL_DERIVED)(
  '[AC-F1-02zzze#13] HTTP 只关闭 $source：只有 $flag 为 false，四个派生键互不干扰',
  async ({ flag, source }) => {
    const id = h.configured({ [source]: false });
    const { data } = await success(h, id);
    expect(data.features.flags).toEqual(derivedFlags({ [source]: false }));
    expect(Object.entries(data.features.flags).filter(([, v]) => v === false)).toEqual([
      [flag, false],
    ]);
  },
);

it.each(NEW_DERIVED)(
  '[AC-F1-02zzze#14] $source 无行改 false 再改 true：缓存过期后 $flag 跟随，config_version / ETag 随之变化与复原',
  async ({ flag, source }) => {
    const id = h.configured();
    const first = await success(h, id);
    expect(first.data.features.flags[flag]).toBe(true);
    const firstTag = `"${first.data.config_version}"`;

    h.update(id, { [source]: false });
    h.clock.advanceMs(PAST_CACHE_MS);
    const off = await success(h, id, { 'if-none-match': firstTag });
    expect(off.data.features.flags[flag]).toBe(false);
    expect(off.data.config_version).not.toBe(first.data.config_version);
    // Nothing but the flag and the version changed.
    expect({
      ...off.data,
      config_version: first.data.config_version,
      features: { ...off.data.features, flags: { ...off.data.features.flags, [flag]: true } },
    }).toEqual(first.data);
    const offTag = `"${off.data.config_version}"`;

    h.update(id, { [source]: true });
    h.clock.advanceMs(PAST_CACHE_MS);
    const stale = await success(h, id, { 'if-none-match': offTag });
    expect(stale.data.features.flags[flag]).toBe(true);
    expect(stale.data.config_version).toBe(first.data.config_version);
    const same = await read(h, id, { 'if-none-match': firstTag });
    expect(same.statusCode).toBe(304);
    expect(same.body).toBe('');
    expect(same.headers['etag']).toBe(firstTag);
    expect(readsOf(h, id).filter((key) => key === source)).toHaveLength(3);
  },
);
