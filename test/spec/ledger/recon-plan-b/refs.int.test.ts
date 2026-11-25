// B2-17 what a person may link (claude-independent): BR-FUND-24 ⑨ 「联盟对账差错单（union_mismatch，R1）
// 不经调账处理……由人发起、关联这两类差错单的调账单不受理」 and 细则「对外差错单的调账」(被拒时返回 20001，
// data.fields=[refs]、data.reason=adjust_ref_invalid，与主干拒绝关联 R4 差错单的返回相同；由人发起、关联通道
// 对账差错单的调账单（任何原因码）不受理); §9.3 ⑨ (判定按差错单的 type; R4 照旧拒绝; ledger_mismatch 照旧
// 受理) and ⑩ (请求体与 user_id、refs 的 20001 先于 20902 recon_diff；20902 recon_diff 先于会员已注销 /
// 注销中的 20001 adjust_user_deleted). Every POST /admin/v1/adjustments is filed by a person.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  expectAdjusted,
  fixture,
  invalid,
  member,
  newForm,
  seedR4Diff,
  seedWithdrawal,
  suite,
  withAdjustAdmin,
  type Ref,
} from '../admin-adjustments/kit.ts';
import {
  diffConflict,
  diffRef,
  expectNowAdjusted,
  expectUnchanged,
  footprint,
  refInvalid,
  schemaReady,
  seedTicket,
  send,
} from './kit.ts';

const s = suite();

/** The two kinds of external diffs (contracts recon_diff type; source as registered). */
const EXTERNAL = [
  { type: 'union_mismatch', source: 'R1' },
  { type: 'channel_mismatch', source: 'R2' },
] as const;

it('[AC-B2-17#8] 由人发起的新单关联 union_mismatch 或 channel_mismatch 差错单：RECON_FIX、OTHER、PAYOUT_RECOVERY（提现单 + 差错单）都 → 20001，data 恰为 fields=[refs]、reason=adjust_ref_invalid，不留痕；与一张合法的 R3 差错单混在一起也一样，那张 R3 差错单不变', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const userId = await member(f, { available: 20_000n });
    const withdrawal: Ref = { ref_type: 'withdrawal', ref_id: await seedWithdrawal(f, userId) };
    for (const kind of EXTERNAL) {
      const external = await seedTicket(f, { type: kind.type, source: kind.source });
      const legit = await seedTicket(f);
      const bodies = [
        newForm({
          userId,
          direction: 'increase',
          amount: 300n,
          reason: 'RECON_FIX',
          refs: [diffRef(external)],
          note: '对外差错单更正',
          contra: 'COMMISSION_REVENUE',
        }),
        newForm({
          userId,
          direction: 'decrease',
          amount: 300n,
          reason: 'RECON_FIX',
          refs: [diffRef(legit), diffRef(external)],
          note: '与合法差错单混在一起',
          contra: 'MKT_EXPENSE',
        }),
        newForm({
          userId,
          direction: 'decrease',
          amount: 300n,
          reason: 'OTHER',
          refs: [diffRef(external)],
          note: '其他原因关联对外差错单',
          contra: 'BAD_DEBT',
        }),
        newForm({
          userId,
          direction: 'decrease',
          amount: 10_000n,
          reason: 'PAYOUT_RECOVERY',
          refs: [withdrawal, diffRef(external)],
          note: '人工追回重复打款',
        }),
      ];
      for (const body of bodies) {
        const label = `${kind.type} ${String(body['reason_code'])}`;
        const before = await footprint(f);
        await refInvalid(await h.create(body));
        expect(await footprint(f), label).toEqual(before);
      }
      await expectUnchanged(f, legit);
    }
  });
});

it('[AC-B2-17#9] 按差错单的 type 判：type 为 union_mismatch / channel_mismatch 而 source 记为 R3 的同样 20001 adjust_ref_invalid、不留痕；R4 差错单照旧 20001 adjust_ref_invalid；R3 ledger_mismatch 照旧受理并置 adjusted', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const userId = await member(f, { available: 1000n });
    for (const kind of EXTERNAL) {
      const odd = await seedTicket(f, { type: kind.type, source: 'R3' });
      const before = await footprint(f);
      await refInvalid(await send(h, { userId, refs: [diffRef(odd)] }));
      expect(await footprint(f), kind.type).toEqual(before);
    }
    const r4 = await seedR4Diff(f);
    const before = await footprint(f);
    await refInvalid(await send(h, { userId, refs: [diffRef(r4)] }));
    expect(await footprint(f), 'R4').toEqual(before);

    const internal = await seedTicket(f);
    const body = newForm({
      userId,
      direction: 'increase',
      amount: 100n,
      reason: 'RECON_FIX',
      refs: [diffRef(internal)],
      note: '内部差错单照旧受理',
      contra: 'COMMISSION_REVENUE',
    });
    await expectAdjusted(f, await h.create(body), {
      caller: h.maker,
      userId,
      direction: 'increase',
      amount: 100n,
      reason: 'RECON_FIX',
      contra: 'COMMISSION_REVENUE',
      refs: [diffRef(internal)],
      note: '内部差错单照旧受理',
      before: { available: 1000n, frozen: 0n },
    });
    await expectNowAdjusted(f, internal, h.maker.id);
  });
});

it('[AC-B2-17#10] 判断先后（20001 先于 20902 recon_diff）：refs 里同时有对外差错单与已 adjusted 的差错单 → 20001 adjust_ref_invalid；会员不存在而 refs 里有已 adjusted 的差错单 → 20001 fields=[user_id]；都不留痕', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const userId = await member(f, { available: 1000n });
    const concluded = await seedTicket(f, { status: 'adjusted' });
    for (const kind of EXTERNAL) {
      const external = await seedTicket(f, { type: kind.type, source: kind.source });
      for (const refs of [
        [diffRef(external), diffRef(concluded)],
        [diffRef(concluded), diffRef(external)],
      ]) {
        const before = await footprint(f);
        await refInvalid(await send(h, { userId, refs }));
        expect(await footprint(f), kind.type).toEqual(before);
      }
    }
    const before = await footprint(f);
    const stranger = randomUUID();
    await invalid(await send(h, { userId: stranger, refs: [diffRef(concluded)] }), ['user_id']);
    expect(await footprint(f)).toEqual(before);
  });
});

it('[AC-B2-17#11] 判断先后（20902 recon_diff 先于 adjust_user_deleted）：注销中（deleting）或已注销（deleted）的会员，refs 里有已 adjusted / closed 的差错单 → 20902 recon_diff；refs 里有对外差错单 → 20001 adjust_ref_invalid；refs 都可受理时才是 20001 adjust_user_deleted；都不留痕', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    for (const status of ['deleting', 'deleted'] as const) {
      const userId = await member(f, { available: 1000n, status });
      for (const concluded of ['adjusted', 'closed'] as const) {
        const diff = await seedTicket(f, { status: concluded });
        const before = await footprint(f);
        await diffConflict(await send(h, { userId, refs: [diffRef(diff)] }));
        expect(await footprint(f), `${status} ${concluded}`).toEqual(before);
      }
      for (const kind of EXTERNAL) {
        const external = await seedTicket(f, { type: kind.type, source: kind.source });
        const before = await footprint(f);
        await refInvalid(await send(h, { userId, refs: [diffRef(external)] }));
        expect(await footprint(f), `${status} ${kind.type}`).toEqual(before);
      }
      const open = await seedTicket(f);
      const before = await footprint(f);
      await invalid(
        await send(h, { userId, refs: [diffRef(open)] }),
        ['user_id'],
        'adjust_user_deleted',
      );
      expect(await footprint(f), `${status} open`).toEqual(before);
    }
  });
});
