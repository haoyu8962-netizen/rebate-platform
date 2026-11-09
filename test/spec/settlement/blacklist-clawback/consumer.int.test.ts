// B2-04zzl consumer rule tests (claude-independent, SPEC_REF d5713bf4): 08 BR-ATTR-26 (rebate_status =
// CREDITED → 不自动扣回，写风控事件并进人工复核), contracts/openapi.yaml blacklistClawbackAdminReconDiff's
// description of the difference (CT-24zzf r2: ref_id carries the hit dimensions, so another
// combination is another difference), D10-1095, D10-1101. The real handler of
// order.blacklist_hit_after_credit on a real PostgreSQL; the order is credited by the real credit
// service. Expected values are written by hand. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  CHANNEL,
  PERIOD,
  SUFFIX,
  app,
  deliver,
  eventOf,
  everything,
  hitOf,
  refIdOf,
  suite,
} from './kit.ts';

const s = suite();

it('[AC-B2-04zzl#1] 订单仍 CREDITED：登记一张差错单，type blacklist_after_credit、source R3、status open、period 为登记时的会计月、ref_type order、ref_id `{order_key}#BLACKLIST#{维度}`、expected_fen 为当时的 booked_n_fen（不是预估佣金）、actual_fen 0、diff_fen = expected − actual、resolution 带 dimensions', async () => {
  const a = await app(s);
  const o = await a.h.credited();
  const order = await a.h.read(o);
  expect(order.booked_n_fen).toBe(1000n);
  expect(order.est_commission_fen).not.toBe(1000n);

  await deliver(a, eventOf(a, hitOf(o, [CHANNEL, SUFFIX])));

  const diffs = await a.h.reconDiffs();
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toMatchObject({
    type: 'blacklist_after_credit',
    source: 'R3',
    status: 'open',
    period: PERIOD,
    ref_type: 'order',
    ref_id: `${o.orderKey}#BLACKLIST#channel,order_no_suffix`,
    expected_fen: 1000n,
    actual_fen: 0n,
    diff_fen: 1000n,
    handler_id: null,
    closed_at: null,
  });
  expect(diffs[0]!.resolution).toMatchObject({ dimensions: [CHANNEL, SUFFIX] });
  expect(diffs[0]!.created_at).toEqual(a.h.clock.now());
});

it('[AC-B2-04zzl#2] ref_id 里的维度按字典序、英文逗号连接：事件里顺序相反也一样；只命中一个维度时不带逗号', async () => {
  const a = await app(s);
  const both = await a.h.credited();
  const single = await a.h.credited();

  await deliver(a, eventOf(a, hitOf(both, [SUFFIX, CHANNEL])));
  await deliver(a, eventOf(a, hitOf(single, [SUFFIX])));

  const refs = (await a.h.reconDiffs()).map((row) => row.ref_id).sort();
  expect(refs).toEqual(
    [
      `${both.orderKey}#BLACKLIST#channel,order_no_suffix`,
      `${single.orderKey}#BLACKLIST#order_no_suffix`,
    ].sort(),
  );
});

it('[AC-B2-04zzl#3] period 是登记时刻的 +08:00 会计月（packages/domain），不是 UTC 月：北京时间 7-31 23:59:59 记 2032-07，8-01 00:00:00（UTC 仍是 7-31）记 2032-08', async () => {
  const july = await app(s);
  const inJuly = await july.h.credited();
  july.h.clock.set('2032-07-31T23:59:59+08:00');
  await deliver(july, eventOf(july, hitOf(inJuly, [CHANNEL])));
  expect((await july.h.reconDiffs()).map((row) => row.period)).toEqual(['2032-07']);

  const august = await app(s);
  const inAugust = await august.h.credited();
  august.h.clock.set('2032-08-01T00:00:00+08:00');
  await deliver(august, eventOf(august, hitOf(inAugust, [CHANNEL])));
  expect((await august.h.reconDiffs()).map((row) => row.period)).toEqual(['2032-08']);
});

it('[AC-B2-04zzl#4] 重投幂等：同一事件再处理、换事件 id 的同内容事件、维度顺序不同的同一组合、跨到下个会计月再投，都不多一张，已登记的行不被覆盖', async () => {
  const a = await app(s);
  const o = await a.h.credited();
  const event = eventOf(a, hitOf(o, [CHANNEL, SUFFIX]));

  await deliver(a, event);
  const first = await a.h.reconDiffs();
  expect(first).toHaveLength(1);

  await deliver(a, event);
  expect(await a.h.reconDiffs()).toEqual(first);
  await deliver(a, eventOf(a, hitOf(o, [CHANNEL, SUFFIX])));
  expect(await a.h.reconDiffs()).toEqual(first);
  await deliver(a, eventOf(a, hitOf(o, [SUFFIX, CHANNEL])));
  expect(await a.h.reconDiffs()).toEqual(first);

  a.h.clock.set('2032-08-02T10:00:00+08:00');
  await deliver(a, event);
  expect(await a.h.reconDiffs()).toEqual(first);
});

it('[AC-B2-04zzl#5] 同一组合的差错单已结案后再投：仍是这一张，状态不被改回待处理（同组合只算重复，不另起一单复核）', async () => {
  const a = await app(s);
  const o = await a.h.credited();
  const event = eventOf(a, hitOf(o, [CHANNEL]));
  await deliver(a, event);
  const [row] = await a.h.reconDiffs();
  expect(row).toBeDefined();
  await a.h.db
    .updateTable('recon_diffs')
    .set({ status: 'closed', closed_at: a.h.clock.now(), updated_at: a.h.clock.now() })
    .where('app_id', '=', a.h.appId)
    .where('id', '=', row!.id)
    .execute();
  const closed = await a.h.reconDiffs();
  expect(closed).toHaveLength(1);
  expect(closed[0]!.status).toBe('closed');

  await deliver(a, event);
  expect(await a.h.reconDiffs()).toEqual(closed);
});

it('[AC-B2-04zzl#6] 换维度组合：先 channel，后 channel,order_no_suffix 登记第二张；第一张已结案（closed 或 adjusted）也不影响第二张登记，第一张不被改动（CT-24zzf r1 S1）', async () => {
  for (const status of ['closed', 'adjusted', 'open'] as const) {
    const a = await app(s);
    const o = await a.h.credited();
    await deliver(a, eventOf(a, hitOf(o, [CHANNEL])));
    const [first] = await a.h.reconDiffs();
    expect(first, status).toBeDefined();
    if (status !== 'open') {
      await a.h.db
        .updateTable('recon_diffs')
        .set({ status, closed_at: a.h.clock.now(), updated_at: a.h.clock.now() })
        .where('app_id', '=', a.h.appId)
        .where('id', '=', first!.id)
        .execute();
    }
    const firstNow = (await a.h.reconDiffs()).find((row) => row.id === first!.id);

    await deliver(a, eventOf(a, hitOf(o, [CHANNEL, SUFFIX])));

    const diffs = await a.h.reconDiffs();
    expect(diffs, status).toHaveLength(2);
    expect(
      diffs.find((row) => row.id === first!.id),
      status,
    ).toEqual(firstNow);
    const second = diffs.find((row) => row.id !== first!.id);
    expect(second, status).toMatchObject({
      type: 'blacklist_after_credit',
      status: 'open',
      ref_id: refIdOf(o, [CHANNEL, SUFFIX]),
      expected_fen: 1000n,
    });
    expect(second!.resolution, status).toMatchObject({ dimensions: [CHANNEL, SUFFIX] });
  }
});

it('[AC-B2-04zzl#7] 订单已不是 CREDITED（WAITING 未入账、CLAWED_BACK 已扣回）：不登记、不抛错，事件视为处理完', async () => {
  const a = await app(s);
  const waitingOrder = await a.h.order();
  const clawedBack = await a.h.credited();
  expect(
    await a.h.apply(clawedBack, { cause: 'INVALID_AFTER_SETTLE', ref: { kind: 'platform' } }),
  ).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
  expect((await a.h.read(waitingOrder)).rebate_status).toBe('WAITING');
  expect((await a.h.read(clawedBack)).rebate_status).toBe('CLAWED_BACK');

  await deliver(a, eventOf(a, hitOf(waitingOrder, [CHANNEL])));
  await deliver(a, eventOf(a, hitOf(clawedBack, [CHANNEL])));

  expect(await a.h.reconDiffs()).toEqual([]);
});

it('[AC-B2-04zzl#8] 只进人工复核：不写分录、不改订单、不冻结提现——除多一张差错单外什么都不变', async () => {
  const a = await app(s);
  const o = await a.h.credited();
  const before = await everything(a);

  await deliver(a, eventOf(a, hitOf(o, [CHANNEL])));

  const after = await everything(a);
  expect(after.diffs).toHaveLength(1);
  expect({ ...after, diffs: before.diffs }).toEqual(before);
  expect(after.holds).toEqual([]);
  expect((await a.h.read(o)).rebate_status).toBe('CREDITED');
});

it('[AC-B2-04zzl#9] 开关关时仍然登记差错单：开关只管确认接口（配置 false 与未设置都登记）', async () => {
  for (const value of [false, null] as const) {
    const a = await app(s, value);
    const o = await a.h.credited();
    await deliver(a, eventOf(a, hitOf(o, [CHANNEL])));
    const diffs = await a.h.reconDiffs();
    expect(diffs, String(value)).toHaveLength(1);
    expect(diffs[0], String(value)).toMatchObject({
      type: 'blacklist_after_credit',
      status: 'open',
    });
  }
});

it('[AC-B2-04zzl#10] 多租户：两个 app 各有一张已入账订单（sub_order_id 不同），事件只给 A 登记，金额取 A 的 booked_n_fen，B 什么都不变；A 收到指向 B 订单的事件也不写任何东西；再投给 B 才登记 B 的', async () => {
  const a = await app(s);
  const b = await app(s);
  // order_keys' primary key is (platform, sub_order_id), global: two apps cannot share an order_key.
  const inA = await a.h.credited({ subOrderId: `tenant-a-${randomUUID()}`, settleFen: 1000n });
  const inB = await b.h.credited({ subOrderId: `tenant-b-${randomUUID()}`, settleFen: 2000n });
  expect(inA.orderKey).not.toBe(inB.orderKey);
  const before = await everything(b);

  await deliver(a, eventOf(a, hitOf(inA, [CHANNEL])));

  const diffs = await a.h.reconDiffs();
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toMatchObject({ expected_fen: 1000n, ref_id: refIdOf(inA, [CHANNEL]) });
  expect(await everything(b)).toEqual(before);

  // Only an order lookup without app_id reaches B's order from A's event. Whether that delivery is
  // acknowledged or fails is not specified, so only "nothing is written" is pinned.
  const afterOwn = await everything(a);
  await deliver(a, eventOf(a, hitOf(inB, [CHANNEL]))).catch(() => undefined);
  expect(await everything(a)).toEqual(afterOwn);
  expect(await everything(b)).toEqual(before);

  await deliver(b, eventOf(b, hitOf(inB, [CHANNEL])));
  const inBDiffs = await b.h.reconDiffs();
  expect(inBDiffs).toHaveLength(1);
  expect(inBDiffs[0]).toMatchObject({ expected_fen: 2000n, ref_id: refIdOf(inB, [CHANNEL]) });
});
