// B2-04zze rule tests: reason_sub written with reason by the clawback after credit (R8 through the
// rights command's rights success entry and through the sync hook onUpdated; 08 BR-TEXT-05「子原因
// reason_sub」细则「写入来源 ①」; orchestrator D10-862: 淘宝违规按 violation_type 逐字匹配、对不上 →
// PUNISH_ORDER + warn; 淘宝维权（父编码 RIGHTS）→ AFTER_SALE; 失效：已结算 → AFTER_SETTLE，确认收货后、
// 结算前 → 不写; 京东、拼多多一律不写; 人工选过的不覆盖). Every order is credited first by the real
// credit service (N 1000, booked n 1000): a deduction of 5000 is R8 RIGHTS_FULL, 400 is R9. Only the
// display sub-reason is new: status, reason, the R9 diff code and the clawback vouchers stay as
// before.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  UNMAPPED_ALERT,
  WARN,
  databaseFixture,
  expectRedacted,
  harness,
  parentOrderNo,
  punishRightsNo,
  type SeededOrder,
  type SubHarness,
  type SubRecordSpec,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const FULL_RIGHTS = 5000n;
const PARTIAL_RIGHTS = 400n;

/** The R8 the clawback wrote: one history row of `event` after the credit, CLAWBACK vouchers. */
async function expectR8(h: SubHarness, o: SeededOrder, event: string): Promise<void> {
  expect(await h.rebateHistoryAfterCredit(o)).toEqual([
    expect.objectContaining({ from_status: 'CREDITED', event, to_status: 'CLAWED_BACK' }),
  ]);
  expect((await h.clawbackKeys(o)).length).toBeGreaterThan(0);
  expect(await h.rebateColumns(o)).toMatchObject({ booked_base_fen: 0n, booked_n_fen: 0n });
}

it(
  '[AC-B2-04zze#17] 淘宝入账后违规（violation_type「订单虚假交易」）：R8 扣回、原因码 PUNISH，同一处写子原因 FAKE_TRADE；不告警',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();

    expect(await h.record(o, { type: 'PUNISH', violationType: '订单虚假交易' })).toEqual({
      kind: 'applied',
    });
    expect(await h.columns(o)).toEqual({
      rebate_status: 'CLAWED_BACK',
      reason: 'PUNISH',
      reason_sub: 'FAKE_TRADE',
      reason_sub_manual: false,
    });
    await expectR8(h, o, 'PUNISH');
    expect(h.unmappedAlerts()).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zze#18] 淘宝入账后违规、violation_type 为编码形态「2」：子原因 PUNISH_ORDER；一条 warn（alert order_reason_sub_unmapped）带平台 taobao 与原值，任何字段值与整条日志都不带子单号、父单号、维权号（生产形状 <子单号>:<结算月>）、用户与金额',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited({ patch: { parent_order_id: parentOrderNo() } });

    expect(await h.record(o, { type: 'PUNISH', violationType: '2' })).toEqual({
      kind: 'applied',
    });
    expect(await h.columns(o)).toEqual({
      rebate_status: 'CLAWED_BACK',
      reason: 'PUNISH',
      reason_sub: 'PUNISH_ORDER',
      reason_sub_manual: false,
    });
    await expectR8(h, o, 'PUNISH');
    const alerts = h.unmappedAlerts();
    expect(alerts).toHaveLength(1);
    const line = alerts[0]!;
    expect(line).toMatchObject({ level: WARN, alert: UNMAPPED_ALERT, platform: 'taobao' });
    expect(Object.values(line)).toContain('2');
    expectRedacted(line, o);
    await h.expectAlertRedacted(line, o, '2');
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zze#19] 淘宝入账后维权：全额（R8 RIGHTS_FULL）原因码 RIGHTS、子原因 AFTER_SALE；部分（R9）原因码不写、差额原因 PART_REFUND，子原因也不写',
  async () => {
    const h = await harness(p.db);
    const full = await h.credited();
    const partial = await h.credited();

    expect(await h.record(full, { type: 'RIGHTS', deductionFen: FULL_RIGHTS })).toEqual({
      kind: 'applied',
    });
    expect(await h.columns(full)).toEqual({
      rebate_status: 'CLAWED_BACK',
      reason: 'RIGHTS',
      reason_sub: 'AFTER_SALE',
      reason_sub_manual: false,
    });
    await expectR8(h, full, 'RIGHTS_FULL');

    expect(await h.record(partial, { type: 'RIGHTS', deductionFen: PARTIAL_RIGHTS })).toEqual({
      kind: 'applied',
    });
    expect(await h.columns(partial)).toEqual({
      rebate_status: 'CREDITED',
      reason: null,
      reason_sub: null,
      reason_sub_manual: false,
    });
    expect(await h.rebateColumns(partial)).toMatchObject({ diff_reason_code: 'PART_REFUND' });
  },
  TIMEOUT,
);

it.each(['INVALID_AFTER_SETTLE', 'REFUND_AFTER_SETTLE'] as const)(
  '[AC-B2-04zze#20] 淘宝入账后收到 %s 维权记录：R8 全额扣回、原因码 REFUND，子原因 AFTER_SETTLE（结算后退款）',
  async (type) => {
    const h = await harness(p.db);
    const o = await h.credited();

    expect(await h.record(o, { type })).toEqual({ kind: 'applied' });
    expect(await h.columns(o)).toEqual({
      rebate_status: 'CLAWED_BACK',
      reason: 'REFUND',
      reason_sub: 'AFTER_SETTLE',
      reason_sub_manual: false,
    });
    await expectR8(h, o, type);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zze#21] 淘宝入账后订单同步失效：P7 结算后失效（失效前 SETTLED）→ 原因码 REFUND、子原因 AFTER_SETTLE；P6 确认收货后、结算前失效（失效前 RECEIVED）→ 原因码 REFUND、子原因不写（null）',
  async () => {
    const h = await harness(p.db);
    const settled = await h.credited();
    const received = await h.credited({ patch: { platform_status: 'RECEIVED' } });

    const p7 = await h.sync(settled, { event: 'PLATFORM_INVALID', rule: 'P7' });
    expect(p7.result).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
    expect(await h.columns(settled)).toEqual({
      rebate_status: 'CLAWED_BACK',
      reason: 'REFUND',
      reason_sub: 'AFTER_SETTLE',
      reason_sub_manual: false,
    });
    await expectR8(h, settled, 'INVALID_AFTER_SETTLE');

    const p6 = await h.sync(received, {
      event: 'PLATFORM_INVALID',
      rule: 'P6',
      platformStatus: 'INVALID',
    });
    expect(p6.result).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
    expect(await h.columns(received)).toEqual({
      rebate_status: 'CLAWED_BACK',
      reason: 'REFUND',
      reason_sub: null,
      reason_sub_manual: false,
    });
    await expectR8(h, received, 'PLATFORM_INVALID');
  },
  TIMEOUT,
);

type Trigger = 'punish' | 'rights' | 'invalid_after_settle';

/** One reverse event on a CREDITED order: a rights record, or the P7 sync. */
async function trigger(h: SubHarness, o: SeededOrder, kind: Trigger): Promise<void> {
  if (kind === 'invalid_after_settle') {
    const { result } = await h.sync(o, { event: 'PLATFORM_INVALID', rule: 'P7' });
    expect(result).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
    return;
  }
  const spec =
    kind === 'punish'
      ? ({ type: 'PUNISH', violationType: '订单虚假交易' } as const)
      : ({ type: 'RIGHTS', deductionFen: FULL_RIGHTS } as const);
  expect(await h.record(o, spec)).toEqual({ kind: 'applied' });
}

it.each([
  ['违规（violation_type「订单虚假交易」）', 'punish', 'PUNISH', 'FAKE_TRADE'],
  ['维权全额成功', 'rights', 'RIGHTS', 'AFTER_SALE'],
  ['订单同步结算后失效（P7）', 'invalid_after_settle', 'REFUND', 'AFTER_SETTLE'],
] as const)(
  '[AC-B2-04zze#22] 京东、拼多多入账后%s：照旧 R8 扣回、父编码 %s，子原因一律不写（null）、不告警；同样的淘宝单写 %s',
  async (_name, kind, reason, taobaoSub) => {
    const h = await harness(p.db);
    for (const platform of ['jd', 'pdd'] as const) {
      const o = await h.credited({ platform });
      await trigger(h, o, kind);
      expect(await h.columns(o), platform).toEqual({
        rebate_status: 'CLAWED_BACK',
        reason,
        reason_sub: null,
        reason_sub_manual: false,
      });
    }
    expect(h.unmappedAlerts()).toEqual([]);

    const taobao = await h.credited({ platform: 'taobao' });
    await trigger(h, taobao, kind);
    expect(await h.columns(taobao)).toEqual({
      rebate_status: 'CLAWED_BACK',
      reason,
      reason_sub: taobaoSub,
      reason_sub_manual: false,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zze#23] 人工选过子原因的淘宝入账单（reason_sub_manual=true、RISK_ORDER）：违规扣回时父编码照写 PUNISH，人工子原因不被覆盖；未人工选的同类单写 FAKE_TRADE',
  async () => {
    const h = await harness(p.db);
    const manual = await h.credited({
      patch: { reason_sub_manual: true, reason_sub: 'RISK_ORDER' },
    });
    const auto = await h.credited();

    for (const o of [manual, auto]) {
      expect(await h.record(o, { type: 'PUNISH', violationType: '订单虚假交易' })).toEqual({
        kind: 'applied',
      });
      await expectR8(h, o, 'PUNISH');
    }
    expect(await h.columns(manual)).toEqual({
      rebate_status: 'CLAWED_BACK',
      reason: 'PUNISH',
      reason_sub: 'RISK_ORDER',
      reason_sub_manual: true,
    });
    expect(await h.columns(auto)).toEqual({
      rebate_status: 'CLAWED_BACK',
      reason: 'PUNISH',
      reason_sub: 'FAKE_TRADE',
      reason_sub_manual: false,
    });
  },
  TIMEOUT,
);

const FOLLOW_UPS: readonly (readonly [string, SubRecordSpec])[] = [
  ['维权全额成功（扣 5000）', { type: 'RIGHTS', deductionFen: FULL_RIGHTS }],
  ['INVALID_AFTER_SETTLE', { type: 'INVALID_AFTER_SETTLE' }],
  ['REFUND_AFTER_SETTLE', { type: 'REFUND_AFTER_SETTLE' }],
];

it.each(FOLLOW_UPS)(
  '[AC-B2-04zze#25] 子原因只属当前父编码（已入账）：已 CLAWED_BACK、原因 PUNISH、子原因 PUNISH_ORDER 的淘宝单（R8 违规对不上扣回得到的，与直接置成该状态的），之后收到%s记录：子原因保持 PUNISH_ORDER（不被 AFTER_SALE / AFTER_SETTLE 覆盖），不再扣回；只有同为 PUNISH 的更具体子原因（后续违规「订单虚假交易」）才覆盖为 FAKE_TRADE',
  async (_name, followUp) => {
    const h = await harness(p.db);
    const clawed = await h.credited();
    expect(await h.record(clawed, { type: 'PUNISH', violationType: '1' })).toEqual({
      kind: 'applied',
    });
    await expectR8(h, clawed, 'PUNISH');
    const patched = await h.order({
      patch: { rebate_status: 'CLAWED_BACK', reason: 'PUNISH', reason_sub: 'PUNISH_ORDER' },
    });
    const fallback = {
      rebate_status: 'CLAWED_BACK',
      reason: 'PUNISH',
      reason_sub: 'PUNISH_ORDER',
      reason_sub_manual: false,
    };
    expect(await h.columns(clawed)).toEqual(fallback);
    const orders = [clawed, patched];
    const histories = await Promise.all(orders.map((o) => h.history(o)));
    const clawbacks = await Promise.all(orders.map((o) => h.clawbackKeys(o)));

    for (const o of orders) {
      expect(await h.record(o, followUp)).toEqual({ kind: 'applied' });
      expect(await h.columns(o)).toEqual(fallback);
    }
    for (const o of orders) {
      const later = { type: 'PUNISH', violationType: '订单虚假交易' } as const;
      expect(await h.record(o, { ...later, rightsNo: punishRightsNo(o, '203208') })).toEqual({
        kind: 'applied',
      });
      expect(await h.columns(o)).toEqual({ ...fallback, reason_sub: 'FAKE_TRADE' });
    }

    expect(await Promise.all(orders.map((o) => h.history(o)))).toEqual(histories);
    expect(await Promise.all(orders.map((o) => h.clawbackKeys(o)))).toEqual(clawbacks);
    expect(h.unmappedAlerts()).toHaveLength(1);
  },
  TIMEOUT,
);
