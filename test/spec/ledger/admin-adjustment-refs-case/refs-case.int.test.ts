// B2-12h linked documents named twice in different letter case (claude-independent, SPEC_REF
// 39756e36; FU-ADJUST-REFS-UUID-CASE): BR-FUND-24 ②③ (关联单据不得重复) through the real
// adminCreateAdjustment entry on PostgreSQL (business role). A recon_diff, withdrawal or
// account_deletion id is a UUID, so its spelling does not make it another document; an `order`
// ref_id is an order_key, which is case-sensitive, and is never case-folded.
//
// Every test runs what already holds first (one document spelled in capitals still files; the
// order_key cases) and ends on the duplicates that are accepted today, so each of them is red by
// the assertion on that response and has shown its earlier steps pass.
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  ago,
  audits,
  expectAdjusted,
  fixture,
  invalid,
  member,
  newForm,
  seedDeletion,
  seedReconDiff,
  seedWithdrawal,
  suite,
  trace,
  withAdjustAdmin,
  type AdjustAdmin,
  type AdjustFixture,
  type Ref,
  type RefType,
} from '../admin-adjustments/kit.ts';

const s = suite();

/** Ways of naming one document twice: small + capitals, either order, small + half capitals. */
function twice(type: RefType, id: string): readonly (readonly Ref[])[] {
  const lower: Ref = { ref_type: type, ref_id: id };
  const upper: Ref = { ref_type: type, ref_id: id.toUpperCase() };
  const both: Ref = { ref_type: type, ref_id: `${id.slice(0, 18).toUpperCase()}${id.slice(18)}` };
  return [
    [lower, upper],
    [upper, lower],
    [lower, both],
  ];
}

/** Each body → 20001 fields=[refs] without a reason; no form, voucher, balance or audit moved. */
async function expectDuplicatesRefused(
  f: AdjustFixture,
  h: AdjustAdmin,
  bodies: readonly Record<string, unknown>[],
): Promise<void> {
  const before = await trace(f);
  const audited = await audits(f);
  for (const body of bodies) await invalid(await h.create(body), ['refs']);
  expect(await trace(f)).toEqual(before);
  expect(await audits(f)).toEqual(audited);
}

/** A sub-order of the member with exactly this sub_order_id (as the kit's seedOrder writes it). */
async function seedSubOrder(f: AdjustFixture, userId: string, subOrderId: string): Promise<string> {
  const orderId = randomUUID();
  const at = ago(f, 10 * 24 * 60);
  await sql`INSERT INTO app.order_keys (platform, sub_order_id, order_id, app_id, attr_at, created_at)
    VALUES ('taobao', ${subOrderId}, ${orderId}, ${f.appId}, ${at}, ${at})`.execute(f.db);
  await sql`INSERT INTO app.orders
    (order_id, app_id, platform, sub_order_id, raw_item_id, user_id, user_basis, buy_type,
     platform_status, rebate_status, attr_at, created_at, updated_at)
    VALUES (${orderId}, ${f.appId}, 'taobao', ${subOrderId}, 'synthetic', ${userId}, 'param', 'self',
      'RECEIVED', 'WAITING', ${at}, ${at}, ${at})`.execute(f.db);
  return `taobao:${subOrderId}`;
}

it('[AC-B2-12h#1] 同一张 recon_diff 以大小写不同的 UUID 出现两次（RECON_FIX、PAYOUT_RECOVERY）→ 20001 fields=[refs]，不建调账单、不写凭证与审计；只有一张且写成大写 UUID → 照常生效，refs 按提交原样保存', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const lone = (await seedReconDiff(f)).id;
    const diff = (await seedReconDiff(f)).id;
    const withdrawal: Ref = { ref_type: 'withdrawal', ref_id: await seedWithdrawal(f, userId) };
    const recon = (refs: readonly Ref[]) =>
      newForm({
        userId,
        direction: 'increase',
        amount: 100n,
        reason: 'RECON_FIX',
        refs,
        note: '更正',
        contra: 'COMMISSION_REVENUE',
      });
    const recovery = (refs: readonly Ref[]) =>
      newForm({
        userId,
        direction: 'decrease',
        amount: 100n,
        reason: 'PAYOUT_RECOVERY',
        refs,
        note: '追回',
      });

    const refs: readonly Ref[] = [{ ref_type: 'recon_diff', ref_id: lone.toUpperCase() }];
    await expectAdjusted(f, await h.create(recon(refs)), {
      caller: h.maker,
      userId,
      direction: 'increase',
      amount: 100n,
      reason: 'RECON_FIX',
      contra: 'COMMISSION_REVENUE',
      refs,
      note: '更正',
      before: { available: 3000n, frozen: 0n },
    });

    const pairs = twice('recon_diff', diff);
    await expectDuplicatesRefused(f, h, [
      ...pairs.map((pair) => recon(pair)),
      ...pairs.map((pair) => recovery([...pair, withdrawal])),
    ]);
  });
});

it('[AC-B2-12h#2] 同一张 withdrawal 以大小写不同的 UUID 出现两次（PAYOUT_RECOVERY、RECON_FIX、OTHER）→ 20001 fields=[refs]，都不留痕；PAYOUT_RECOVERY 只有一张提现单且写成大写 UUID → 照常生效，对方科目取该提现单的通道', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const lone = await seedWithdrawal(f, userId, { channel: 'alipay' });
    const withdrawal = await seedWithdrawal(f, userId);
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };
    const recovery = (refs: readonly Ref[], amount: bigint) =>
      newForm({
        userId,
        direction: 'decrease',
        amount,
        reason: 'PAYOUT_RECOVERY',
        refs,
        note: '追回',
      });
    const recon = (refs: readonly Ref[]) =>
      newForm({
        userId,
        direction: 'increase',
        amount: 100n,
        reason: 'RECON_FIX',
        refs,
        note: '更正',
        contra: 'COMMISSION_REVENUE',
      });
    const other = (refs: readonly Ref[]) =>
      newForm({
        userId,
        direction: 'decrease',
        amount: 100n,
        reason: 'OTHER',
        refs,
        note: '其他调整',
        contra: 'MKT_EXPENSE',
      });

    const refs: readonly Ref[] = [{ ref_type: 'withdrawal', ref_id: lone.toUpperCase() }, diff];
    await expectAdjusted(f, await h.create(recovery(refs, 1000n)), {
      caller: h.maker,
      userId,
      direction: 'decrease',
      amount: 1000n,
      reason: 'PAYOUT_RECOVERY',
      contra: 'CASH_ALIPAY',
      refs,
      note: '追回',
      before: { available: 3000n, frozen: 0n },
    });

    const pairs = twice('withdrawal', withdrawal);
    await expectDuplicatesRefused(f, h, [
      // PAYOUT_RECOVERY takes exactly one withdrawal, so these are refused either way.
      ...pairs.map((pair) => recovery([diff, ...pair], 100n)),
      // The reason codes with no limit on withdrawals are where only the duplicate rule can refuse.
      ...pairs.map((pair) => recon([diff, ...pair])),
      ...pairs.map((pair) => other(pair)),
    ]);
  });
});

it('[AC-B2-12h#3] 同一张 account_deletion 以大小写不同的 UUID 出现两次 → 20001 fields=[refs]，都不留痕；只有一张且写成大写 UUID → 照常生效；order 单据号区分大小写：两个只差大小写的子订单号都存在时一起生效、refs 都保留，完全相同的子订单号仍算重复，只差大小写而不存在的子订单号是 adjust_ref_invalid', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    // A member has one open request (deletion_requests_open_user_key); the pairs reuse it.
    const lone = await seedDeletion(f, userId);
    const tail = randomBytes(8).toString('hex');
    const first: Ref = {
      ref_type: 'order',
      ref_id: await seedSubOrder(f, userId, `Ab${tail}`),
    };
    const second: Ref = {
      ref_type: 'order',
      ref_id: await seedSubOrder(f, userId, `aB${tail}`),
    };
    const absent: Ref = { ref_type: 'order', ref_id: `taobao:AB${tail}` };
    const other = (refs: readonly Ref[]) =>
      newForm({
        userId,
        direction: 'decrease',
        amount: 100n,
        reason: 'OTHER',
        refs,
        note: '其他调整',
        contra: 'MKT_EXPENSE',
      });
    const filed = {
      caller: h.maker,
      userId,
      direction: 'decrease',
      amount: 100n,
      reason: 'OTHER',
      contra: 'MKT_EXPENSE',
      note: '其他调整',
    } as const;

    const single: readonly Ref[] = [{ ref_type: 'account_deletion', ref_id: lone.toUpperCase() }];
    await expectAdjusted(f, await h.create(other(single)), {
      ...filed,
      refs: single,
      before: { available: 3000n, frozen: 0n },
    });
    const orders: readonly Ref[] = [first, second];
    await expectAdjusted(f, await h.create(other(orders)), {
      ...filed,
      refs: orders,
      before: { available: 2900n, frozen: 0n },
    });

    const before = await trace(f);
    const audited = await audits(f);
    await invalid(await h.create(other([first, first])), ['refs']);
    await invalid(await h.create(other([first, absent])), ['refs'], 'adjust_ref_invalid');
    for (const pair of twice('account_deletion', lone)) {
      await invalid(await h.create(other(pair)), ['refs']);
    }
    expect(await trace(f)).toEqual(before);
    expect(await audits(f)).toEqual(audited);
  });
});
