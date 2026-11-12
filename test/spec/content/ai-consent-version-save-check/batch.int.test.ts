// B1-22zb 规则测试第 2 轮（编排 D10-1349 ①；规划/08 BR-AI-13 细则「当前版本的取值」③，
// SPEC_REF ea7850e2f45f）：批量保存里降 legal.ai_third_party.version 整批拒绝。
// 一批只能属一个权限点（混了在进事务前就整批 20001 fields=[items]），所以同批的其他键都取
// config.risk 的键（agent.member_daily_quota、agent.guest_daily_quota，B1-22y），保证这一批
// 能走到本校验：骨架上红的原因只能是「该拒没拒」。
// 拒绝时 fields 是被拒的键 [legal.ai_third_party.version]（批量路的现有语义），什么都不写。
// 只在编排者的隔离 PG / Redis 容器里跑。
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  batch,
  current,
  putRow,
  rejected,
  setup,
  snapshot,
  stepUp,
  success,
  type Item,
} from '../config-items/kit.ts';

const h = useHarness();

const KEY = 'legal.ai_third_party.version';
/** Two more config.risk keys (B1-22y, integers ≥ 0): the batch stays on one permission point. */
const QUOTA = 'agent.member_daily_quota';
const GUEST = 'agent.guest_daily_quota';

it('[AC-B1-22zb#18] 批量（同为 config.risk）含该键降值 → 整批 20001 [legal.ai_third_party.version]，同批其他键也不写；不降则整批保存，同批降别的键照常', async () => {
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
