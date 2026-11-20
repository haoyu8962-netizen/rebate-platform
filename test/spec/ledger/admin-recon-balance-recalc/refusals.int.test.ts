// B2-02x differences that cannot be recalculated (claude-independent, SPEC_REF ba6655b1):
// recalcBalanceAdminReconDiff (CT-24zzn) — an unknown recon_diff_id, a difference of another app or
// one of source R4 is 20001 data.fields=[recon_diff_id] (no 404); a difference whose type is not
// ledger_mismatch, whose status is adjusted / written_off / closed, or that names no single member
// account (ref_type voucher / order / app, a platform account, an account of another app, an
// account that does not exist, one without its account_balances row, a malformed ref_id) is the
// same 20001 with no data.reason, and nothing is written: no balance row, no audit record, the
// difference and its holds as they were. Every refused difference here sits on a member whose
// cache disagrees with the entries, so a recalculation that went through would show.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  RECALC_ACTION,
  accountWithoutBalance,
  answer,
  audits,
  balanceCache,
  expectRecalculated,
  fixture,
  newAppId,
  notApplicable,
  plainMember,
  platformAccountOf,
  seedMismatch,
  suite,
  tamper,
  untouched,
  withRecalcAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-02x#32] 不存在的 id、其他应用的差错单、source R4 的收款差错、不是 UUID 的 id → 20001 data.fields=[recon_diff_id]（不回 404，前三种应答一样），什么都不写', async () => {
  const f = fixture(s);
  const otherApp = newAppId();
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 4900n);
    await tamper(f, m, { available: 5000n, frozen: 0n, negativeSince: null });
    const stranger = await plainMember(f, 100n, otherApp);
    await tamper({ ...f, appId: otherApp }, stranger, {
      available: 300n,
      frozen: 0n,
      negativeSince: null,
    });
    const foreign = await seedMismatch(f, stranger, { app_id: otherApp });
    const r4 = await seedMismatch(f, m, {
      source: 'R4',
      type: 'pay_mismatch',
      ref_type: 'pay_order',
      ref_id: randomUUID(),
    });
    const cache = await balanceCache(f);
    const foreignCache = await balanceCache(f, otherApp);
    const trace = await untouched(f);
    const foreignTrace = await untouched(f, otherApp);

    for (const id of [randomUUID(), foreign.id, r4.id]) {
      await notApplicable(await h.recalc(id, { reason: '核对' }));
    }
    await answer(await h.recalc('not-a-uuid', { reason: '核对' }), 20001, {
      fields: ['recon_diff_id'],
    });
    expect(await balanceCache(f)).toEqual(cache);
    expect(await balanceCache(f, otherApp), '其他应用会员的缓存不动').toEqual(foreignCache);
    expect(await untouched(f)).toEqual(trace);
    expect(await untouched(f, otherApp)).toEqual(foreignTrace);
    expect(await audits(f, RECALC_ACTION)).toEqual([]);
  });
});

it('[AC-B2-02x#33] 类型不是 ledger_mismatch（同样登记在会员账户上）、状态已是 adjusted / written_off / closed → 20001 data.fields=[recon_diff_id]（无 data.reason），余额行、差错单都不动，不写审计', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 4900n);
    await tamper(f, m, { available: 5000n, frozen: 0n, negativeSince: null });
    const handler = await h.caller([]);
    const refused = [
      await seedMismatch(f, m, { type: 'union_mismatch', source: 'R1' }),
      await seedMismatch(f, m, { type: 'month_end_unbalanced' }),
      // recon_diffs_business_key is (app_id, type, period, ref_id): the three closed
      // ledger_mismatch rows sit on the same member account, so each takes its own
      // earlier period (the open one below keeps PERIOD).
      ...(await Promise.all(
        (
          [
            ['adjusted', '2026-11-14'],
            ['written_off', '2026-11-15'],
            ['closed', '2026-11-16'],
          ] as const
        ).map(([status, period]) =>
          seedMismatch(f, m, {
            status,
            period,
            handler_id: handler.id,
            closed_at: new Date(f.clock.now().getTime() - 3_600_000),
            resolution: { reason: `已${status}` },
          }),
        ),
      )),
    ];
    const cache = await balanceCache(f);
    const trace = await untouched(f);
    for (const diff of refused) {
      await notApplicable(await h.recalc(diff.id, { reason: `${diff.type} ${diff.status}` }));
    }
    expect(await balanceCache(f)).toEqual(cache);
    expect(await untouched(f)).toEqual(trace);
    expect(await audits(f, RECALC_ACTION)).toEqual([]);

    const open = await seedMismatch(f, m);
    await expectRecalculated(f, await h.recalc(open.id, { reason: '同一会员的未关闭单' }), {
      m,
      before: { available: 5000n, frozen: 0n },
      after: { available: 4900n, frozen: 0n },
      changed: true,
    });
  });
});

it('[AC-B2-02x#34] 不指向单个会员账户的 ledger_mismatch → 20001 [recon_diff_id]：ref_type 为 voucher / order / app，ref_id 指向平台科目账户、其他应用会员的账户、不存在的账户、没有余额行的账户，或 ref_id 不是 {invariant}:{account_id}；都不写', async () => {
  const f = fixture(s);
  const otherApp = newAppId();
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 4900n);
    await tamper(f, m, { available: 5000n, frozen: 0n, negativeSince: null });
    const stranger = await plainMember(f, 100n, otherApp);
    await tamper({ ...f, appId: otherApp }, stranger, {
      available: 999n,
      frozen: 0n,
      negativeSince: null,
    });
    const platform = await platformAccountOf(f);
    const bare = await accountWithoutBalance(f);
    const refused = [
      await seedMismatch(f, m, { ref_type: 'voucher', ref_id: `02:${randomUUID()}` }),
      await seedMismatch(f, m, { ref_type: 'order', ref_id: `05:taobao:${randomUUID()}` }),
      await seedMismatch(f, m, { ref_type: 'app', ref_id: `pay-04:${f.appId}` }),
      await seedMismatch(f, m, { ref_type: 'voucher' }),
      await seedMismatch(f, { accountId: platform }),
      await seedMismatch(f, stranger),
      await seedMismatch(f, { accountId: randomUUID() }),
      await seedMismatch(f, { accountId: bare }),
      await seedMismatch(f, m, { ref_id: m.accountId }),
      await seedMismatch(f, m, { ref_id: '01:not-a-uuid' }),
      await seedMismatch(f, m, { ref_id: `01:${m.accountId}:extra` }),
    ];
    const cache = await balanceCache(f);
    const foreign = await balanceCache(f, otherApp);
    const trace = await untouched(f);
    for (const diff of refused) {
      await notApplicable(await h.recalc(diff.id, { reason: `${diff.ref_type} ${diff.ref_id}` }));
    }
    expect(await balanceCache(f)).toEqual(cache);
    expect(await balanceCache(f, otherApp), '其他应用会员的缓存不动').toEqual(foreign);
    expect(await untouched(f)).toEqual(trace);
    expect(await audits(f, RECALC_ACTION)).toEqual([]);
  });
});
