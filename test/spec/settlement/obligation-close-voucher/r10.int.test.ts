// B2-04zzb: R10 (BR-FUND-09 negative route, SETTLE_ADJUST) forfeits an unfinished obligation and
// references the platform voucher it wrote, `{order_key}:PLATFORM:ADJ:{seq}` (BR-FUND-04 ⑫「迁移 R9、R10
// ……都关联实际履约的凭证（该事务的平台凭证……；平台差额为 0、没写平台凭证的，记该事务的结算记录 seq……）」).
// Obligations kept or opened by the same R10 stay open with no voucher. Both callers of the R10 core:
// the union's new record answering a rights success that waits for it (B2-04zza, D10-781) and the
// ordinary order sync (B2-04zi), the latter on the assembled sync worker (sync-kit.ts) so the new
// record is the one recordApi writes in that sync transaction.
//
// Credit kit defaults (N 1000 → B 850; 425 / 85 / 42; platform 448). New record 600 (seq 3) → B 510
// → 255 / 51 / 25. New record 840 (seq 3) → B 714 → 357 / 71 / 35.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  FORFEITING,
  LATER,
  TIMEOUT,
  databaseFixture,
  harness,
  obligationCasMisses,
  people,
  platformAdjKey,
  platformDecreaseLines,
  platformIncreaseLines,
  receivable,
} from './kit.ts';
import {
  MEMBER_ROLE,
  expectSyncLinked,
  heldThenSynced,
  memberObligation,
  settled,
  syncPlatformAdjKey,
  syncVouchersByKey,
  touched,
  withSync,
} from './sync-kit.ts';

const p = databaseFixture(createTestDatabase);

// Self held at credit (pending 425), later banned / deleted: direct 85 → 51 (−34), indirect 42 → 25
// (−17); self's share 255 → platform; platform new = 600 − 51 − 25 = 524, old 448 → INCREASE 76.
for (const [index, [state, reason]] of FORFEITING.entries()) {
  it(
    `[AC-B2-04zzb#${String(index + 9)}] 本人入账时冻结（first_credit 义务、待补记 425），之后${state}；维权成功等佣金中，联盟新结算记录 600（seq 3）负差 → R10：义务 forfeited / closed_by R10 / closed_ref S3，voucher_id = 本事务平台凭证 {order_key}:PLATFORM:ADJ:3（SETTLE_ADJUST，平台 +76）的 id；追加 forfeited 事件（${reason}）`,
    async () => {
      const h = await harness(p.db);
      const { o } = await h.waiting({ people: people({ self: 'frozen' }) }, (seeded) =>
        h.setState(seeded, 'self', state),
      );
      const before = await h.obligationOf(o, 'self');
      expect(before).toMatchObject({ kind: 'first_credit', status: 'open', voucher_id: null });

      h.clock.set(LATER);
      const { result } = await h.arrive(o, { settleAfter: 600n, newSeq: 3 });

      expect(result).toMatchObject({ outcome: 'settle_adjusted', transition: 'R10' });
      expect(await h.voucherLines(platformAdjKey(o, 3))).toEqual(platformIncreaseLines(o, 76n));
      const row = await h.expectLinked(o, 'self', {
        closedBy: 'R10',
        closedRef: 'S3',
        uniqKey: platformAdjKey(o, 3),
        kind: 'SETTLE_ADJUST',
      });
      expect(row).toMatchObject({
        beneficiary_credit_id: before.beneficiary_credit_id,
        closed_at: new Date(LATER),
      });
      expect(await h.newBeneficiaryEvents(o)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ user_id: o.user('self'), status: 'forfeited', reason }),
        ]),
      );
    },
    TIMEOUT,
  );
}

it(
  '[AC-B2-04zzb#12] 本人此前已有延后差额义务（deferred，待补记 425），现封禁；维权等佣金中联盟新结算记录 600 负差 → R10：延后义务 forfeited / closed_by R10 / closed_ref S3，voucher_id = 本事务平台凭证 PLATFORM:ADJ:3 的 id（不追加 forfeited 事件）',
  async () => {
    const h = await harness(p.db);
    let deferredId = '';
    const { o } = await h.waiting({}, async (seeded) => {
      await h.pastVoucher(seeded, 'self', 425n, 'receivable');
      deferredId = await h.seedDeferred(seeded, 'self');
      await h.setState(seeded, 'self', 'banned');
    });
    const events = await h.newBeneficiaryEvents(o);

    h.clock.set(LATER);
    const { result } = await h.arrive(o, { settleAfter: 600n, newSeq: 3 });

    expect(result).toMatchObject({ outcome: 'settle_adjusted', transition: 'R10' });
    const row = await h.expectLinked(o, 'self', {
      closedBy: 'R10',
      closedRef: 'S3',
      uniqKey: platformAdjKey(o, 3),
      kind: 'SETTLE_ADJUST',
    });
    expect(row).toMatchObject({ beneficiary_credit_id: deferredId, kind: 'deferred' });
    expect(await h.newBeneficiaryEvents(o)).toEqual(events);
  },
  TIMEOUT,
);

// Direct and indirect held at credit, direct later banned, indirect still frozen. Record 600:
// self −170; direct's share 51 → platform (forfeited); indirect pending 42 → 25 (kept);
// platform new = 600 − 255 − 25 = 320, old 448 → DECREASE 128.
it(
  '[AC-B2-04zzb#13] 同一 R10 事务里：直推（冻结后封禁）义务 forfeited 并关联本事务平台凭证 PLATFORM:ADJ:3（平台冲回 128），间推（仍冻结）义务保持 open、voucher_id null、一列不改',
  async () => {
    const h = await harness(p.db);
    const { o } = await h.waiting(
      { people: people({ direct: 'frozen', indirect: 'frozen' }) },
      (seeded) => h.setState(seeded, 'direct', 'banned'),
    );
    const indirect = await h.obligationOf(o, 'indirect');

    h.clock.set(LATER);
    const { result } = await h.arrive(o, { settleAfter: 600n, newSeq: 3 });

    expect(result).toMatchObject({ outcome: 'settle_adjusted', transition: 'R10' });
    expect(await h.voucherLines(platformAdjKey(o, 3))).toEqual(platformDecreaseLines(o, 128n));
    expect(await h.obligationOf(o, 'indirect')).toEqual(indirect);
    await h.expectLinked(o, 'direct', {
      closedBy: 'R10',
      closedRef: 'S3',
      uniqKey: platformAdjKey(o, 3),
      kind: 'SETTLE_ADJUST',
    });
  },
  TIMEOUT,
);

// Direct held at credit then banned; an earlier clawback moved indirect's 42 to the platform (net 0,
// platform 490), indirect frozen with no obligation. Record 600: self −170; direct forfeited;
// indirect pending 25 → a new deferred obligation opened by R10; platform 490 → 320 (DECREASE 170).
it(
  '[AC-B2-04zzb#14] 同一 R10 事务里：直推义务 forfeited 并关联本事务平台凭证 PLATFORM:ADJ:3，间推新开的延后差额义务（opened_by R10）open、voucher_id null',
  async () => {
    const h = await harness(p.db);
    const { o } = await h.waiting({ people: people({ direct: 'frozen' }) }, async (seeded) => {
      await h.pastVoucher(seeded, 'indirect', 42n, 'revenue');
      await h.setState(seeded, 'direct', 'banned');
      await h.setState(seeded, 'indirect', 'frozen');
    });
    expect((await h.orderObligations(o)).filter((r) => r.role === 'indirect')).toEqual([]);

    h.clock.set(LATER);
    const { result } = await h.arrive(o, { settleAfter: 600n, newSeq: 3 });

    expect(result).toMatchObject({ outcome: 'settle_adjusted', transition: 'R10' });
    expect(await h.obligationOf(o, 'indirect')).toMatchObject({
      kind: 'deferred',
      status: 'open',
      opened_by: 'R10',
      closed_by: null,
      closed_ref: null,
      voucher_id: null,
    });
    await h.expectLinked(o, 'direct', {
      closedBy: 'R10',
      closedRef: 'S3',
      uniqKey: platformAdjKey(o, 3),
      kind: 'SETTLE_ADJUST',
    });
  },
  TIMEOUT,
);

// Ordinary sync on the assembled worker (sync-kit.ts; reserve 0, own share 50 %): N 1000 → B 1000,
// member 500 held at credit (pending 500), platform credit 500. Member later banned.
//   report 600 (seq 2 by recordApi): member's 300 → platform; platform new 600, old 500 → +100
//     (PLATFORM:ADJ:2 credits COMMISSION_REVENUE 100, debits UNION_RECEIVABLE 100);
//   report 500 (seq 2, another app): member's 250 → platform; platform new 500 = old → no voucher.
it(
  '[AC-B2-04zzb#15] 普通订单同步（无维权记录，组装好的同步 worker，联盟报文带新结算金额、由 recordApi 写记录）：会员入账时冻结后封禁，新结算 600（seq 2）负差 → R10：义务 forfeited / closed_by R10 / closed_ref S2，voucher_id = 本事务平台凭证 {order_key}:PLATFORM:ADJ:2（平台 +100）的 id；另一 app 同样前置、新结算 500 → 平台差额为 0、不写平台凭证，义务 forfeited、voucher_id null、closed_ref S2 兜底',
  async () => {
    await withSync(p.db, async (w) => {
      const linked = await heldThenSynced(p.db, w, 'banned');
      const flat = await heldThenSynced(p.db, w, 'banned');
      const flatBefore = await flat.read.money();

      await linked.o.sync(settled(600n, touched(1)));

      expect(await linked.o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 600n,
        booked_n_fen: 600n,
      });
      expect(await linked.read.history()).toMatchObject([{ event: 'SETTLE_NEGATIVE_DIFF' }]);
      await linked.read.adjustment(2, 0n, -100n);
      expect(await flat.read.money()).toEqual(flatBefore);
      const row = await expectSyncLinked(p.db, linked.app, linked.o, linked.read, {
        closedRef: 'S2',
        uniqKey: syncPlatformAdjKey(linked.o, 2),
      });
      expect(row).toMatchObject({
        beneficiary_credit_id: linked.opened.beneficiary_credit_id,
        user_id: linked.app.userId,
        role: MEMBER_ROLE,
        closed_at: w.clock.now(),
      });

      await flat.o.sync(settled(500n, touched(1)));

      expect(await flat.o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 500n,
        booked_n_fen: 500n,
      });
      expect(await flat.read.history()).toMatchObject([{ event: 'SETTLE_NEGATIVE_DIFF' }]);
      expect(await syncVouchersByKey(p.db, flat.app, syncPlatformAdjKey(flat.o, 2))).toEqual([]);
      expect(await memberObligation(flat.read)).toMatchObject({
        beneficiary_credit_id: flat.opened.beneficiary_credit_id,
        status: 'forfeited',
        closed_by: 'R10',
        closed_ref: 'S2',
        voucher_id: null,
      });
      expect((await memberObligation(linked.read)).voucher_id).toBe(row.voucher_id);
    });
  },
  TIMEOUT,
);

// Direct held at credit then banned, self and indirect credited. Record 840: self 425 → 357 (−68),
// indirect 42 → 35 (−7); direct's share 71 → platform; platform new = 840 − 357 − 35 = 448 = old.
it(
  '[AC-B2-04zzb#16] 平台差额为 0：维权等佣金中联盟新结算记录 840（seq 3）→ R10 只扣本人 68、间推 7，不写平台凭证 → 直推义务 forfeited、voucher_id null、closed_ref S3（结算记录 seq）兜底；同 app 另一单记录 600 → 平台冲回 128，voucher_id = 其 PLATFORM:ADJ:3',
  async () => {
    const h = await harness(p.db);
    const spec = { people: people({ direct: 'frozen' }) };
    const zero = await h.waiting(spec, (seeded) => h.setState(seeded, 'direct', 'banned'));
    const other = await h.waiting(spec, (seeded) => h.setState(seeded, 'direct', 'banned'));

    h.clock.set(LATER);
    const flat = await h.arrive(zero.o, { settleAfter: 840n, newSeq: 3 });
    expect(flat.result).toMatchObject({
      outcome: 'settle_adjusted',
      transition: 'R10',
      bookedBaseFen: 714n,
      bookedNFen: 840n,
    });
    expect(await h.platformKeys(zero.o)).toEqual([`${zero.o.orderKey}:PLATFORM:CREDIT`]);
    expect(await h.orderSubjectNet(zero.o, receivable(zero.o))).toBe(840n);
    expect(await h.obligationOf(zero.o, 'direct')).toMatchObject({
      status: 'forfeited',
      closed_by: 'R10',
      closed_ref: 'S3',
      voucher_id: null,
    });

    const moved = await h.arrive(other.o, { settleAfter: 600n, newSeq: 3 });
    expect(moved.result).toMatchObject({ outcome: 'settle_adjusted', transition: 'R10' });
    await h.expectLinked(other.o, 'direct', {
      closedBy: 'R10',
      closedRef: 'S3',
      uniqKey: platformAdjKey(other.o, 3),
      kind: 'SETTLE_ADJUST',
    });
    expect((await h.obligationOf(zero.o, 'direct')).voucher_id).toBeNull();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzb#17] 重投：R10 之后同一同步变更再投递一次 → 不再记账，已关闭义务的 voucher_id / closed_* 不被改写，订单凭证不增加',
  async () => {
    const h = await harness(p.db);
    const { o } = await h.waiting({ people: people({ direct: 'frozen' }) }, (seeded) =>
      h.setState(seeded, 'direct', 'banned'),
    );
    h.clock.set(LATER);
    const { change, source } = await h.arrive(o, { settleAfter: 600n, newSeq: 3 });
    const linked = await h.expectLinked(o, 'direct', {
      closedBy: 'R10',
      closedRef: 'S3',
      uniqKey: platformAdjKey(o, 3),
      kind: 'SETTLE_ADJUST',
    });
    const keys = await h.orderVoucherKeys(o);
    const vouchers = await h.vouchers();

    const replayed = await h.deliver(change, source);

    expect(['skipped', 'no_change']).toContain(replayed.outcome);
    expect(await h.obligationOf(o, 'direct')).toEqual(linked);
    expect(await h.orderVoucherKeys(o)).toEqual(keys);
    expect(await h.vouchers()).toEqual(vouchers);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzb#18] 原子：R10 同步事务里义务处置之后一步失败、或义务 CAS 未命中 → 整体回滚（PLATFORM:ADJ:3 与义务都不落，维权记录仍等佣金，全部行与之前相同）；之后正常同步一次 → 凭证与义务同事务落库，voucher_id = 该平台凭证',
  async () => {
    const h = await harness(p.db);
    const { o } = await h.waiting({ people: people({ direct: 'frozen' }) }, (seeded) =>
      h.setState(seeded, 'direct', 'banned'),
    );
    h.clock.set(LATER);
    const before = await h.everything();

    await expect(
      h.arrive(o, {
        settleAfter: 600n,
        newSeq: 3,
        after: () => Promise.reject(new Error('injected failure after the clawback answered')),
      }),
    ).rejects.toThrow('injected failure after the clawback answered');
    expect(await h.everything()).toEqual(before);

    const missed = obligationCasMisses(p.db);
    await expect(h.arrive(o, { settleAfter: 600n, newSeq: 3, via: missed.db })).rejects.toThrow();
    expect(missed.misses()).toBeGreaterThanOrEqual(1);
    expect(await h.everything()).toEqual(before);
    expect(await h.obligationOf(o, 'direct')).toMatchObject({ status: 'open', voucher_id: null });

    const { result } = await h.arrive(o, { settleAfter: 600n, newSeq: 3 });
    expect(result).toMatchObject({ outcome: 'settle_adjusted', transition: 'R10' });
    await h.expectLinked(o, 'direct', {
      closedBy: 'R10',
      closedRef: 'S3',
      uniqKey: platformAdjKey(o, 3),
      kind: 'SETTLE_ADJUST',
    });
  },
  TIMEOUT,
);
