// CT-26zm (BR-AI-13; 变更记录 20261112 §3.4 C4 第一项; 编排 D10-1330): real GET /v1/config over
// config_items. legal.ai_third_party = { version } is always delivered with the effective
// version: int32 >= 1 as configured; absent → 1, no log; wrong shape → 1 as if absent, one warn
// naming only the key, response still 200. Every response passes the contract. Each case carries
// a new-behavior assertion (initially red).
import { expect, it } from 'vitest';
import { KEY, LEGAL_DEFAULT, MALFORMED, MARKER, VALID, legalOf, legalWith } from './fixtures.ts';
import {
  config,
  configApp,
  configLogs,
  configured,
  getConfig,
  readConfig,
  rewrite,
  useHarness,
} from './kit.ts';

const h = useHarness(() => import('@couli/db/testing'));

/** Logger metadata every entry may carry; anything else must be the reported key alone. */
const METADATA = new Set([
  'level',
  'time',
  'pid',
  'hostname',
  'entry',
  'env',
  'module',
  'msg',
  'trace_id',
]);

it('[AC-CT-26zm#8][BR-AI-13] 缺行下发生效版本 1 且无日志；合法版本（含 int32 上界）原样下发，其余 legal 不变、无日志', async () => {
  const f = await configApp(h);
  const absent = await configured(h);
  const start = f.logs.length;
  const baseline = await readConfig(f.app, absent);
  expect(legalOf(baseline.data)).toEqual(LEGAL_DEFAULT);
  expect(configLogs(f.logs, start, absent)).toEqual([]);
  for (const value of VALID) {
    const id = await configured(h, { [KEY]: value });
    const from = f.logs.length;
    const { data } = await readConfig(f.app, id);
    expect(legalOf(data)).toEqual(legalWith(value));
    expect(configLogs(f.logs, from, id)).toEqual([]);
    // Another app's read must not leak into the absent app's (cached) response.
    expect((await readConfig(f.app, absent)).data).toEqual(baseline.data);
  }
});

it('[AC-CT-26zm#9][BR-AI-13] 游客与带设备头的请求读到同一版本（按 app 下发，不随主体变化）', async () => {
  const f = await configApp(h);
  const id = await configured(h, { [KEY]: 4 });
  const first = await readConfig(f.app, id);
  const other = await readConfig(f.app, id, {
    'x-device-id': '019a0000-0000-7000-8000-0000000000ff',
  });
  expect(legalOf(first.data)?.['ai_third_party']).toEqual({ version: 4 });
  expect(legalOf(other.data)?.['ai_third_party']).toEqual({ version: 4 });
});

it.each(MALFORMED)(
  '[AC-CT-26zm#10][BR-AI-13] 版本为%s仍返回 200 并下发生效版本 1，与缺行同体，只 warn 一次键名且不含原值',
  async (_label, value) => {
    const f = await configApp(h);
    const id = await configured(h, { [KEY]: value });
    const start = f.logs.length;
    const result = await readConfig(f.app, id);
    expect(legalOf(result.data)).toEqual(LEGAL_DEFAULT);
    const entries = configLogs(f.logs, start, id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 40,
      event: 'content_config_value_invalid',
      app_id: id,
      config_key: KEY,
    });
    expect(
      Object.fromEntries(Object.entries(entries[0]!).filter(([key]) => !METADATA.has(key))),
    ).toEqual({ event: 'content_config_value_invalid', app_id: id, config_key: KEY });
    expect(f.logs.slice(start).join('\n')).not.toContain(MARKER);
    // Same delivered body as an app without the row. config_version and the signed bridge_origins
    // are bound to the app id, so they are compared within one app in #11, not across apps here.
    const absent = await configured(h);
    const plain = await readConfig(f.app, absent);
    expect({ ...result.data, config_version: '', bridge_origins: { jws: '' } }).toEqual({
      ...plain.data,
      config_version: '',
      bridge_origins: { jws: '' },
    });
  },
);

it('[AC-CT-26zm#11][BR-AI-13] 补配置为 1 不改变 config_version（生效版本相同）；改成 2 得新 ETag 与新 200；改回非法值回到缺行时的 ETag', async () => {
  const f = await configApp(h);
  const id = await configured(h);
  const baseline = await readConfig(f.app, id);
  expect(legalOf(baseline.data)).toEqual(LEGAL_DEFAULT);
  expect((await getConfig(f.app, id, { 'if-none-match': baseline.etag })).response.statusCode).toBe(
    304,
  );
  // Configuring the default explicitly delivers the same body: the old ETag still matches.
  await config(h, id, KEY, 1);
  f.clock.advanceMs(60_001);
  const one = await getConfig(f.app, id, { 'if-none-match': baseline.etag });
  expect(one.response.statusCode).toBe(304);
  expect(one.response.headers['etag']).toBe(baseline.etag);
  // BR-AI-13 例「AI 文本升级到 v2」: the client must see the bump.
  await rewrite(h, id, KEY, 2, 2);
  f.clock.advanceMs(60_001);
  const two = await readConfig(f.app, id, { 'if-none-match': baseline.etag });
  expect(legalOf(two.data)?.['ai_third_party']).toEqual({ version: 2 });
  expect(two.etag).not.toBe(baseline.etag);
  const { config_version: versionOne, ...bodyOne } = baseline.data;
  const { config_version: versionTwo, ...bodyTwo } = two.data;
  expect(versionTwo).not.toBe(versionOne);
  expect(bodyTwo).toEqual({ ...bodyOne, legal: legalWith(2) });
  const unchanged = await getConfig(f.app, id, { 'if-none-match': two.etag });
  expect(unchanged.response.statusCode).toBe(304);
  expect(unchanged.response.headers['etag']).toBe(two.etag);
  // A malformed row delivers exactly what a missing row does.
  await rewrite(h, id, KEY, 'v3', 3);
  f.clock.advanceMs(60_001);
  const reverted = await readConfig(f.app, id, { 'if-none-match': two.etag });
  expect(reverted.data).toEqual(baseline.data);
  expect(reverted.etag).toBe(baseline.etag);
});
