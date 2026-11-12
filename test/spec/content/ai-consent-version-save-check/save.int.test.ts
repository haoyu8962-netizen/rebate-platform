// B1-22zb 规则测试（规划/08 BR-AI-13 细则「当前版本的取值」② ③，D10-1329 (a)，SPEC_REF ea7850e2f45f）：
// 后台配置中心三条写入路（PUT /admin/v1/config-items/{key}、POST /batch、POST /{key}/rollback）
// 在生产装配的 admin 入口上对 legal.ai_third_party.version 只增不减：新值低于现值一律按配置保存
// 校验不通过拒绝，20001，什么都不写（当前值、历史、审计都不变）；等于或高于现值照常保存。
// 现值取存储行；缺行、或存储值不是 1..2147483647 的整数时按 1。
//
// fields 的读法沿用这三条路由已有的约定（F1-02zn / B2-11d，见 test/spec/payout/auto-config/
// save-wiring.int.test.ts 与 test/spec/content/bridge-origins/save.int.test.ts）：单值改是
// [value]，批量是被拒的键 [legal.ai_third_party.version]，回滚是 [to_version]；本校验对
// 用例层返回的被拒键就是该键（check.test.ts）。不另定错误码。
//
// 每条 it 都含一处「降值被拒」的断言，主干上没有本校验时为红。
// 只在编排者的隔离 PG / Redis 容器里跑。
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  batch,
  current,
  putRow,
  rejected,
  rollback,
  setup,
  snapshot,
  stepUp,
  success,
  update,
  versionsOf,
  written,
  type Item,
  type Setup,
} from '../config-items/kit.ts';

const h = useHarness();

const KEY = 'legal.ai_third_party.version';
/** Another config.risk Agent key (B1-22y, integer ≥ 0): lowering it stays allowed. */
const QUOTA = 'agent.member_daily_quota';
/**
 * A third config.risk key (B1-22y, integer ≥ 0). A batch may span only one permission point
 * (mixed batches are refused as 20001 [items] before the transaction), so #10 keeps to config.risk.
 */
const GUEST = 'agent.guest_daily_quota';
/** B2-03x: a version key without the only-up rule; lowering it stays allowed. */
const LABOR_VERSION = 'legal.labor_agreement.version';

/** PUT `key` = `value` with a fresh totp step-up (config.risk / config.business). */
async function put(f: Setup, key: string, value: unknown, expectedVersion: number) {
  return update(f, key, { value, expected_version: expectedVersion }, { stepUp: await stepUp(f) });
}

/**
 * A lowered write: 20001 fields [value], and nothing at all is written (the step-up is taken
 * before the snapshot, as in bridge-origins/save.int.test.ts).
 */
async function refusedPut(f: Setup, value: unknown, expectedVersion: number) {
  const extra = { stepUp: await stepUp(f) };
  const before = await snapshot(h, f.appId);
  await rejected(
    await update(f, KEY, { value, expected_version: expectedVersion }, extra),
    'update',
    20001,
    { fields: ['value'] },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
}

/** A write that is let through: the response and the row carry `value` at `version`. */
async function savedPut(f: Setup, value: unknown, expectedVersion: number, version: number) {
  const item = await success<Item>(await put(f, KEY, value, expectedVersion), 'update');
  expect(item).toMatchObject({ key: KEY, value, version });
  expect(await current(h, f.appId, KEY)).toMatchObject({ value, version });
}

it('[AC-B1-22zb#9] 单值改：现值 3 时写 2、写 1 → 20001 [value]，值仍 3、历史与审计不变；写 3 放行（不变）、写 4 放行', async () => {
  const f = await setup(h);
  await putRow(h, f.appId, KEY, 3);
  await refusedPut(f, 2, 1);
  await refusedPut(f, 1, 1);
  expect(await current(h, f.appId, KEY)).toMatchObject({ value: 3, version: 1 });
  // Same value: let through, nothing changes (version stays 1).
  await savedPut(f, 3, 1, 1);
  await savedPut(f, 4, 1, 2);
  // The raised value is the new floor: 3 is now refused.
  await refusedPut(f, 3, 2);
  expect(await current(h, f.appId, KEY)).toMatchObject({ value: 4, version: 2 });
});

it('[AC-B1-22zb#10] 批量（同为 config.risk：agent.member_daily_quota、agent.guest_daily_quota）含该键降值 → 整批 20001 [legal.ai_third_party.version]，同批其他键也不写；不降则整批保存，同批降别的键照常', async () => {
  const f = await setup(h);
  await putRow(h, f.appId, KEY, 3);
  await putRow(h, f.appId, QUOTA, 50);
  await putRow(h, f.appId, GUEST, 20);
  const extra = { stepUp: await stepUp(f) };
  const before = await snapshot(h, f.appId);
  await rejected(
    await batch(
      f,
      {
        items: [
          { key: QUOTA, value: 10, expected_version: 1 },
          { key: KEY, value: 2, expected_version: 1 },
          { key: GUEST, value: 5, expected_version: 1 },
        ],
      },
      extra,
    ),
    'batch',
    20001,
    { fields: [KEY] },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(await current(h, f.appId, KEY)).toMatchObject({ value: 3, version: 1 });
  expect(await current(h, f.appId, QUOTA)).toMatchObject({ value: 50, version: 1 });
  expect(await current(h, f.appId, GUEST)).toMatchObject({ value: 20, version: 1 });

  const saved = await success<{ items: Item[] }>(
    await batch(
      f,
      {
        items: [
          { key: QUOTA, value: 10, expected_version: 1 },
          { key: KEY, value: 4, expected_version: 1 },
          { key: GUEST, value: 5, expected_version: 1 },
        ],
      },
      { stepUp: await stepUp(f) },
    ),
    'batch',
  );
  expect(saved.items.map(({ key, value, version }) => ({ key, value, version }))).toStrictEqual([
    { key: QUOTA, value: 10, version: 2 },
    { key: KEY, value: 4, version: 2 },
    { key: GUEST, value: 5, version: 2 },
  ]);
  expect(await current(h, f.appId, KEY)).toMatchObject({ value: 4, version: 2 });
  expect(await current(h, f.appId, QUOTA)).toMatchObject({ value: 10, version: 2 });
  expect(await current(h, f.appId, GUEST)).toMatchObject({ value: 5, version: 2 });
});

it('[AC-B1-22zb#11] 批量只含该键：现值 5 时写 4 → 20001 [该键]、不写；写 5 放行', async () => {
  const f = await setup(h);
  await putRow(h, f.appId, KEY, 5);
  const extra = { stepUp: await stepUp(f) };
  const before = await snapshot(h, f.appId);
  await rejected(
    await batch(f, { items: [{ key: KEY, value: 4, expected_version: 1 }] }, extra),
    'batch',
    20001,
    { fields: [KEY] },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  await success(
    await batch(
      f,
      { items: [{ key: KEY, value: 5, expected_version: 1 }] },
      { stepUp: await stepUp(f) },
    ),
    'batch',
  );
  expect(await current(h, f.appId, KEY)).toMatchObject({ value: 5, version: 1 });
});

it('[AC-B1-22zb#12] 回滚到低于现值的历史版本 → 20001 [to_version]，值、历史、审计都不变；回滚到不低于现值的历史版本放行', async () => {
  const f = await setup(h);
  // History: v1 = 2, v2 = 5, v3 = 3 (current, written directly as an older system may have).
  await written(h, f.appId, KEY, [2, 5, 3], f.actor);
  const extra = { stepUp: await stepUp(f) };
  const before = await snapshot(h, f.appId);
  await rejected(
    await rollback(f, KEY, { to_version: 1, expected_version: 3 }, extra),
    'rollback',
    20001,
    { fields: ['to_version'] },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(await current(h, f.appId, KEY)).toMatchObject({ value: 3, version: 3 });
  expect(await versionsOf(h, f.appId, KEY)).toHaveLength(3);

  const restored = await success<Item>(
    await rollback(f, KEY, { to_version: 2, expected_version: 3 }, { stepUp: await stepUp(f) }),
    'rollback',
  );
  expect(restored).toMatchObject({ key: KEY, value: 5, version: 4 });
  expect(await current(h, f.appId, KEY)).toMatchObject({ value: 5, version: 4 });

  // Now 5 is current: rolling back to v3 (= 3) is lowering too.
  const again = { stepUp: await stepUp(f) };
  const after = await snapshot(h, f.appId);
  await rejected(
    await rollback(f, KEY, { to_version: 3, expected_version: 4 }, again),
    'rollback',
    20001,
    { fields: ['to_version'] },
  );
  expect(await snapshot(h, f.appId)).toEqual(after);
});

it('[AC-B1-22zb#13] 回滚到与现值相同的历史值放行（记一个新版本）；回滚到更低的值仍拒绝', async () => {
  const f = await setup(h);
  await written(h, f.appId, KEY, [1, 4, 4], f.actor);
  const extra = { stepUp: await stepUp(f) };
  const before = await snapshot(h, f.appId);
  await rejected(
    await rollback(f, KEY, { to_version: 1, expected_version: 3 }, extra),
    'rollback',
    20001,
    { fields: ['to_version'] },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  const restored = await success<Item>(
    await rollback(f, KEY, { to_version: 2, expected_version: 3 }, { stepUp: await stepUp(f) }),
    'rollback',
  );
  expect(restored).toMatchObject({ key: KEY, value: 4, version: 4 });
});

it('[AC-B1-22zb#14] 没有存储行时现值按 1：写 0 是范围拒绝 [value]，写 1 放行；其后写 3，再写 2 被拒', async () => {
  const f = await setup(h);
  expect(await current(h, f.appId, KEY)).toBeUndefined();
  // 0 is outside the registry range (1..2147483647): the existing range refusal, not this check.
  await rejected(await put(f, KEY, 0, 0), 'update', 20001, { fields: ['value'] });
  expect(await current(h, f.appId, KEY)).toBeUndefined();
  await savedPut(f, 1, 0, 1);
  await savedPut(f, 3, 1, 2);
  await refusedPut(f, 2, 2);
  expect(await current(h, f.appId, KEY)).toMatchObject({ value: 3, version: 2 });
});

// ② a stored value outside 1..2147483647 (or not an integer) counts as unset, i.e. 1. The cases
// that a plain comparison gets wrong: '3' is not 3, 1.5 and 2147483648 are not compared as is.
it.each([
  { label: '0', value: 0, low: 1 },
  { label: '负数', value: -4, low: 1 },
  { label: '小数 1.5', value: 1.5, low: 1 },
  { label: '小数 3.5', value: 3.5, low: 2 },
  { label: '超过 int32', value: 2147483648, low: 2 },
  { label: '数字字符串 "3"', value: '3', low: 2 },
  { label: '普通字符串', value: 'v9', low: 1 },
])(
  '[AC-B1-22zb#15] 存储值不合法（$label）按 1：写 $low 放行；其后写 6，再写 5 被拒 [value]',
  async ({ value, low }) => {
    const f = await setup(h);
    await putRow(h, f.appId, KEY, value);
    await savedPut(f, low, 1, 2);
    await savedPut(f, 6, 2, 3);
    await refusedPut(f, 5, 3);
    expect(await current(h, f.appId, KEY)).toMatchObject({ value: 6, version: 3 });
  },
);

it('[AC-B1-22zb#16] 只对该键生效：现值 7 时降 agent.member_daily_quota 与 legal.labor_agreement.version 照常保存，降该键被拒', async () => {
  const f = await setup(h);
  await putRow(h, f.appId, KEY, 7);
  await putRow(h, f.appId, QUOTA, 50);
  await putRow(h, f.appId, LABOR_VERSION, 3);
  const quota = await success<Item>(await put(f, QUOTA, 5, 1), 'update');
  expect(quota).toMatchObject({ key: QUOTA, value: 5, version: 2 });
  const labor = await success<Item>(await put(f, LABOR_VERSION, 2, 1), 'update');
  expect(labor).toMatchObject({ key: LABOR_VERSION, value: 2, version: 2 });
  await refusedPut(f, 6, 1);
  expect(await current(h, f.appId, KEY)).toMatchObject({ value: 7, version: 1 });
});
