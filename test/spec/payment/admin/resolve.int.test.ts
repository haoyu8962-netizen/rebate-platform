// B2-15f resolve rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-05 ③ (needs_manual
// 由有处置权限的账号在后台【立即查询】后按渠道结果结束：已支付 → PO2；已关闭，或符合 ② 的不存在条件 → PO3；
// 操作需 step-up、写审计，凭证为查询响应), BR-PAY-05 ② (「单据不存在」不等于已关闭：过了 expire_at +
// pay.close_grace_minutes 且再次查询仍不存在才 PO3), BR-PAY-04 (判定为成功前逐项核对), BR-PAY-07
// (PAY_RECEIPT 每张支付单至多一张); 规划/04 §11.2 (pay.resolve, step-up totp); contracts/openapi.yaml
// resolveAdminPayOrder (10001 / 10003 / 10403 / 20001 / 20902; body fixed; every call audited as
// pay_order_resolve with the query result and the status before and after, the unchanged outcome
// included; the evidence is the query response kept with the pay_query_attempts row).
// Requests go through the real admin entry (kit.ts withAdmin). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import {
  BIZ,
  fixture,
  payOrder,
  seedOrder,
  setConfig,
  suite,
  type Fixture,
  type OrderRow,
} from '../orders/kit.ts';
import {
  anomalies,
  attemptsOf,
  paidEvents,
  queuedByKey,
  receiptOf,
  tradeNo,
  userTraces,
  vouchers,
} from '../result/kit.ts';
import {
  AMOUNT,
  AUDIT_ACTION,
  CHANNELS,
  CLOSED_STATE,
  CONFLICT,
  NOT_PAID,
  ORDER_KEYS,
  REFUND,
  RESOLVE,
  RESOLVE_BODY,
  RESULT_KEYS,
  STEP_UP_TOTP,
  STEP_UP_TTL_MS,
  SUCCESS,
  VIEW,
  adminChannels,
  answer,
  auditText,
  keysOf,
  normalize,
  ok,
  orderOf,
  orderView,
  resolveAudits,
  seedNeedsManual,
  withAdmin,
  type AdminChannels,
  type AuditRow,
} from './kit.ts';

const s = suite();

/** Nothing of a settlement: no voucher, no paid event, no business job, no anomaly. */
async function nothingSettled(f: Fixture, order: OrderRow): Promise<void> {
  expect(await vouchers(f)).toEqual([]);
  expect(await paidEvents(f)).toEqual([]);
  expect(await queuedByKey(f, `biz:${order.app_id}:${BIZ}:${order.biz_ref}`)).toEqual([]);
  expect(await anomalies(f)).toEqual([]);
  expect(await userTraces(f)).toEqual({ user_accounts: 0, balances: 0, user_entries: 0 });
}

/** The PO2 of BR-PAY-04 happened once: one PAY_RECEIPT, one paid event, one business job. */
async function settledOnce(f: Fixture, order: OrderRow): Promise<void> {
  const row = await payOrder(f, order.id);
  expect(row.status).toBe('PAID');
  expect(await vouchers(f)).toEqual([receiptOf(row)]);
  expect((await paidEvents(f)).map((event) => event['pay_order_id'])).toEqual([order.id]);
  expect(
    (await queuedByKey(f, `biz:${order.app_id}:${BIZ}:${order.biz_ref}`)).map((job) => [
      job.job,
      job.singleton_key,
    ]),
  ).toEqual([['biz.reconcile', `biz:${order.app_id}:${BIZ}:${order.biz_ref}`]]);
  expect(await anomalies(f)).toEqual([]);
  expect(await userTraces(f)).toEqual({ user_accounts: 0, balances: 0, user_entries: 0 });
}

/** A refused call: the channel was not asked, nothing recorded, the order as it was. */
async function refused(f: Fixture, channels: AdminChannels, order: OrderRow): Promise<void> {
  expect(channels.wechat_pay.queried).toEqual([]);
  expect(channels.alipay.queried).toEqual([]);
  expect(channels.wechat_pay.closeCalls).toEqual([]);
  expect(channels.alipay.closeCalls).toEqual([]);
  expect(await attemptsOf(f, order.id)).toEqual([]);
  expect(await resolveAudits(f)).toEqual([]);
  expect(await payOrder(f, order.id)).toEqual(order);
}

/** The one resolve audit record: the caller, the instant, the order, before / after and result. */
function audited(
  audit: AuditRow | undefined,
  facts: {
    readonly adminId: string;
    readonly at: Date;
    readonly order: OrderRow;
    readonly after: string;
    readonly results: readonly string[];
  },
): void {
  expect(audit).toBeDefined();
  expect(audit).toMatchObject({ admin_id: facts.adminId, action: AUDIT_ACTION });
  expect(audit!.at.getTime()).toBe(facts.at.getTime());
  const text = auditText(audit!);
  expect(text).toContain(facts.order.id);
  expect(text).toContain('PENDING');
  expect(text).toContain(facts.after);
  expect(
    facts.results.some((result) => text.includes(result)),
    `${text} names the query result (${facts.results.join(' / ')})`,
  ).toBe(true);
}

it.each(CHANNELS)(
  '[AC-B2-15f#1] %s needs_manual 支付单【立即查询】渠道已支付（我方标识、金额相符、成功状态）→ PO2：支付单 PAID（paid_at、渠道交易号），同一事务一张 PAY_RECEIPT、一个 pay_order.paid、一个 biz.reconcile；只查询一次（一条 kind=query 渠道请求，查询应答留作凭证）、不调关单；应答为处置后的支付单与查询摘要（不含渠道侧用户标识）；一条审计（处置人、前后状态、查询结果）；step-up 令牌用后作废，再处置 20902',
  async (channel) => {
    const f = await fixture(s);
    const channels = adminChannels(f);
    const order = await seedNeedsManual(f, channel);
    const trade = channels[channel].script(order, 'paid');
    f.clock.advanceMs(60_000);
    await withAdmin(f, channels, async (h) => {
      const token = await h.stepUp(h.resolver);
      const data = await ok(await h.resolve(order.id, { stepUp: token }));
      const row = await payOrder(f, order.id);
      expect(row).toMatchObject({
        status: 'PAID',
        paid_at: f.clock.now(),
        closed_at: null,
        channel_trade_no: trade,
        amount_fen: AMOUNT,
        refunded_fen: 0n,
        out_trade_no: order.out_trade_no,
      });
      expect(keysOf(data['pay_order'])).toEqual([...ORDER_KEYS]);
      expect(orderOf(data['pay_order'])).toEqual(orderView(row));
      expect(keysOf(data['channel_result'])).toEqual([...RESULT_KEYS]);
      expect(normalize(data['channel_result'], ['queried_at'])).toEqual({
        state: 'paid',
        channel_state: SUCCESS[channel],
        channel_trade_no: trade,
        queried_at: f.clock.now().getTime(),
      });
      expect(channels[channel].queried).toEqual([order.out_trade_no]);
      expect(channels[channel].closeCalls).toEqual([]);
      const attempts = await attemptsOf(f, order.id);
      expect(attempts.map((attempt) => [attempt.kind, attempt.at.getTime()])).toEqual([
        ['query', f.clock.now().getTime()],
      ]);
      // The evidence: the query response the server recorded, kept with the attempt.
      const evidence = JSON.stringify(attempts[0]?.response ?? null);
      expect(evidence).toContain(SUCCESS[channel]);
      expect(evidence).toContain(trade);
      const audits = await resolveAudits(f);
      expect(audits).toHaveLength(1);
      audited(audits[0], {
        adminId: h.resolver.id,
        at: f.clock.now(),
        order,
        after: 'PAID',
        results: ['paid', SUCCESS[channel]],
      });
      // The token was consumed by the successful call.
      await answer(await h.resolve(order.id, { stepUp: token }), 10003, STEP_UP_TOTP);
      // No longer PENDING: refused before any query, no second audit.
      await answer(await h.resolve(order.id), 20902, CONFLICT);
      expect(channels[channel].queried).toHaveLength(1);
      expect(await resolveAudits(f)).toHaveLength(1);
    });
    await settledOnce(f, order);
  },
);

it.each(CHANNELS)(
  '[AC-B2-15f#2] %s needs_manual 支付单【立即查询】渠道明确「已关闭」→ PO3：支付单 CLOSED（closed_at），不记账、不发事件、不入队开通、不登记异常收款；只查询、不调关单；应答 channel_result.state=closed 带渠道原状态；一条审计',
  async (channel) => {
    const f = await fixture(s);
    const channels = adminChannels(f);
    const order = await seedNeedsManual(f, channel);
    channels[channel].script(order, 'closed');
    f.clock.advanceMs(60_000);
    await withAdmin(f, channels, async (h) => {
      const data = await ok(await h.resolve(order.id));
      const row = await payOrder(f, order.id);
      expect(row).toMatchObject({
        status: 'CLOSED',
        closed_at: f.clock.now(),
        paid_at: null,
        channel_trade_no: null,
        amount_fen: AMOUNT,
      });
      expect(orderOf(data['pay_order'])).toEqual(orderView(row));
      expect(normalize(data['channel_result'], ['queried_at'])).toEqual({
        state: 'closed',
        channel_state: CLOSED_STATE[channel],
        channel_trade_no: null,
        queried_at: f.clock.now().getTime(),
      });
      expect(channels[channel].queried).toEqual([order.out_trade_no]);
      expect(channels[channel].closeCalls).toEqual([]);
      expect((await attemptsOf(f, order.id)).map((attempt) => attempt.kind)).toEqual(['query']);
      const audits = await resolveAudits(f);
      expect(audits).toHaveLength(1);
      audited(audits[0], {
        adminId: h.resolver.id,
        at: f.clock.now(),
        order,
        after: 'CLOSED',
        results: ['closed', CLOSED_STATE[channel]],
      });
    });
    await nothingSettled(f, order);
  },
);

it('[AC-B2-15f#3] BR-PAY-05 ② 的不存在条件成立（本次查询在 expire_at + pay.close_grace_minutes 之后，渠道仍答「单据不存在」）→ PO3：支付单 CLOSED；应答 channel_result.state=not_exist、channel_state 与渠道交易号为 null；一条审计', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  const order = await seedNeedsManual(f, 'wechat_pay');
  channels.wechat_pay.script(order, 'not_exist');
  await withAdmin(f, channels, async (h) => {
    const data = await ok(await h.resolve(order.id));
    const row = await payOrder(f, order.id);
    expect(row).toMatchObject({ status: 'CLOSED', closed_at: f.clock.now(), paid_at: null });
    expect(orderOf(data['pay_order'])).toEqual(orderView(row));
    expect(normalize(data['channel_result'], ['queried_at'])).toEqual({
      state: 'not_exist',
      channel_state: null,
      channel_trade_no: null,
      queried_at: f.clock.now().getTime(),
    });
    expect(channels.wechat_pay.queried).toEqual([order.out_trade_no]);
    expect(channels.wechat_pay.closeCalls).toEqual([]);
    const audits = await resolveAudits(f);
    expect(audits).toHaveLength(1);
    audited(audits[0], {
      adminId: h.resolver.id,
      at: f.clock.now(),
      order,
      after: 'CLOSED',
      results: ['not_exist'],
    });
  });
  await nothingSettled(f, order);
});

it('[AC-B2-15f#4] 「单据不存在」不等于已关闭：pay.close_grace_minutes 配为 120 时本次查询尚未过 expire_at + 120 分 → 不迁移，支付单仍 PENDING、needs_manual=true；应答 code 0、channel_result.state=not_exist；不变的结果也写审计；之后过了宽限再处置才 PO3', async () => {
  const f = await fixture(s);
  await setConfig(f, 'pay.close_grace_minutes', 120);
  const channels = adminChannels(f);
  const order = await seedNeedsManual(f, 'alipay');
  channels.alipay.script(order, 'not_exist');
  await withAdmin(f, channels, async (h) => {
    const data = await ok(await h.resolve(order.id));
    const row = await payOrder(f, order.id);
    expect(row).toMatchObject({
      status: 'PENDING',
      needs_manual: true,
      closed_at: null,
      paid_at: null,
    });
    expect(orderOf(data['pay_order'])).toEqual(orderView(row));
    expect(normalize(data['channel_result'], ['queried_at'])).toEqual({
      state: 'not_exist',
      channel_state: null,
      channel_trade_no: null,
      queried_at: f.clock.now().getTime(),
    });
    const audits = await resolveAudits(f);
    expect(audits).toHaveLength(1);
    audited(audits[0], {
      adminId: h.resolver.id,
      at: f.clock.now(),
      order,
      after: 'PENDING',
      results: ['not_exist'],
    });
    // expire_at + 120 minutes reached: a new query that still finds nothing closes the order (a
    // fresh sign-in: the first session has been idle longer than the admin idle timeout).
    f.clock.advanceMs(120 * 60_000 - (f.clock.now().getTime() - order.expire_at.getTime()));
    const later = await h.caller([RESOLVE]);
    const again = await ok(await h.resolve(order.id, { caller: later }));
    const closed = await payOrder(f, order.id);
    expect(closed).toMatchObject({ status: 'CLOSED', closed_at: f.clock.now() });
    expect(orderOf(again['pay_order'])).toEqual(orderView(closed));
    expect(channels.alipay.queried).toEqual([order.out_trade_no, order.out_trade_no]);
    expect(await resolveAudits(f)).toHaveLength(2);
  });
  await nothingSettled(f, order);
});

it.each([
  ['渠道查询超时（结果未知）', 'timeout', null],
  ['渠道答仍未支付', 'not_paid', 'not_paid'],
] as const)(
  '[AC-B2-15f#5] %s → 不迁移：支付单仍 PENDING、needs_manual=true，不记账；应答 code 0、channel_result.state=unknown（契约四值里「未知 / 未付」都不迁移）；写一条审计；可再次处置，渠道随后答已支付 → PO2（只记一次账）',
  async (label, setting, notPaid) => {
    const f = await fixture(s);
    const channels = adminChannels(f);
    const order = await seedNeedsManual(f, 'wechat_pay');
    channels.wechat_pay.script(order, setting);
    await withAdmin(f, channels, async (h) => {
      const data = await ok(await h.resolve(order.id));
      const row = await payOrder(f, order.id);
      expect(row, label).toMatchObject({
        status: 'PENDING',
        needs_manual: true,
        paid_at: null,
        closed_at: null,
        channel_trade_no: null,
      });
      expect(orderOf(data['pay_order'])).toEqual(orderView(row));
      expect(normalize(data['channel_result'], ['queried_at'])).toEqual({
        state: 'unknown',
        channel_state: notPaid === null ? null : NOT_PAID.wechat_pay,
        channel_trade_no: null,
        queried_at: f.clock.now().getTime(),
      });
      expect((await attemptsOf(f, order.id)).map((attempt) => attempt.kind)).toEqual(['query']);
      expect(channels.wechat_pay.closeCalls).toEqual([]);
      const audits = await resolveAudits(f);
      expect(audits).toHaveLength(1);
      audited(audits[0], {
        adminId: h.resolver.id,
        at: f.clock.now(),
        order,
        after: 'PENDING',
        results: notPaid === null ? ['unknown'] : ['unknown', 'not_paid', NOT_PAID.wechat_pay],
      });
      expect(await vouchers(f)).toEqual([]);
      // A repeated call queries again and settles by the new answer.
      f.clock.advanceMs(120_000);
      const trade = channels.wechat_pay.script(order, 'paid');
      const again = await ok(await h.resolve(order.id));
      expect(orderOf(again['pay_order'])).toMatchObject({
        status: 'PAID',
        channel_trade_no: trade,
        paid_at: f.clock.now().getTime(),
      });
      expect(channels.wechat_pay.queried).toEqual([order.out_trade_no, order.out_trade_no]);
      expect(await resolveAudits(f)).toHaveLength(2);
    });
    await settledOnce(f, order);
  },
);

it.each([
  ['金额与支付单不符', { amountFen: AMOUNT - 1n }],
  ['金额多于支付单', { amountFen: AMOUNT + 100n }],
] as const)(
  '[AC-B2-15f#6] 渠道答已支付但%s → 按 BR-PAY-04 核对不通过、不迁移：支付单仍 PENDING、needs_manual=true，无 PAY_RECEIPT、无事件、无开通任务；应答 code 0 带不变的支付单；写一条审计',
  async (label, options) => {
    const f = await fixture(s);
    const channels = adminChannels(f);
    const order = await seedNeedsManual(f, 'alipay');
    channels.alipay.script(order, 'paid', options);
    await withAdmin(f, channels, async (h) => {
      const data = await ok(await h.resolve(order.id));
      const row = await payOrder(f, order.id);
      expect(row, label).toMatchObject({
        status: 'PENDING',
        needs_manual: true,
        paid_at: null,
        channel_trade_no: null,
      });
      expect(orderOf(data['pay_order'])).toEqual(orderView(row));
      expect(await resolveAudits(f)).toHaveLength(1);
    });
    await nothingSettled(f, order);
  },
);

it('[AC-B2-15f#7] step-up 动态码档：不带 X-Step-Up-Token、短信档令牌、别的账号的令牌、过期令牌都是 10003 data.tier=totp；超管不需勾选权限点但同样要 totp 令牌；被拒的调用不查询渠道、不记渠道请求、不写审计、支付单不变', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  const order = await seedNeedsManual(f, 'wechat_pay');
  channels.wechat_pay.script(order, 'closed');
  await withAdmin(f, channels, async (h) => {
    await answer(await h.resolve(order.id, { stepUp: null }), 10003, STEP_UP_TOTP);
    const sms = await h.stepUp(h.resolver, 'sms');
    await answer(await h.resolve(order.id, { stepUp: sms }), 10003, STEP_UP_TOTP);
    const others = await h.stepUp(h.viewer);
    await answer(await h.resolve(order.id, { stepUp: others }), 10003, STEP_UP_TOTP);
    const stale = await h.stepUp(h.resolver);
    f.clock.advanceMs(STEP_UP_TTL_MS + 1_000);
    await answer(await h.resolve(order.id, { stepUp: stale }), 10003, STEP_UP_TOTP);
    const root = await h.caller([], { superAdmin: true });
    await answer(await h.resolve(order.id, { caller: root, stepUp: null }), 10003, STEP_UP_TOTP);
    await refused(f, channels, order);
    const data = await ok(await h.resolve(order.id, { caller: root }));
    expect(orderOf(data['pay_order'])).toMatchObject({ status: 'CLOSED' });
    const audits = await resolveAudits(f);
    expect(audits.map((audit) => audit.admin_id)).toEqual([root.id]);
  });
});

it('[AC-B2-15f#8] 权限点 pay.resolve：只有 pay.view 或只有 pay.refund 的账号（即使带自己的 totp 令牌）10403，不带后台令牌 10001；都不查询渠道、不写审计、支付单不变', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  const order = await seedNeedsManual(f, 'alipay');
  channels.alipay.script(order, 'paid');
  await withAdmin(f, channels, async (h) => {
    await answer(await h.resolve(order.id, { caller: h.viewer }), 10403);
    const refunder = await h.caller([REFUND]);
    await answer(await h.resolve(order.id, { caller: refunder }), 10403);
    await answer(await h.resolve(order.id, { caller: null }), 10001);
    const both = await h.caller([VIEW, REFUND]);
    await answer(await h.resolve(order.id, { caller: both }), 10403);
  });
  await refused(f, channels, order);
  await nothingSettled(f, order);
});

it('[AC-B2-15f#9] 只处置 needs_manual=true 且仍 PENDING 的支付单：PENDING 未进关单流程、PENDING 关单中但未转人工、PAID、CLOSED（即使 needs_manual=true）→ 20902 data.resource=pay_order；不查询渠道、不写审计、支付单不变', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  const now = f.clock.now().getTime();
  const cases: [string, OrderRow][] = [
    ['PENDING', await seedOrder(f, { pay_channel: 'wechat_pay', amount_fen: AMOUNT })],
    [
      'PENDING closing',
      await seedNeedsManual(f, 'wechat_pay', { needs_manual: false, expire_at: new Date(now) }),
    ],
    [
      'PAID',
      await seedOrder(f, {
        pay_channel: 'alipay',
        amount_fen: AMOUNT,
        status: 'PAID',
        channel_trade_no: tradeNo('alipay'),
        launch_issued_at: new Date(now),
        paid_at: new Date(now),
      }),
    ],
    [
      'CLOSED needs_manual',
      await seedNeedsManual(f, 'alipay', {
        status: 'CLOSED',
        closing: false,
        closed_at: new Date(now),
      }),
    ],
  ];
  for (const [, order] of cases) {
    channels[order.pay_channel as PayChannelCode].script(order, 'paid');
  }
  await withAdmin(f, channels, async (h) => {
    for (const [label, order] of cases) {
      const sent = await h.resolve(order.id);
      expect(sent.statusCode, `${label}: ${sent.body}`).toBe(409);
      await answer(sent, 20902, CONFLICT);
    }
  });
  for (const [, order] of cases) await refused(f, channels, order);
  expect(await vouchers(f)).toEqual([]);
});

it('[AC-B2-15f#10] 不存在的 pay_order_id、其他应用的支付单 → 20001 data.fields=[pay_order_id]（不是 404）；不查询渠道、不写审计，其他应用的支付单不变', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  const g = await fixture(s);
  const foreign = await seedNeedsManual(g, 'wechat_pay');
  channels.wechat_pay.script(foreign, 'paid');
  await withAdmin(f, channels, async (h) => {
    for (const id of [randomUUID(), foreign.id]) {
      await answer(await h.resolve(id), 20001, { fields: ['pay_order_id'] });
    }
  });
  expect(channels.wechat_pay.queried).toEqual([]);
  expect(await resolveAudits(f)).toEqual([]);
  expect(await resolveAudits(g)).toEqual([]);
  expect(await payOrder(g, foreign.id)).toEqual(foreign);
  expect(await attemptsOf(g, foreign.id)).toEqual([]);
});

it('[AC-B2-15f#11] 请求体只能是固定值（expected_status=PENDING、action=query_and_settle），后台不能上送渠道结果、状态或凭证：缺字段、取值不在枚举、多带字段都是 20001；不查询渠道、不写审计、支付单不变', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  const order = await seedNeedsManual(f, 'wechat_pay');
  channels.wechat_pay.script(order, 'paid');
  const bad: unknown[] = [
    {},
    { expected_status: 'PENDING' },
    { action: 'query_and_settle' },
    { expected_status: 'PAID', action: 'query_and_settle' },
    { expected_status: 'CLOSED', action: 'query_and_settle' },
    { expected_status: 'PENDING', action: 'close' },
    { expected_status: 'PENDING', action: 'settle' },
    { ...RESOLVE_BODY, status: 'PAID' },
    { ...RESOLVE_BODY, channel_state: 'SUCCESS' },
    { ...RESOLVE_BODY, channel_trade_no: tradeNo('wechat_pay') },
    { ...RESOLVE_BODY, evidence: { trade_state: 'SUCCESS' } },
  ];
  await withAdmin(f, channels, async (h) => {
    for (const body of bad) {
      const sent = await h.resolve(order.id, { body });
      expect(sent.statusCode, `${JSON.stringify(body)} → ${sent.body}`).toBe(400);
      await answer(sent, 20001);
    }
  });
  await refused(f, channels, order);
  await nothingSettled(f, order);
});

it('[AC-B2-15f#12] 两张 needs_manual 支付单各自处置互不影响：一张渠道已支付 → PAID，另一张渠道已关闭 → CLOSED；各一条审计、各查询一次，PAY_RECEIPT 只属于 PAID 的那张；处置人只需 pay.resolve 与 totp 令牌', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  const paid = await seedNeedsManual(f, 'wechat_pay');
  const closed = await seedNeedsManual(f, 'wechat_pay');
  const trade = channels.wechat_pay.script(paid, 'paid');
  channels.wechat_pay.script(closed, 'closed');
  await withAdmin(f, channels, async (h) => {
    const only = await h.caller([RESOLVE]);
    const first = await ok(await h.resolve(paid.id, { caller: only }));
    const second = await ok(await h.resolve(closed.id, { caller: only }));
    expect(orderOf(first['pay_order'])).toMatchObject({ status: 'PAID', channel_trade_no: trade });
    expect(orderOf(second['pay_order'])).toMatchObject({ status: 'CLOSED' });
    const audits = await resolveAudits(f);
    expect(audits.map((audit) => audit.admin_id)).toEqual([only.id, only.id]);
    expect(auditText(audits[0]!)).toContain(paid.id);
    expect(auditText(audits[1]!)).toContain(closed.id);
  });
  expect(channels.wechat_pay.queried.sort()).toEqual(
    [paid.out_trade_no, closed.out_trade_no].sort(),
  );
  const paidRow = await payOrder(f, paid.id);
  expect(await vouchers(f)).toEqual([receiptOf(paidRow)]);
  expect(await payOrder(f, closed.id)).toMatchObject({ status: 'CLOSED', paid_at: null });
});
