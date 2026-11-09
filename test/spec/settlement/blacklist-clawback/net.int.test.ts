// B2-04zzl confirmation rule tests, what is taken back is the net (claude-independent, SPEC_REF
// d5713bf4): 08 BR-FUND-08 — 受益人扣回金额 = 该受益人在该子订单上的已入账净额 − 新应得（R8 新应得为 0），
// 已入账净额含 CREDIT、SETTLE_ADJUST、CLAWBACK、ADMIN_ADJUST（RESTORE，含申诉补发）; 平台差额 = 平台已入账净额 −
// 新平台应得；本次全部凭证对 UNION_RECEIVABLE 的净影响 = −booked_n_fen；受益人已注销（墓碑）且净额大于 0 → 借
// BAD_DEBT / 贷 UNION_RECEIVABLE，金额、uniq_key、ledger_type 与 sub_type 不变，不写其账户。Histories come
// from the real clawback service and ledger (ledger-kit.ts). Expected amounts are written by hand or
// are the 08 examples. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  app,
  badDebtLines,
  clawbackKey,
  confirmed,
  eventIdOf,
  expectAdjusted,
  platformClawbackKey,
  platformDecreaseLines,
  receivable,
  seedBlacklistDiff,
  suite,
  userClawbackLines,
  withAdmin,
  type App,
  type SeededOrder,
} from './kit.ts';
import {
  appealRestore,
  creditedOnApiRecord,
  reopenOrder,
  restoreNets,
  settleTo,
} from './ledger-kit.ts';

const s = suite();

/** Exactly the `B{id}` vouchers named, every line with its direction, CLAWBACK sub_type FULL. */
async function expectVouchers(
  a: App,
  o: SeededOrder,
  event: string,
  expected: {
    readonly users: readonly {
      readonly role: 'self' | 'direct' | 'indirect';
      readonly fen: bigint;
    }[];
    readonly platformFen: bigint;
  },
): Promise<void> {
  const { h } = a;
  const platform = platformClawbackKey(o, event);
  const keys = expected.users.map((user) => clawbackKey(o, user.role, event));
  expect((await h.clawbackKeys(o)).filter((key) => key.endsWith(`:CLAWBACK:${event}`))).toEqual(
    [...keys, platform].sort(),
  );
  for (const user of expected.users) {
    const key = clawbackKey(o, user.role, event);
    expect(await h.voucherLines(key), user.role).toEqual(userClawbackLines(o, user.role, user.fen));
    expect(await h.voucherTypes(key), user.role).toEqual(['CLAWBACK|FULL']);
  }
  expect(await h.voucherLines(platform)).toEqual(platformDecreaseLines(o, expected.platformFen));
  expect(await h.voucherTypes(platform)).toEqual(['CLAWBACK|FULL']);
}

/** After the whole-order clawback: receivable and revenue net to 0, the order is CLAWED_BACK. */
async function expectCleared(a: App, o: SeededOrder): Promise<void> {
  const { h } = a;
  expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
  expect(await h.orderSubjectNet(o, 'COMMISSION_REVENUE')).toBe(0n);
  expect(await h.rebateColumns(o)).toMatchObject({
    rebate_status: 'CLAWED_BACK',
    booked_base_fen: 0n,
    booked_n_fen: 0n,
    reason: 'BLACKLIST',
  });
}

it('[AC-B2-04zzl#37] 部分扣回之后确认（BR-FUND-08 净额）：本人入账 500，部分退款 N 1000 → 800 先扣 100（R9，仍 CREDITED，booked 800 / 800），确认只再扣 400，平台再冲回 400，应收归 0；默认三人单 N 1000 → 600 先扣 170 / 34 / 17 后，确认再扣 255 / 51 / 25，平台冲回 269，响应 331', async () => {
  const a = await app(s);
  const { h } = a;
  const single = await h.credited({ people: [{ role: 'self', ratioBp: 5000 }], reserveBp: 0 });
  expect(await h.balance(single.user('self'))).toBe(500n);
  expect(
    await h.apply(single, {
      cause: 'PARTIAL_REFUND',
      ref: { kind: 'commission' },
      newCommissionFen: 800n,
    }),
  ).toMatchObject({
    outcome: 'clawed_back',
    transition: 'R9',
    bookedBaseFen: 800n,
    bookedNFen: 800n,
  });
  expect(await h.balance(single.user('self'))).toBe(400n);

  const three = await h.credited();
  expect(
    await h.apply(three, {
      cause: 'PARTIAL_REFUND',
      ref: { kind: 'commission' },
      newCommissionFen: 600n,
    }),
  ).toMatchObject({
    outcome: 'clawed_back',
    transition: 'R9',
    bookedBaseFen: 510n,
    bookedNFen: 600n,
  });

  const singleDiff = await seedBlacklistDiff(a, single);
  const threeDiff = await seedBlacklistDiff(a, three);
  await withAdmin(a, async (admin) => {
    const first = await confirmed(await admin.confirm(singleDiff.id));
    expect(first.clawed_back_fen).toBe(400);
    expect(first.rebate_status_after).toBe('CLAWED_BACK');
    await expectVouchers(a, single, eventIdOf(singleDiff), {
      users: [{ role: 'self', fen: 400n }],
      platformFen: 400n,
    });
    expect(await h.balance(single.user('self'))).toBe(0n);
    await expectCleared(a, single);
    await expectAdjusted(a, singleDiff, { adminId: admin.operator.id, clawedBackFen: 400 });

    const second = await confirmed(await admin.confirm(threeDiff.id));
    expect(second.clawed_back_fen).toBe(331);
    await expectVouchers(a, three, eventIdOf(threeDiff), {
      users: [
        { role: 'self', fen: 255n },
        { role: 'direct', fen: 51n },
        { role: 'indirect', fen: 25n },
      ],
      platformFen: 269n,
    });
    for (const person of three.people) {
      expect(await h.balance(person.userId), person.role).toBe(0n);
    }
    await expectCleared(a, three);
    await expectAdjusted(a, threeDiff, { adminId: admin.operator.id, clawedBackFen: 331 });
  });
});

it('[AC-B2-04zzl#38] SETTLE_ADJUST 之后确认（BR-FUND-08 净额）：结算额 N 1000 → 800 走 R10（425 / 85 / 42 → 340 / 68 / 34，平台 448 → 358，booked 680 / 800），确认扣 340 / 68 / 34，平台冲回 358，响应 442；不是初始入账的 552', async () => {
  const a = await app(s);
  const { h } = a;
  const o = await creditedOnApiRecord(a);
  expect(await settleTo(a, o, 800n)).toMatchObject({
    outcome: 'settle_adjusted',
    transition: 'R10',
    bookedBaseFen: 680n,
    bookedNFen: 800n,
  });
  expect(await h.balance(o.user('self'))).toBe(340n);
  expect(await h.orderSubjectNet(o, receivable(o))).toBe(800n);

  const diff = await seedBlacklistDiff(a, o);
  await withAdmin(a, async (admin) => {
    const data = await confirmed(await admin.confirm(diff.id));
    expect(data.clawed_back_fen).toBe(442);
    await expectVouchers(a, o, eventIdOf(diff), {
      users: [
        { role: 'self', fen: 340n },
        { role: 'direct', fen: 68n },
        { role: 'indirect', fen: 34n },
      ],
      platformFen: 358n,
    });
    for (const person of o.people) {
      expect(await h.balance(person.userId), person.role).toBe(0n);
    }
    await expectCleared(a, o);
    await expectAdjusted(a, diff, { adminId: admin.operator.id, clawedBackFen: 442 });
  });
});

it('[AC-B2-04zzl#39] 08 BR-FUND-08 算例（恢复过的钱计入净额）：预留 0、本人 5000、B 1000；入账时封禁 500 归平台（平台净额 1000）；申诉撤销按 BR-FUND-22 ③ 补发 500（平台净额 500）；确认整单扣回：本人扣 500（含补发），平台冲回 500，应收净额 0，CLAWED_BACK，响应 500', async () => {
  const a = await app(s);
  const { h } = a;
  const o = await h.credited({
    people: [{ role: 'self', ratioBp: 5000, state: 'banned' }],
    reserveBp: 0,
  });
  const self = o.user('self');
  expect(await h.balance(self)).toBe(0n);
  expect((await h.nets(o)).platform_net_fen).toBe(1000n);
  expect(await h.orderSubjectNet(o, receivable(o))).toBe(1000n);

  await appealRestore(a, o, 'self', 500n);
  expect(await h.balance(self)).toBe(500n);
  expect((await h.nets(o)).platform_net_fen).toBe(500n);
  expect(await h.netOf(o, 'self')).toBe(500n);

  const diff = await seedBlacklistDiff(a, o);
  await withAdmin(a, async (admin) => {
    const data = await confirmed(await admin.confirm(diff.id));
    expect(data.clawed_back_fen).toBe(500);
    expect(data.rebate_status_after).toBe('CLAWED_BACK');
    await expectVouchers(a, o, eventIdOf(diff), {
      users: [{ role: 'self', fen: 500n }],
      platformFen: 500n,
    });
    expect(await h.balance(self)).toBe(0n);
    expect(await h.netOf(o, 'self')).toBe(0n);
    expect((await h.nets(o)).platform_net_fen).toBe(0n);
    await expectCleared(a, o);
    await expectAdjusted(a, diff, { adminId: admin.operator.id, clawedBackFen: 500 });
  });
});

it('[AC-B2-04zzl#40] 08 BR-FUND-08 另一算例：预留 2000、本人 5000 / 直推 1000、N 1000（400 / 80，平台 520）；入账 → 全额扣回 → R13 恢复 → 确认再次全额扣回：按计入恢复的净额扣本人 400、直推 80，平台冲回 520，应收净额 0，响应 480', async () => {
  const a = await app(s);
  const { h } = a;
  const o = await h.credited({
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000 },
    ],
    reserveBp: 2000,
  });
  expect(
    await h.apply(o, { cause: 'INVALID_AFTER_SETTLE', ref: { kind: 'platform' } }),
  ).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
  expect(await h.balance(o.user('self'))).toBe(0n);

  // R13's vouchers and the order column the restore moves back to CREDITED.
  await restoreNets(
    a,
    o,
    [
      { role: 'self', fen: 400n },
      { role: 'direct', fen: 80n },
    ],
    520n,
  );
  await reopenOrder(a, o, 800n, 1000n);
  expect(await h.balance(o.user('self'))).toBe(400n);
  expect(await h.balance(o.user('direct'))).toBe(80n);

  const diff = await seedBlacklistDiff(a, o);
  await withAdmin(a, async (admin) => {
    const data = await confirmed(await admin.confirm(diff.id));
    expect(data.clawed_back_fen).toBe(480);
    await expectVouchers(a, o, eventIdOf(diff), {
      users: [
        { role: 'self', fen: 400n },
        { role: 'direct', fen: 80n },
      ],
      platformFen: 520n,
    });
    expect(await h.balance(o.user('self'))).toBe(0n);
    expect(await h.balance(o.user('direct'))).toBe(0n);
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
    expect(await h.orderSubjectNet(o, 'COMMISSION_REVENUE')).toBe(0n);
    expect(await h.rebateColumns(o)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
    });
  });
});

it('[AC-B2-04zzl#44] 受益人已完成注销（墓碑，users.status deleted），订单曾向其入账 85：其扣回不写账户，借 BAD_DEBT 85 / 贷 UNION_RECEIVABLE 85，同一受益人 uniq_key，CLAWBACK|FULL，凭证带受益人键；墓碑余额不变（仍 85）、订单净额 0；响应 clawed_back_fen 552 计入这笔；事件 beneficiaries 不列它', async () => {
  const a = await app(s);
  const { h } = a;
  const o = await h.credited();
  const direct = o.user('direct');
  expect(await h.balance(direct)).toBe(85n);
  await h.db
    .updateTable('users')
    .set({ status: 'deleted' })
    .where('app_id', '=', h.appId)
    .where('id', '=', direct)
    .execute();
  const diff = await seedBlacklistDiff(a, o);
  await withAdmin(a, async (admin) => {
    const data = await confirmed(await admin.confirm(diff.id));
    expect(data.clawed_back_fen).toBe(552);

    const event = eventIdOf(diff);
    const key = clawbackKey(o, 'direct', event);
    expect(await h.voucherLines(key)).toEqual(badDebtLines(o, 85n));
    expect(await h.voucherTypes(key)).toEqual(['CLAWBACK|FULL']);
    expect(await h.voucher(key)).toMatchObject({
      voucher_kind: 'CLAWBACK',
      order_key: o.orderKey,
      beneficiary_user_id: direct,
      role: 'direct',
    });
    expect(await h.balance(direct)).toBe(85n);
    expect(await h.netOf(o, 'direct')).toBe(0n);
    expect(await h.orderSubjectNet(o, 'BAD_DEBT')).toBe(85n);

    expect(await h.voucherLines(clawbackKey(o, 'self', event))).toEqual(
      userClawbackLines(o, 'self', 425n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'indirect', event))).toEqual(
      userClawbackLines(o, 'indirect', 42n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, event))).toEqual(
      platformDecreaseLines(o, 448n),
    );
    await expectCleared(a, o);

    const [published] = (await h.published()).filter((e) => e.name === 'order.clawed_back');
    expect(published).toBeDefined();
    const payload = (
      published!.payload as unknown as { data: { beneficiaries: { user_id: string }[] } }
    ).data;
    expect(payload.beneficiaries.map((b) => b.user_id)).not.toContain(direct);
    await expectAdjusted(a, diff, { adminId: admin.operator.id, clawedBackFen: 552 });
  });
});
