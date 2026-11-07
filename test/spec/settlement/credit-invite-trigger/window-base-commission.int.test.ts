// B2-04zzc, rule tests round 2 (task brief §11, after the spec-test review r1): three more cases,
// numbered after #14.
// - #15 the eligibility window is judged on the placing time (orders.attr_at), not on the credit
//   time (08 BR-INV-24 细则「有效期」: 「只有下单时间在『取得资格时刻起锁定天数内』的本人自购子订单才可
//   触发；该订单在期限之后才月结入账，照发」);
// - #16 the B > 0 of BR-INV-24 ② is the booked base (D10-810): estimate 0, booked 1000 triggers;
//   the counterpart of #14 (estimate > 0, booked 0 does not);
// - #17 the trigger only writes invite_rewards: the credited order's booked amounts, commission
//   rows, vouchers and balances equal those of the same order credited by a worker without the
//   trigger port.
// Orders as in trigger.int.test.ts: N 1000, no reserve → booked_base_fen 1000 (self 400, direct 80,
// platform 520); placed 2032-06-20 10:00 +08:00, paid 4990; credit clock 2032-07-24 10:00 +08:00.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { NOW, databaseFixture, fixture, type Fixture } from '../batch-executor/kit.ts';
import {
  creditKey,
  platformKey,
  platformLines,
  userCreditLines,
  type SeededOrder,
} from '../credit/kit.ts';
import {
  TIMEOUT,
  UNTRIGGERED,
  creditInBatch,
  inviteeOrder,
  pair,
  productionTrigger,
  qualify,
  rewardOf,
  triggerOf,
  type Pair,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const CREDITED_AT = new Date(NOW).toISOString();

function triggeredBy(orderId: string, at: string = CREDITED_AT) {
  return { status: 'qualified', trigger_order_id: orderId, triggered_at: at };
}

/** Qualified 2032-06-15 10:00 +08:00 for 30 days: the window ends 2032-07-15 10:00 +08:00. */
const SHORT_DAYS = 30;
const SHORT_WINDOW_END = '2032-07-15T10:00:00+08:00';
/** Qualified after the order was placed (2032-06-20); the default 60 days cover the credit time. */
const LATE_QUALIFIED_AT = '2032-07-01T10:00:00+08:00';

it(
  '[AC-B2-04zzc#15] 有效期按下单时间（orders.attr_at）判、不按入账时间（08 BR-INV-24 细则「有效期」：下单时间在取得资格时刻起锁定天数内的才可触发，该订单在期限之后才月结入账，照发）：资格 06-15 取得、30 天到 07-15，06-20 下单、07-24 才入账 → 触发（triggered_at 为 07-24 的入账时刻）；对照：资格 07-01 取得、60 天（入账时刻在期内）但 06-20 下单早于取得资格 → 不触发、资格仍 qualified',
  async () => {
    const f = await fixture(p.db);
    const inWindow = await pair(f);
    await qualify(f, inWindow, { eligibility_days: SHORT_DAYS });
    const placedBefore = await pair(f);
    await qualify(f, placedBefore, { qualified_at: new Date(LATE_QUALIFIED_AT) });
    const placed = await inviteeOrder(f, inWindow);
    const early = await inviteeOrder(f, placedBefore);
    // The boundary this case pins: placed inside the window, credited after it closed.
    expect(placed.attrAt.getTime()).toBeLessThan(new Date(SHORT_WINDOW_END).getTime());
    expect(new Date(SHORT_WINDOW_END).getTime()).toBeLessThan(new Date(NOW).getTime());
    expect(early.attrAt.getTime()).toBeLessThan(new Date(LATE_QUALIFIED_AT).getTime());

    await creditInBatch(f, [placed, early], { trigger: await productionTrigger() });

    expect(await f.rebateOf(placed)).toBe('CREDITED');
    expect(await f.rebateOf(early)).toBe('CREDITED');
    expect((await f.h.read(placed)).credited_at?.toISOString()).toBe(CREDITED_AT);
    expect(await triggerOf(f, inWindow.invitee)).toStrictEqual(triggeredBy(placed.orderId));
    expect((await rewardOf(f, inWindow.invitee)).eligibility_days).toBe(SHORT_DAYS);
    expect(await triggerOf(f, placedBefore.invitee)).toStrictEqual(UNTRIGGERED);
    expect((await rewardOf(f, placedBefore.invitee)).row_version).toBe(0);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzc#16] 「B > 0」取入账基数 booked_base_fen（D10-810），与 #14 成对：预估 orders.base_fen = 0、联盟结算后入账 booked_base_fen = 1000，其余条件都满足（自购、实付 4990 ≥ 下限 0、有效期内下单）→ 入账时触发（trigger_order_id 为该单，row_version 加 1）',
  async () => {
    const f = await fixture(p.db);
    const pr = await pair(f);
    await qualify(f, pr);
    const o = await inviteeOrder(f, pr, { patch: { base_fen: 0n } });

    await creditInBatch(f, [o], { trigger: await productionTrigger() });

    const credited = await f.h.read(o);
    expect(credited.rebate_status).toBe('CREDITED');
    expect(credited.base_fen).toBe(0n);
    expect(credited.booked_base_fen).toBe(1000n);
    expect(await triggerOf(f, pr.invitee)).toStrictEqual(triggeredBy(o.orderId));
    expect((await rewardOf(f, pr.invitee)).row_version).toBe(1);
  },
  TIMEOUT,
);

/**
 * What the credit booked for `o` (orders amounts, commission rows, vouchers and balances), with the
 * order key and the pair's ids replaced by placeholders so two orders can be compared.
 */
async function commissionView(f: Fixture, o: SeededOrder, pr: Pair) {
  const anon = (text: string): string =>
    text
      .replaceAll(o.orderKey, '<order>')
      .replaceAll(pr.invitee, '<invitee>')
      .replaceAll(pr.inviter, '<inviter>');
  const row = await f.h.read(o);
  const lines = (await f.h.lines())
    .filter((line) => line.uniq_key.startsWith(`${o.orderKey}:`))
    .map((line) =>
      anon(
        [
          line.uniq_key,
          line.subject,
          line.owner_id,
          String(line.amount_fen),
          line.ledger_type,
          String(line.sub_type),
        ].join('|'),
      ),
    )
    .sort();
  const amounts = await f.db
    .selectFrom('commission_split_amounts')
    .select(['commission_version', 'role', 'user_id', 'base_fen', 'amount_fen'])
    .where('app_id', '=', f.appId)
    .where('order_id', '=', o.orderId)
    .orderBy('role')
    .execute();
  const events = await f.db
    .selectFrom('commission_split_beneficiary_events')
    .select(['role', 'user_id', 'status', 'reason'])
    .where('app_id', '=', f.appId)
    .where('order_id', '=', o.orderId)
    .orderBy('event_seq')
    .execute();
  return {
    rebate_status: row.rebate_status,
    base_fen: row.base_fen,
    booked_base_fen: row.booked_base_fen,
    booked_n_fen: row.booked_n_fen,
    settle_commission_fen: row.settle_commission_fen,
    amounts: amounts.map((a) => ({ ...a, user_id: anon(a.user_id) })),
    events: events.map((e) => ({ ...e, user_id: anon(e.user_id) })),
    lines,
    balances: {
      invitee: await f.h.balance(pr.invitee),
      inviter: await f.h.balance(pr.inviter),
    },
  };
}

it(
  '[AC-B2-04zzc#17] 触发不改订单分佣（BR-INV-24 ⑤，触发只写 invite_rewards）：同一 App 两个已取得资格的被邀请人各一笔同样的自购单，一笔经带生产触发端口的 worker 入账并触发，另一笔经不接触发端口的 worker 入账；两单的 booked_base_fen / booked_n_fen、分佣份额行、受益人事件、入账凭证与分录金额、双方余额完全相同（booked 1000，自购 400、直推 80、平台 520）',
  async () => {
    const f = await fixture(p.db);
    const triggered = await pair(f);
    const plain = await pair(f);
    await qualify(f, triggered);
    await qualify(f, plain);
    const withPort = await inviteeOrder(f, triggered);
    const withoutPort = await inviteeOrder(f, plain);

    await creditInBatch(f, [withPort], { trigger: await productionTrigger() });
    await creditInBatch(f, [withoutPort], { trigger: undefined });

    expect(await triggerOf(f, triggered.invitee)).toStrictEqual(triggeredBy(withPort.orderId));
    const view = await commissionView(f, withPort, triggered);
    expect(view).toStrictEqual(await commissionView(f, withoutPort, plain));
    expect(view).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 1000n,
      booked_n_fen: 1000n,
      balances: { invitee: 400n, inviter: 80n },
    });
    expect((await f.orderVouchers(withPort)).sort()).toStrictEqual(
      [creditKey(withPort, 'self'), creditKey(withPort, 'direct'), platformKey(withPort)].sort(),
    );
    expect(await f.h.voucherLines(creditKey(withPort, 'self'))).toStrictEqual(
      userCreditLines(withPort, 'self', 400n),
    );
    expect(await f.h.voucherLines(creditKey(withPort, 'direct'))).toStrictEqual(
      userCreditLines(withPort, 'direct', 80n),
    );
    expect(await f.h.voucherLines(platformKey(withPort))).toStrictEqual(
      platformLines(withPort, 520n),
    );
  },
  TIMEOUT,
);
