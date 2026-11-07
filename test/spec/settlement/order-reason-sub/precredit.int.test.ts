// B2-04zze rule tests: reason_sub written with reason by settlement before credit (R6 through the
// rebate port, called by the rights command) and on terminal orders (08 BR-TEXT-05「子原因 reason_sub」
// 细则「写入来源 ①」与「同一订单后续同步得到更具体的子原因时可覆盖 PUNISH_ORDER，人工选过的不被自动覆盖」;
// orchestrator D10-862: ① 淘宝违规按 violation_type 逐字匹配，对不上 → PUNISH_ORDER + warn
// order_reason_sub_unmapped（带平台与原值、不带单号 / 金额）; ② 淘宝维权（父编码 RIGHTS）→ AFTER_SALE;
// 结算后失效 → REFUND / AFTER_SETTLE; ③ 京东、拼多多一律不写; 子原因必须属于当前父编码). Default order
// (credit kit): WAITING, platform SETTLED, N 1000; a deduction of 5000 is a full rights success.
// Only the display sub-reason is new: status, reason, history and events are asserted as before.
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

/** VOID by R6 with `reason`, one rebate history row of `event`, one order.invalidated. */
async function expectVoided(
  h: SubHarness,
  o: SeededOrder,
  event: string,
  reason: string,
  published: number,
): Promise<void> {
  expect(await h.history(o)).toEqual([
    expect.objectContaining({ field: 'rebate', from_status: 'WAITING', event, to_status: 'VOID' }),
  ]);
  expect(h.publishedSince(published)).toEqual(['order.invalidated']);
  expect(h.publish).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      name: 'order.invalidated',
      payload: expect.objectContaining({ order_id: o.orderId, reason }),
    }),
  );
  expect(await h.orderVoucherKeys(o)).toEqual([]);
}

it(
  '[AC-B2-04zze#9] 淘宝入账前违规（violation_type「订单虚假交易」）：同一次 R6 置 VOID、原因码 PUNISH，子原因 FAKE_TRADE（非人工）；不告警，历史、事件与分录照旧',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const published = h.publish.mock.calls.length;

    expect(await h.record(o, { type: 'PUNISH', violationType: '订单虚假交易' })).toEqual({
      kind: 'applied',
    });
    expect(await h.columns(o)).toEqual({
      rebate_status: 'VOID',
      reason: 'PUNISH',
      reason_sub: 'FAKE_TRADE',
      reason_sub_manual: false,
    });
    await expectVoided(h, o, 'PUNISH', 'PUNISH', published);
    expect(h.unmappedAlerts()).toEqual([]);
  },
  TIMEOUT,
);

it.each([
  ['编码形态 1', '1'],
  ['编码形态 2', '2'],
  ['空串', ''],
  ['未录制的合成文本', '合成违规类型-乙'],
] as const)(
  '[AC-B2-04zze#10] 淘宝入账前违规、violation_type 对不上（%s）：子原因落 PUNISH_ORDER；一条 warn（alert order_reason_sub_unmapped）带平台与原值，任何字段值与整条日志都不带子单号、父单号、维权号（生产形状 <子单号>:<结算月>）、用户与金额',
  async (_name, raw) => {
    const h = await harness(p.db);
    const o = await h.order({ patch: { parent_order_id: parentOrderNo() } });
    const published = h.publish.mock.calls.length;

    expect(await h.record(o, { type: 'PUNISH', violationType: raw })).toEqual({ kind: 'applied' });
    expect(await h.columns(o)).toEqual({
      rebate_status: 'VOID',
      reason: 'PUNISH',
      reason_sub: 'PUNISH_ORDER',
      reason_sub_manual: false,
    });
    await expectVoided(h, o, 'PUNISH', 'PUNISH', published);
    const alerts = h.unmappedAlerts();
    expect(alerts).toHaveLength(1);
    const line = alerts[0]!;
    expect(line).toMatchObject({ level: WARN, alert: UNMAPPED_ALERT, platform: 'taobao' });
    expect(Object.values(line)).toContain(raw);
    expectRedacted(line, o);
    await h.expectAlertRedacted(line, o, raw);
  },
  TIMEOUT,
);

it.each([
  ['空值 null', { violationType: null }],
  ['入参不带 violation_type', {}],
] as const)(
  '[AC-B2-04zze#11] 淘宝入账前违规、没有违规文本（%s）：子原因落 PUNISH_ORDER，并告警 order_reason_sub_unmapped（平台 taobao）；任何字段值与整条日志都不带子单号、父单号、维权号与金额',
  async (_name, extra) => {
    const h = await harness(p.db);
    const o = await h.order({ patch: { parent_order_id: parentOrderNo() } });
    const spec: SubRecordSpec = { type: 'PUNISH', ...extra };

    expect(await h.record(o, spec)).toEqual({ kind: 'applied' });
    expect(await h.columns(o)).toMatchObject({
      rebate_status: 'VOID',
      reason: 'PUNISH',
      reason_sub: 'PUNISH_ORDER',
    });
    const alerts = h.unmappedAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ level: WARN, alert: UNMAPPED_ALERT, platform: 'taobao' });
    expectRedacted(alerts[0]!, o);
    await h.expectAlertRedacted(alerts[0]!, o, null);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zze#12] 淘宝入账前维权全额成功：R6 RIGHTS_FULL 置 VOID、原因码 RIGHTS 不变，子原因 AFTER_SALE；不告警',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const published = h.publish.mock.calls.length;

    expect(await h.record(o, { type: 'RIGHTS', deductionFen: FULL_RIGHTS })).toEqual({
      kind: 'applied',
    });
    expect(await h.columns(o)).toEqual({
      rebate_status: 'VOID',
      reason: 'RIGHTS',
      reason_sub: 'AFTER_SALE',
      reason_sub_manual: false,
    });
    await expectVoided(h, o, 'RIGHTS_FULL', 'RIGHTS', published);
    expect(h.unmappedAlerts()).toEqual([]);
  },
  TIMEOUT,
);

it.each(['INVALID_AFTER_SETTLE', 'REFUND_AFTER_SETTLE'] as const)(
  '[AC-B2-04zze#13] 淘宝已结算未入账收到 %s：R6 PLATFORM_INVALID 置 VOID、原因码 REFUND，子原因 AFTER_SETTLE（结算后退款）',
  async (type) => {
    const h = await harness(p.db);
    const o = await h.order();
    const published = h.publish.mock.calls.length;

    expect(await h.record(o, { type })).toEqual({ kind: 'applied' });
    expect(await h.columns(o)).toEqual({
      rebate_status: 'VOID',
      reason: 'REFUND',
      reason_sub: 'AFTER_SETTLE',
      reason_sub_manual: false,
    });
    await expectVoided(h, o, 'PLATFORM_INVALID', 'REFUND', published);
  },
  TIMEOUT,
);

it.each([
  [
    '违规（violation_type「订单虚假交易」）',
    { type: 'PUNISH', violationType: '订单虚假交易' },
    'PUNISH',
    'FAKE_TRADE',
  ],
  ['维权全额成功', { type: 'RIGHTS', deductionFen: FULL_RIGHTS }, 'RIGHTS', 'AFTER_SALE'],
  ['结算后退款', { type: 'REFUND_AFTER_SETTLE' }, 'REFUND', 'AFTER_SETTLE'],
] as const)(
  '[AC-B2-04zze#14] 京东、拼多多入账前%s：照旧作废、父编码 %s，子原因一律不写（null）、不告警；同样的淘宝单写 %s',
  async (_name, spec, reason, taobaoSub) => {
    const h = await harness(p.db);
    for (const platform of ['jd', 'pdd'] as const) {
      const o = await h.order({ platform });
      expect(await h.record(o, spec)).toEqual({ kind: 'applied' });
      expect(await h.columns(o), platform).toEqual({
        rebate_status: 'VOID',
        reason,
        reason_sub: null,
        reason_sub_manual: false,
      });
    }
    expect(h.unmappedAlerts()).toEqual([]);

    const taobao = await h.order({ platform: 'taobao' });
    expect(await h.record(taobao, spec)).toEqual({ kind: 'applied' });
    expect(await h.columns(taobao)).toEqual({
      rebate_status: 'VOID',
      reason,
      reason_sub: taobaoSub,
      reason_sub_manual: false,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zze#15] 人工选过子原因（reason_sub_manual=true）的淘宝单：违规作废时父编码照写 PUNISH，人工子原因（RISK_ORDER，或人工选的「无」= null）不被自动映射覆盖；未人工选的同类单写 FAKE_TRADE',
  async () => {
    const h = await harness(p.db);
    const picked = await h.order({ patch: { reason_sub_manual: true, reason_sub: 'RISK_ORDER' } });
    const none = await h.order({ patch: { reason_sub_manual: true, reason_sub: null } });
    const auto = await h.order();

    for (const o of [picked, none, auto]) {
      expect(await h.record(o, { type: 'PUNISH', violationType: '订单虚假交易' })).toEqual({
        kind: 'applied',
      });
    }
    expect(await h.columns(picked)).toEqual({
      rebate_status: 'VOID',
      reason: 'PUNISH',
      reason_sub: 'RISK_ORDER',
      reason_sub_manual: true,
    });
    expect(await h.columns(none)).toEqual({
      rebate_status: 'VOID',
      reason: 'PUNISH',
      reason_sub: null,
      reason_sub_manual: true,
    });
    expect(await h.columns(auto)).toEqual({
      rebate_status: 'VOID',
      reason: 'PUNISH',
      reason_sub: 'FAKE_TRADE',
      reason_sub_manual: false,
    });
  },
  TIMEOUT,
);

it.each(['VOID', 'CLAWED_BACK'] as const)(
  '[AC-B2-04zze#16] 终态 %s、原因 PUNISH / PUNISH_ORDER 的淘宝单，后续违规记录对上「订单虚假交易」：子原因改为 FAKE_TRADE；返利状态、原因码、历史与事件不变。人工选过的 PUNISH_ORDER 不改；已是具体子原因的不被对不上的文本改回 PUNISH_ORDER；REFUND 单不写 PUNISH 子原因',
  async (terminal) => {
    const h = await harness(p.db);
    const fallback = await h.order({
      patch: { rebate_status: terminal, reason: 'PUNISH', reason_sub: 'PUNISH_ORDER' },
    });
    const manual = await h.order({
      patch: {
        rebate_status: terminal,
        reason: 'PUNISH',
        reason_sub: 'PUNISH_ORDER',
        reason_sub_manual: true,
      },
    });
    const specific = await h.order({
      patch: { rebate_status: terminal, reason: 'PUNISH', reason_sub: 'FAKE_TRADE' },
    });
    const refund = await h.order({ patch: { rebate_status: terminal, reason: 'REFUND' } });
    const histories = await Promise.all(
      [fallback, manual, specific, refund].map((o) => h.history(o)),
    );
    const published = h.publish.mock.calls.length;

    expect(await h.record(fallback, { type: 'PUNISH', violationType: '订单虚假交易' })).toEqual({
      kind: 'applied',
    });
    expect(await h.columns(fallback)).toEqual({
      rebate_status: terminal,
      reason: 'PUNISH',
      reason_sub: 'FAKE_TRADE',
      reason_sub_manual: false,
    });

    expect(await h.record(manual, { type: 'PUNISH', violationType: '订单虚假交易' })).toEqual({
      kind: 'applied',
    });
    expect(await h.columns(manual)).toEqual({
      rebate_status: terminal,
      reason: 'PUNISH',
      reason_sub: 'PUNISH_ORDER',
      reason_sub_manual: true,
    });

    expect(await h.record(specific, { type: 'PUNISH', violationType: '1' })).toEqual({
      kind: 'applied',
    });
    expect(await h.columns(specific)).toEqual({
      rebate_status: terminal,
      reason: 'PUNISH',
      reason_sub: 'FAKE_TRADE',
      reason_sub_manual: false,
    });

    expect(await h.record(refund, { type: 'PUNISH', violationType: '订单虚假交易' })).toEqual({
      kind: 'applied',
    });
    expect(await h.columns(refund)).toEqual({
      rebate_status: terminal,
      reason: 'REFUND',
      reason_sub: null,
      reason_sub_manual: false,
    });

    expect(
      await Promise.all([fallback, manual, specific, refund].map((o) => h.history(o))),
    ).toEqual(histories);
    expect(h.publishedSince(published)).toEqual([]);
    for (const o of [fallback, manual, specific, refund]) {
      expect(await h.orderVoucherKeys(o)).toEqual([]);
    }
  },
  TIMEOUT,
);

const FOLLOW_UPS: readonly (readonly [string, SubRecordSpec])[] = [
  ['维权全额成功（扣 5000）', { type: 'RIGHTS', deductionFen: FULL_RIGHTS }],
  ['INVALID_AFTER_SETTLE', { type: 'INVALID_AFTER_SETTLE' }],
  ['REFUND_AFTER_SETTLE', { type: 'REFUND_AFTER_SETTLE' }],
];

it.each(FOLLOW_UPS)(
  '[AC-B2-04zze#24] 子原因只属当前父编码：已 VOID、原因 PUNISH、子原因 PUNISH_ORDER 的淘宝单（R6 违规对不上作废得到的，与直接置成该状态的），之后收到%s记录：子原因保持 PUNISH_ORDER（父编码仍是 PUNISH，不被 AFTER_SALE / AFTER_SETTLE 覆盖）；只有同为 PUNISH 的更具体子原因（后续违规「订单虚假交易」）才覆盖为 FAKE_TRADE',
  async (_name, followUp) => {
    const h = await harness(p.db);
    const voided = await h.order();
    expect(await h.record(voided, { type: 'PUNISH', violationType: '1' })).toEqual({
      kind: 'applied',
    });
    const patched = await h.order({
      patch: { rebate_status: 'VOID', reason: 'PUNISH', reason_sub: 'PUNISH_ORDER' },
    });
    const fallback = {
      rebate_status: 'VOID',
      reason: 'PUNISH',
      reason_sub: 'PUNISH_ORDER',
      reason_sub_manual: false,
    };
    expect(await h.columns(voided)).toEqual(fallback);
    const orders = [voided, patched];
    const histories = await Promise.all(orders.map((o) => h.history(o)));
    const published = h.publish.mock.calls.length;

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
    expect(h.publishedSince(published)).toEqual([]);
    for (const o of orders) expect(await h.orderVoucherKeys(o)).toEqual([]);
    expect(h.unmappedAlerts()).toHaveLength(1);
  },
  TIMEOUT,
);
