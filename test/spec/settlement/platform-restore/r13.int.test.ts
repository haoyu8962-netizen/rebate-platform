// B2-09gb rule tests, R13 (claude-independent, SPEC_REF 29c27a1b): contracts/openapi.yaml
// restoreAdminReconDiff, effects of a platform_restore on a CLAWED_BACK order, and 08 BR-FUND-22
// R13, BR-FUND-01 (R13 row;「已处置退件数」D10-937), BR-CALC-02 — CLAWED_BACK → CREDITED; the new base
// is the current effective union commission (settle_commission_fen when set, else the estimate)
// through BR-CALC-02 with the snapshot's reserve_bp; each beneficiary's share floor(B × ratio /
// 10000) and the platform's N⁺ − Σ shares (reserve included) less the current nets (BR-FUND-08) are
// posted as ADMIN_ADJUST (RESTORE): debit UNION_RECEIVABLE:{platform}, credit the member's available
// (`{order_key}:{user_id}:{role}:RESTORE:{recon_diff_id}`) or COMMISSION_REVENUE
// (`{order_key}:PLATFORM:RESTORE:{recon_diff_id}`); in the same CAS booked_base_fen = B,
// booked_n_fen = N⁺, refunded_quantity_r9_baseline = refunded_quantity, refunded_quantity_at_credit
// untouched; restored_fen = what beneficiaries' available received. Never expected_fen, the
// snapshot's base or amounts, or the estimate while a settled amount exists. Expected amounts are
// written by hand. Requests go through the real admin entry (kit.ts). Top-level it() only.
import { addFen, mulDivFloor, subFen } from '@couli/money';
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  RESTORE_ACTION,
  THREE_PEOPLE,
  audits,
  available,
  detailView,
  expectAdjusted,
  expectRestoreStep,
  fixture,
  memberLines,
  netOf,
  netsOf,
  orderHistory,
  orderRow,
  orderVouchers,
  platformKey,
  platformLines,
  platformRestored,
  restoreKey,
  restoreVouchers,
  seedClawedBack,
  seedPlatformDiff,
  suite,
  text,
  untouched,
  voucherLines,
  withRestoreAdmin,
  world,
  type ClawedOrder,
  type Role,
} from './kit.ts';

const s = suite();

it('[AC-B2-09gb#5] 08 BR-FUND-22 例（R13）：预留 0，已入账 617 / 123 / 494 后全额扣回 → CLAWED_BACK；联盟恢复佣金 1234 → 处理恢复：ADMIN_ADJUST +617（本人）/ +123（直推）/ +494（平台），各借 UNION_RECEIVABLE:taobao、贷 USER_BALANCE.available 或 COMMISSION_REVENUE，键 `…:RESTORE:{差错单 id}`，受益人凭证挂受益人键、平台凭证不挂；booked_base_fen = booked_n_fen = 1234，CREDITED；应答 restored_fen 740、rebate_status_after CREDITED', async () => {
  const f = await fixture(s);
  const c = await seedClawedBack(f, {
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000 },
    ],
    creditFen: 1234n,
    reserveBp: 0,
    settle: 1234n,
  });
  const self = c.user('self');
  const direct = c.user('direct');
  const diff = await seedPlatformDiff(f, c);
  await withRestoreAdmin(f, async (h) => {
    const sent = await h.restore(diff.id);
    const data = await platformRestored(sent);
    expect(data.restored_fen).toBe(740);
    expect(data.rebate_status_after).toBe('CREDITED');
    const { row, restore } = await expectAdjusted(f, diff, {
      adminId: h.operator.id,
      from: 'CLAWED_BACK',
      to: 'CREDITED',
      restoredFen: 740n,
    });
    expect(data.recon_diff, sent.body).toEqual(detailView(row));
    // contracts/openapi.yaml AdminReconDiffRestorePlatformClawedBack: each beneficiary and role with
    // its amount (as a string) and where it went, and the platform's amount.
    expect(restore['platform_fen']).toBe('494');
    const listed = restore['beneficiaries'] as unknown[];
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ user_id: self, role: 'self', restored_fen: '617' }),
        expect.objectContaining({ user_id: direct, role: 'direct', restored_fen: '123' }),
      ]),
    );

    const selfKey = restoreKey(c.orderKey, self, 'self', diff.id);
    const directKey = restoreKey(c.orderKey, direct, 'direct', diff.id);
    const platform = platformKey(c.orderKey, diff.id);
    expect((await restoreVouchers(f)).map((v) => v.uniq_key).sort()).toEqual(
      [selfKey, directKey, platform].sort(),
    );
    expect(await voucherLines(f, selfKey)).toEqual(memberLines(c.platform, self, 617n));
    expect(await voucherLines(f, directKey)).toEqual(memberLines(c.platform, direct, 123n));
    expect(await voucherLines(f, platform)).toEqual(platformLines(c.platform, 494n));
    const vouchers = await restoreVouchers(f);
    for (const [key, userId, role] of [
      [selfKey, self, 'self'],
      [directKey, direct, 'direct'],
      [platform, null, null],
    ] as const) {
      const voucher = vouchers.find((v) => v.uniq_key === key);
      expect(voucher, key).toMatchObject({
        order_key: c.orderKey,
        beneficiary_user_id: userId,
        role,
        voucher_kind: 'ADMIN_ADJUST',
      });
      expect(voucher!.operator, key).toContain(h.operator.id);
    }
    expect(await available(f, self)).toBe(617n);
    expect(await available(f, direct)).toBe(123n);

    const order = await orderRow(f, c.orderId);
    expect(order.rebate_status).toBe('CREDITED');
    expect(order.booked_base_fen).toBe(1234n);
    expect(order.booked_n_fen).toBe(1234n);
    const nets = await netsOf(f, c.orderKey);
    expect(netOf(nets, self, 'self')).toBe(617n);
    expect(netOf(nets, direct, 'direct')).toBe(123n);
    expect(nets.platform_net_fen).toBe(494n);
    expect(nets.union_receivable_net_fen).toBe(1234n);
  });
});

it('[AC-B2-09gb#6] R13 按当前有效联盟佣金重算（BR-CALC-02 取值阶段）：入账 N 1000（预留 1500 → 425 / 85 / 42、平台 448）全额扣回后结算佣金 2000、预估 5555 → B 1700：本人 850、直推 170、间推 85、平台 895，不取预估、不取快照基数、不取差错单登记额（改成 999999）；结算佣金为空时取预估 1500 → B 1275：637 / 127 / 63、平台 673；同一 CAS：booked_base_fen = 新基数、booked_n_fen = 有效佣金、refunded_quantity_r9_baseline = 当时 refunded_quantity（2），refunded_quantity_at_credit（0）不动，其余列不动；row_version + 1、返利状态历史恰新增一行（CLAWED_BACK → CREDITED、ADMIN_RESTORE、来源 admin）；结算佣金为空的单没有 order_settlements 行（有效佣金只能来自预估）', async () => {
  const f = await fixture(s);
  const settled = await seedClawedBack(f, {
    settle: 2000n,
    est: 5555n,
    quantity: 3,
    refundedQuantity: 2,
    refundedAtCredit: 0,
    baselineBefore: 0,
  });
  const estimated = await seedClawedBack(f, {
    settle: null,
    est: 1500n,
    quantity: 4,
    refundedQuantity: 1,
    refundedAtCredit: null,
    baselineBefore: null,
  });
  expect(
    (await world(f)).settlements.filter((row) => row.order_id === estimated.orderId),
    'fixture: no settled amount means no order_settlements row',
  ).toEqual([]);
  const rows: readonly {
    readonly c: ClawedOrder;
    readonly patch: { expected_fen: bigint; diff_fen: bigint } | undefined;
    readonly base: bigint;
    readonly n: bigint;
    readonly shares: Readonly<Record<'self' | 'direct' | 'indirect', bigint>>;
    readonly platform: bigint;
    readonly baseline: number;
  }[] = [
    {
      c: settled,
      patch: { expected_fen: 999_999n, diff_fen: 999_999n },
      base: 1700n,
      n: 2000n,
      shares: { self: 850n, direct: 170n, indirect: 85n },
      platform: 895n,
      baseline: 2,
    },
    {
      c: estimated,
      patch: undefined,
      base: 1275n,
      n: 1500n,
      shares: { self: 637n, direct: 127n, indirect: 63n },
      platform: 673n,
      baseline: 1,
    },
  ];
  await withRestoreAdmin(f, async (h) => {
    for (const r of rows) {
      const diff = await seedPlatformDiff(f, r.c, r.patch ?? {});
      const orderBefore = await orderRow(f, r.c.orderId);
      const historyBefore = await orderHistory(f, r.c.orderId);
      const paid = addFen(addFen(r.shares.self, r.shares.direct), r.shares.indirect);
      const data = await platformRestored(await h.restore(diff.id));
      expect(data.restored_fen, String(r.n)).toBe(Number(paid));
      expect(data.rebate_status_after).toBe('CREDITED');
      const { row } = await expectAdjusted(f, diff, {
        adminId: h.operator.id,
        from: 'CLAWED_BACK',
        to: 'CREDITED',
        restoredFen: paid,
      });
      expect(row.expected_fen).toBe(diff.expected_fen);
      expect(row.diff_fen).toBe(diff.diff_fen);

      for (const role of ['self', 'direct', 'indirect'] as const) {
        const userId = r.c.user(role);
        expect(
          await voucherLines(f, restoreKey(r.c.orderKey, userId, role, diff.id)),
          `${String(r.n)} ${role}`,
        ).toEqual(memberLines(r.c.platform, userId, r.shares[role]));
        expect(await available(f, userId), `${String(r.n)} ${role}`).toBe(r.shares[role]);
      }
      expect(await voucherLines(f, platformKey(r.c.orderKey, diff.id))).toEqual(
        platformLines(r.c.platform, r.platform),
      );

      const now = await orderRow(f, r.c.orderId);
      expect(now.rebate_status).toBe('CREDITED');
      expect(now.booked_base_fen, String(r.n)).toBe(r.base);
      expect(now.booked_n_fen, String(r.n)).toBe(r.n);
      expect(now.refunded_quantity_r9_baseline, String(r.n)).toBe(r.baseline);
      expect(now.refunded_quantity_at_credit).toBe(orderBefore.refunded_quantity_at_credit);
      expect(untouched(now)).toEqual(untouched(orderBefore));
      expect(now.settle_period).toBe(orderBefore.settle_period);
      await expectRestoreStep(
        f,
        { order: orderBefore, history: historyBefore },
        { from: 'CLAWED_BACK', to: 'CREDITED' },
      );
      const nets = await netsOf(f, r.c.orderKey);
      expect(nets.union_receivable_net_fen, String(r.n)).toBe(r.n);
      expect(nets.platform_net_fen, String(r.n)).toBe(r.platform);
    }
    const records = await audits(f, RESTORE_ACTION);
    expect(records).toHaveLength(2);
    const after = text(records[0]!.after);
    expect(text(records[0]!.before)).toContain('"CLAWED_BACK"');
    expect(after).toContain('"CREDITED"');
    expect(after).toContain('"adjusted"');
    expect(after).toMatch(/"restored_fen":"?1105"?[,}]/);
  });
});

/** BR-CALC-02 / BR-CALC-04 by hand: B and the shares of THREE_PEOPLE. */
function expectedOf(n: bigint, reserveBp: number) {
  const base = mulDivFloor(n, BigInt(10000 - reserveBp), 10000n);
  const shares = THREE_PEOPLE.map((p) => ({
    role: p.role,
    fen: mulDivFloor(base, BigInt(p.ratioBp), 10000n),
  }));
  const users = shares.reduce((sum, share) => addFen(sum, share.fen), 0n);
  return { base, shares, users, platform: subFen(n, users) };
}

it('[AC-B2-09gb#7] 属性：任意入账佣金 O（1000～99999 分）、任意当前有效佣金 N（1～999999 分与大于 2^31 分）、预留 0 / 1500 / 2000 / 3333：R13 后每个受益人凭证 = floor(B × 比例 / 10000)（为 0 不写），平台凭证 = N − Σ受益人；UNION_RECEIVABLE 净额 = booked_n_fen = N，平台净额 = N − Σ受益人，booked_base_fen = floor(N × (10000 − 预留) / 10000)；restored_fen = Σ受益人', async () => {
  const f = await fixture(s);
  const params = propParams();
  const runs = Math.max(10, Math.floor(params.numRuns / 100));
  let checked = 0;
  await withRestoreAdmin(f, async (h) => {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 1000n, max: 99_999n }),
        fc.oneof(
          fc.bigInt({ min: 1n, max: 999_999n }),
          fc.bigInt({ min: 2n ** 31n, max: 2n ** 40n }),
        ),
        fc.constantFrom(0, 1500, 2000, 3333),
        async (creditFen, n, reserveBp) => {
          const c = await seedClawedBack(f, { creditFen, reserveBp, settle: n });
          const diff = await seedPlatformDiff(f, c);
          const want = expectedOf(n, reserveBp);
          const data = await platformRestored(await h.restore(diff.id));
          expect(data.restored_fen).toBe(Number(want.users));
          for (const share of want.shares) {
            const role: Role = share.role;
            const userId = c.user(role);
            const lines = await voucherLines(f, restoreKey(c.orderKey, userId, role, diff.id));
            expect(lines, role).toEqual(
              share.fen > 0n ? memberLines(c.platform, userId, share.fen) : [],
            );
          }
          expect(await voucherLines(f, platformKey(c.orderKey, diff.id))).toEqual(
            platformLines(c.platform, want.platform),
          );
          const order = await orderRow(f, c.orderId);
          expect(order.rebate_status).toBe('CREDITED');
          expect(order.booked_base_fen).toBe(want.base);
          expect(order.booked_n_fen).toBe(n);
          const nets = await netsOf(f, c.orderKey);
          expect(nets.union_receivable_net_fen).toBe(n);
          expect(nets.platform_net_fen).toBe(want.platform);
          checked += 1;
          return true;
        },
      ),
      { ...params, numRuns: runs },
    );
  });
  expect(checked).toBe(runs);
}, 900_000);

it('[AC-B2-09gb#8] R13 边界：有效佣金 1 分、预留 1500 → B = 0：不写任何受益人凭证（不写 0 金额分录），平台凭证 1、booked_base_fen 0、booked_n_fen 1、CREDITED、restored_fen 0；有效佣金 2^31 + 7 = 2147483655 分、预留 1500 → B = floor(1825361106.75) = 1825361106：本人 912680553、直推 182536110、间推 91268055、平台 960998937，restored_fen 1186484718', async () => {
  const f = await fixture(s);
  const tiny = await seedClawedBack(f, { settle: 1n });
  const large = await seedClawedBack(f, { settle: 2n ** 31n + 7n });
  await withRestoreAdmin(f, async (h) => {
    const tinyDiff = await seedPlatformDiff(f, tiny);
    const tinyData = await platformRestored(await h.restore(tinyDiff.id));
    expect(tinyData.restored_fen).toBe(0);
    expect(tinyData.rebate_status_after).toBe('CREDITED');
    const tinyKeys = (await orderVouchers(f, tiny.orderKey))
      .map((v) => v.uniq_key)
      .filter((key) => key.includes(':RESTORE:'));
    expect(tinyKeys).toEqual([platformKey(tiny.orderKey, tinyDiff.id)]);
    expect(await voucherLines(f, platformKey(tiny.orderKey, tinyDiff.id))).toEqual(
      platformLines(tiny.platform, 1n),
    );
    const tinyOrder = await orderRow(f, tiny.orderId);
    expect(tinyOrder.rebate_status).toBe('CREDITED');
    expect(tinyOrder.booked_base_fen).toBe(0n);
    expect(tinyOrder.booked_n_fen).toBe(1n);

    const largeDiff = await seedPlatformDiff(f, large);
    const largeData = await platformRestored(await h.restore(largeDiff.id));
    const shares: Readonly<Record<'self' | 'direct' | 'indirect', bigint>> = {
      self: 912_680_553n,
      direct: 182_536_110n,
      indirect: 91_268_055n,
    };
    expect(largeData.restored_fen).toBe(1_186_484_718);
    for (const role of ['self', 'direct', 'indirect'] as const) {
      const userId = large.user(role);
      expect(await voucherLines(f, restoreKey(large.orderKey, userId, role, largeDiff.id))).toEqual(
        memberLines(large.platform, userId, shares[role]),
      );
    }
    expect(await voucherLines(f, platformKey(large.orderKey, largeDiff.id))).toEqual(
      platformLines(large.platform, 960_998_937n),
    );
    const largeOrder = await orderRow(f, large.orderId);
    expect(largeOrder.booked_base_fen).toBe(1_825_361_106n);
    expect(largeOrder.booked_n_fen).toBe(2n ** 31n + 7n);
  });
});
