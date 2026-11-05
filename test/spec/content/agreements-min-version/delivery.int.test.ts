// F1-02zr §9.2#2 / §9.3#4,6: real /v1/config, response contract, logs and ETag.
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { signedConfigApp } from '../bridge-origins/http-kit.ts';
import { expectAppBoundConfig } from '../bridge-origins/jws-kit.ts';
import {
  MIN_KEY,
  config,
  configApp,
  configLogs,
  configured,
  getConfig,
  readConfig,
  useHarness,
} from './kit.ts';

const h = useHarness(() => import('@couli/db/testing'));

it('[AC-F1-02zr#7] 缺行静默省略，合法值含 int32 上界照常下发且不与 version 比较', async () => {
  const f = await configApp(h);
  const absent = await configured(h);
  const start = f.logs.length;
  const baseline = await readConfig(f.app, absent);
  expect(baseline.data.legal.agreement).toEqual({ version: 5 });
  expect(configLogs(f.logs, start, absent)).toEqual([]);
  for (const value of [1, 2, 6, 2147483647]) {
    const id = await configured(h, { [MIN_KEY]: value });
    const from = f.logs.length;
    const { data } = await readConfig(f.app, id);
    expect(data.legal.agreement).toEqual({ version: 5, min_version: value });
    expect(data.legal.privacy).toEqual({ version: 7, min_version: 3 });
    expect(configLogs(f.logs, from, id)).toEqual([]);
    // A request to another app must not contaminate the absent app's cached data.
    expect((await readConfig(f.app, absent)).data).toEqual(baseline.data);
  }
});

it.each([
  ['零', 0],
  ['负数', -1],
  ['小数', 1.5],
  ['字符串', '2'],
  ['null', null],
  ['布尔 true', true],
  ['布尔 false', false],
  ['超 int32', 2147483648],
  ['对象', { marker: 'minimum_fixture_value' }],
  ['数组', [2]],
] satisfies [string, unknown][])(
  '[AC-F1-02zr#8] 最低版本为%s仍返回 200 并省略，仅 warn 一次键名且不含原值',
  async (_label, value) => {
    const f = await signedConfigApp(h);
    const id = await configured(h, { [MIN_KEY]: value });
    const absent = await configured(h);
    const baseline = await readConfig(f.app, absent);
    const start = f.logs.length;
    const result = await readConfig(f.app, id);
    expect(result.data.legal.agreement).toEqual({ version: 5 });
    expectAppBoundConfig(baseline, absent, result, id, f.signing.publicKey);
    const entries = configLogs(f.logs, start, id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 40,
      event: 'content_config_value_invalid',
      app_id: id,
      config_key: MIN_KEY,
    });
    // Permit normal logger metadata only: malformed configuration payloads have no log field.
    const metadata = new Set([
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
    expect(
      Object.fromEntries(Object.entries(entries[0]!).filter(([key]) => !metadata.has(key))),
    ).toEqual({
      event: 'content_config_value_invalid',
      app_id: id,
      config_key: MIN_KEY,
    });
    expect(entries[0]?.['msg']).toBe('client configuration value malformed; default used');
    expect(f.logs.slice(start).join('\n')).not.toContain('minimum_fixture_value');
  },
);

it('[AC-F1-02zr#9] 仅改最低版本即改变 config_version，旧 ETag 返回新 200，缺行及非法值保持原 ETag', async () => {
  const f = await configApp(h);
  const id = await configured(h);
  const baseline = await readConfig(f.app, id);
  expect(baseline.data.legal.agreement).toEqual({ version: 5 });
  expect((await getConfig(f.app, id, { 'if-none-match': baseline.etag })).response.statusCode).toBe(
    304,
  );
  // A change in a row outside the delivered body must not perturb the original ETag.
  await config(h, id, 'unrelated_fixture_key', 1);
  f.clock.advanceMs(60_001);
  expect((await readConfig(f.app, id)).etag).toBe(baseline.etag);
  await config(h, id, MIN_KEY, 2);
  f.clock.advanceMs(60_001);
  const two = await readConfig(f.app, id, { 'if-none-match': baseline.etag });
  expect(two.data.legal.agreement).toEqual({ version: 5, min_version: 2 });
  expect(two.etag).not.toBe(baseline.etag);
  await h.db
    .updateTable('config_items')
    .set({ value: sql`${JSON.stringify(3)}::jsonb`, version: 2, row_version: 1 })
    .where('app_id', '=', id)
    .where('key', '=', MIN_KEY)
    .execute();
  f.clock.advanceMs(60_001);
  const three = await readConfig(f.app, id, { 'if-none-match': two.etag });
  expect(three.data.legal.agreement).toEqual({ version: 5, min_version: 3 });
  expect(three.data.config_version).not.toBe(two.data.config_version);
  const { config_version: versionTwo, ...bodyTwo } = two.data;
  const { config_version: versionThree, ...bodyThree } = three.data;
  expect(versionThree).not.toBe(versionTwo);
  expect(bodyThree).toEqual({
    ...bodyTwo,
    legal: { ...bodyTwo.legal, agreement: { version: 5, min_version: 3 } },
  });
  const unchanged = await getConfig(f.app, id, { 'if-none-match': three.etag });
  expect(unchanged.response.statusCode).toBe(304);
  expect(unchanged.response.headers['etag']).toBe(three.etag);
  // No deleteFrom: malformed data has exactly the same delivered shape as a missing row.
  await h.db
    .updateTable('config_items')
    .set({ value: sql`'null'::jsonb`, version: 3, row_version: 2 })
    .where('app_id', '=', id)
    .where('key', '=', MIN_KEY)
    .execute();
  f.clock.advanceMs(60_001);
  const reverted = await readConfig(f.app, id, { 'if-none-match': three.etag });
  expect(reverted.data).toEqual(baseline.data);
  expect(reverted.etag).toBe(baseline.etag);
});
