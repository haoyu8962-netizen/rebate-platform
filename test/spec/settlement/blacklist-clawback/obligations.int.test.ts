// B2-04zzl confirmation rule tests, open obligations (claude-independent, SPEC_REF d5713bf4): 08
// BR-FUND-08 — 转 CLAWED_BACK 时同一事务作废该子订单未完成的待补记义务（BR-FUND-04 ⑫）; 未入账的受益人净额 0，不写
// 扣回凭证; 本次全部凭证对 UNION_RECEIVABLE 的净影响 = −booked_n_fen − Σ 待补记额变化量，所以应收只冲回实际记账的
// 部分。Default order N 1000, reserve 1500: 425 / 85 / 42, platform 448; with direct's 85 not on its
// account UNION_RECEIVABLE is 915 = 425 + 42 + 448, and that is all a clawback takes off it. Expected
// amounts are written by hand. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  answer,
  app,
  clawbackKey,
  confirmed,
  eventIdOf,
  expectAdjusted,
  newKey,
  platformClawbackKey,
  platformDecreaseLines,
  receivable,
  seedBlacklistDiff,
  suite,
  userClawbackLines,
  withAdmin,
  type App,
  type DiffRow,
  type Harness,
  type SeededOrder,
} from './kit.ts';
import { creditedWithDeferred } from './ledger-kit.ts';

const s = suite();

/** Direct frozen at the credit: 85 owed under an open first_credit obligation, nothing posted. */
function creditedFrozenDirect(h: Harness): Promise<SeededOrder> {
  return h.credited({
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000, state: 'frozen' },
      { role: 'indirect', ratioBp: 500 },
    ],
  });
}

/** The vouchers and the UNION_RECEIVABLE of a confirmation that took 425 + 42 + 448 = 915. */
async function expect915(a: App, o: SeededOrder, diff: DiffRow): Promise<void> {
  const { h } = a;
  const event = eventIdOf(diff);
  expect((await h.clawbackKeys(o)).filter((key) => key.endsWith(`:CLAWBACK:${event}`))).toEqual(
    [
      clawbackKey(o, 'self', event),
      clawbackKey(o, 'indirect', event),
      platformClawbackKey(o, event),
    ].sort(),
  );
  expect(await h.voucherLines(clawbackKey(o, 'self', event))).toEqual(
    userClawbackLines(o, 'self', 425n),
  );
  expect(await h.voucherLines(clawbackKey(o, 'indirect', event))).toEqual(
    userClawbackLines(o, 'indirect', 42n),
  );
  expect(await h.voucherLines(platformClawbackKey(o, event))).toEqual(
    platformDecreaseLines(o, 448n),
  );
  expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
  expect(await h.rebateColumns(o)).toMatchObject({
    rebate_status: 'CLAWED_BACK',
    booked_base_fen: 0n,
    booked_n_fen: 0n,
  });
  expect(await h.balance(o.user('direct'))).toBe(0n);
}

it('[AC-B2-04zzl#41] 首次入账义务（直推入账时冻结，85 分待补记）：义务同事务作废（voided、closed_by R8、closed_ref `B{id}`、无凭证），直推无扣回凭证、余额不变；本人 425、间推 42、平台 448，应收从 915 逐分冲到 0，响应 467', async () => {
  const a = await app(s);
  const { h } = a;
  const o = await creditedFrozenDirect(h);
  expect(await h.orderSubjectNet(o, receivable(o))).toBe(915n);
  const before = await h.orderObligations(o);
  expect(before).toMatchObject([{ kind: 'first_credit', status: 'open', role: 'direct' }]);
  const diff = await seedBlacklistDiff(a, o);
  await withAdmin(a, async (admin) => {
    const data = await confirmed(await admin.confirm(diff.id));
    expect(data.clawed_back_fen).toBe(467);
    expect(data.rebate_status_after).toBe('CLAWED_BACK');
    await expect915(a, o, diff);
    expect(await h.orderObligations(o)).toEqual([
      {
        ...before[0]!,
        status: 'voided',
        closed_by: 'R8',
        closed_ref: eventIdOf(diff),
        voucher_id: null,
        closed_at: h.clock.now(),
        row_version: before[0]!.row_version + 1,
      },
    ]);
    await expectAdjusted(a, diff, { adminId: admin.operator.id, clawedBackFen: 467 });
  });
});

it('[AC-B2-04zzl#42] 延后补记义务（deferred，直推净额 0、仍欠 85）：义务同事务作废（voided、closed_by R8、closed_ref `B{id}`），直推没有 `B{id}` 下的凭证、余额不变；本人 425、间推 42、平台 448，应收从 915 冲到 0，响应 467', async () => {
  const a = await app(s);
  const { h } = a;
  const o = await creditedWithDeferred(a);
  expect(await h.orderSubjectNet(o, receivable(o))).toBe(915n);
  expect(await h.balance(o.user('direct'))).toBe(0n);
  const before = await h.orderObligations(o);
  expect(before).toMatchObject([{ kind: 'deferred', status: 'open', role: 'direct' }]);
  const diff = await seedBlacklistDiff(a, o);
  await withAdmin(a, async (admin) => {
    const data = await confirmed(await admin.confirm(diff.id));
    expect(data.clawed_back_fen).toBe(467);
    await expect915(a, o, diff);
    expect(await h.orderObligations(o)).toEqual([
      {
        ...before[0]!,
        status: 'voided',
        closed_by: 'R8',
        closed_ref: eventIdOf(diff),
        voucher_id: null,
        closed_at: h.clock.now(),
        row_version: before[0]!.row_version + 1,
      },
    ]);
    await expectAdjusted(a, diff, { adminId: admin.operator.id, clawedBackFen: 467 });
  });
});

it('[AC-B2-04zzl#43] 失败回滚时义务保留：首次入账义务与延后义务各一单，改订单或写审计失败 → 50001，义务仍 open、无 `B{id}` 凭证、应收仍 915、订单 CREDITED；同一 key 重发即成功，义务恰好作废一次，响应 467', async () => {
  const a = await app(s);
  const { h } = a;
  await withAdmin(a, async (admin) => {
    for (const point of ['audit', 'order_update'] as const) {
      for (const seed of [() => creditedFrozenDirect(h), () => creditedWithDeferred(a)] as const) {
        const o = await seed();
        const diff = await seedBlacklistDiff(a, o);
        const event = eventIdOf(diff);
        const before = await h.orderObligations(o);
        expect(before, point).toMatchObject([{ status: 'open', role: 'direct' }]);
        const key = newKey();
        const tripped = admin.fault.tripped;
        admin.fault.point = point;
        const sent = await admin.confirm(diff.id, {}, { key });
        expect(admin.fault.tripped, `${point} 必须在处理事务里执行`).toBe(tripped + 1);
        await answer(sent, 50001);

        expect(await h.orderObligations(o), point).toEqual(before);
        expect(
          (await h.clawbackKeys(o)).filter((k) => k.endsWith(`:CLAWBACK:${event}`)),
          point,
        ).toEqual([]);
        expect(await h.orderSubjectNet(o, receivable(o)), point).toBe(915n);
        expect((await h.read(o)).rebate_status, point).toBe('CREDITED');

        const data = await confirmed(await admin.confirm(diff.id, {}, { key }));
        expect(data.clawed_back_fen, point).toBe(467);
        expect(await h.orderObligations(o), point).toMatchObject([
          { status: 'voided', closed_by: 'R8', closed_ref: event, voucher_id: null },
        ]);
        expect(await h.orderSubjectNet(o, receivable(o)), point).toBe(0n);
      }
    }
  });
});
