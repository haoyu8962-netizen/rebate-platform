// B2-09zb rule tests (claude-independent, SPEC_REF 18f0015), rewritten for B1-18g (SPEC_REF 7c4694f,
// 08 BR-FUND-09 细则「正差批准的默认」⑤, BR-CALC-23 细则指针; D10-1258 / D10-1259 replace D10-780):
// the candidates of one order and settlement seq are deduplicated by the seq and each party's
// difference, not by commission_version.
// - Version moved, differences unchanged (e.g. BR-CALC-27「仅补贴变化的版本」): pending candidates stay
//   as they are, approved / rejected ones are left alone and are not generated again; no void, no
//   audit, no batch.
// - Version moved and the differences changed: pending candidates of the seq become voided_stale_seq
//   (reason superseded_by_version, decided_at the Clock) on the same transaction before the new rows,
//   with one system audit record (action settle_adjust_candidate_superseded: the order, the old and the
//   new version); approved / rejected rows are left alone and the new rows are generated.
// A version bump alone cannot change a difference (BR-FUND-09: B_settle and the snapshot's fixed ratios
// less the nets), so the "differences changed" case bans the self beneficiary with the bump
// (BR-CALC-09: the share goes to the platform row; 1234 → 1300 then gives direct +7, platform +59,
// as in states.int.test.ts).
import { expect, it } from 'vitest';
import {
  EXAMPLE,
  SUPERSEDED_ACTION,
  SUPERSEDED_REASON,
  TIMEOUT,
  adjustHarness,
  beneficiaryRow,
  createDatabase,
  databaseFixture,
  ordered,
  platformRow,
  text,
  valuesOf,
  type AdjustHarness,
  type SeededOrder,
} from './harness.ts';

const p = databaseFixture(createDatabase);

const QUIET_RUN = '2032-07-24T10:30:00+08:00';
const SECOND_RUN = '2032-07-24T11:00:00+08:00';

/** A new commission_version whose differences differ: self banned, then the version moved to `to`. */
async function bumpWithChangedDiffs(h: AdjustHarness, o: SeededOrder, to: number): Promise<void> {
  await h.risk(o.user('self'), 'banned');
  await h.bumpCommissionVersion(o, to);
}

it(
  '[AC-B2-09zb#7] [AC-B1-18g#1] 同 seq 已有 v1 的 pending，佣金版本变成 v2 而各方差额不变（如仅补贴变化）再跑：待审候选原样（仍 v1、pending、原批次），不新增、不作废、无审计、不建批次',
  async () => {
    const h = await adjustHarness(p.db);
    const { o, seq } = await h.raised(EXAMPLE, 1300n);
    const first = await h.run();
    const old = await h.allRows();
    expect(ordered(old)).toEqual([
      beneficiaryRow(o, 'self', 33n, seq),
      beneficiaryRow(o, 'direct', 7n, seq),
      platformRow(26n, seq),
    ]);
    expect(old.every((r) => r.batch_id === first.batchId)).toBe(true);
    await h.bumpCommissionVersion(o, 2);
    expect(await h.read(o)).toMatchObject({ commission_version: 2 });
    h.clock.set(SECOND_RUN);

    const second = await h.run();

    expect(second).toEqual({ batchId: null, orders: 0, candidates: 0, superseded: 0 });
    expect(await h.allRows()).toEqual(old);
    expect(await h.batches()).toHaveLength(1);
    expect(await h.audits(SUPERSEDED_ACTION)).toEqual([]);
    await h.expectNoEmptyBatch();
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#7] [AC-B1-18g#2] v1 的 pending 经过一次差额不变的换版本（v2）仍原样；再换到 v3 且各方差额变了（本人被封禁，份额并入平台）：v1 旧行 voided_stale_seq（reason superseded_by_version、decided_at 为当时时钟、无审批人），按新差额生成 v3 pending（直推 +7、平台 +59）；superseded 3，一条系统审计（单号、旧版本 1、新版本 3）',
  async () => {
    const h = await adjustHarness(p.db);
    const { o, seq } = await h.raised(EXAMPLE, 1300n);
    const first = await h.run();
    const old = await h.rowsOf(o);
    expect(old).toHaveLength(3);
    await h.bumpCommissionVersion(o, 2);
    h.clock.set(QUIET_RUN);
    expect(await h.run()).toEqual({ batchId: null, orders: 0, candidates: 0, superseded: 0 });
    expect(await h.rowsOf(o)).toEqual(old);
    await bumpWithChangedDiffs(h, o, 3);
    h.clock.set(SECOND_RUN);

    const second = await h.run();

    const rows = await h.rowsOf(o);
    expect(rows).toHaveLength(5);
    for (const before of old) {
      const now = rows.find((r) => r.id === before.id);
      expect(now, before.id).toMatchObject({
        status: 'voided_stale_seq',
        reason: SUPERSEDED_REASON,
        decided_at: new Date(SECOND_RUN),
        approver: null,
        commission_version: 1,
        batch_id: first.batchId,
        diff_fen: before.diff_fen,
      });
    }
    const fresh = rows.filter((r) => r.commission_version === 3);
    expect(ordered(fresh)).toEqual([
      beneficiaryRow(o, 'direct', 7n, seq, 3),
      platformRow(59n, seq, 3),
    ]);
    // Only one live pending set for the seq.
    expect(
      rows
        .filter((r) => r.status === 'pending')
        .map((r) => r.id)
        .sort(),
    ).toEqual(fresh.map((r) => r.id).sort());
    expect(second.batchId).not.toBeNull();
    expect(second.batchId).not.toBe(first.batchId);
    expect(fresh.every((r) => r.batch_id === second.batchId)).toBe(true);
    expect(second).toMatchObject({ orders: 1, candidates: 2, superseded: 3 });

    const records = await h.audits(SUPERSEDED_ACTION);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record).toMatchObject({ admin_id: null, system_actor: 'system:settlement' });
    expect(record.at).toEqual(new Date(SECOND_RUN));
    expect(text([record.target, record.before, record.after])).toContain(o.orderId);
    expect(valuesOf(record.before)).toContain('1');
    expect(valuesOf(record.after)).toContain('3');
    await h.expectNoEmptyBatch();
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#7] [AC-B1-18g#3] 上两种情形之后同 seq 再跑（含再换一次差额不变的版本 v4）：不再新增、不再作废、审计条数不变、不建批次',
  async () => {
    const h = await adjustHarness(p.db);
    const { o } = await h.raised(EXAMPLE, 1300n);
    await h.run();
    await h.bumpCommissionVersion(o, 2);
    expect(await h.run()).toEqual({ batchId: null, orders: 0, candidates: 0, superseded: 0 });
    await bumpWithChangedDiffs(h, o, 3);
    expect(await h.run()).toMatchObject({ orders: 1, candidates: 2, superseded: 3 });
    const settled = await h.allRows();
    expect(await h.audits(SUPERSEDED_ACTION)).toHaveLength(1);

    expect(await h.run()).toEqual({ batchId: null, orders: 0, candidates: 0, superseded: 0 });
    expect(await h.allRows()).toEqual(settled);

    await h.bumpCommissionVersion(o, 4);
    expect(await h.run()).toEqual({ batchId: null, orders: 0, candidates: 0, superseded: 0 });
    expect(await h.allRows()).toEqual(settled);
    expect(await h.audits(SUPERSEDED_ACTION)).toHaveLength(1);
    expect(await h.batches()).toHaveLength(2);
    await h.expectNoEmptyBatch();
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#7] [AC-B1-18g#4] 旧版本的行已批准 / 已拒绝：换版本而差额不变——都不动，已拒绝的不重新生成、已批准的也不重生成，无作废、无审计、不建批次；再换版本且差额变了（本人被封禁）——旧行仍不动，按新差额生成新候选（直推 +7、平台 +59），无作废、无审计',
  async () => {
    const h = await adjustHarness(p.db);
    const approvedOrder = await h.raised(EXAMPLE, 1300n);
    const rejectedOrder = await h.raised(EXAMPLE, 1300n);
    await h.run();
    const approver = await h.admin();
    await h.decide(approvedOrder.o, 'approved', approver, '2032-07-24T10:20:00+08:00');
    await h.decide(rejectedOrder.o, 'rejected', approver, '2032-07-24T10:20:00+08:00');
    const decided = await h.allRows();
    expect(decided).toHaveLength(6);
    await h.bumpCommissionVersion(approvedOrder.o, 2);
    await h.bumpCommissionVersion(rejectedOrder.o, 2);
    h.clock.set(QUIET_RUN);

    // Differences unchanged: nothing generated again.
    expect(await h.run()).toEqual({ batchId: null, orders: 0, candidates: 0, superseded: 0 });
    expect(await h.allRows()).toEqual(decided);
    expect(await h.batches()).toHaveLength(1);
    expect(await h.audits(SUPERSEDED_ACTION)).toEqual([]);

    // Differences changed (BR-FUND-09 ⑤: 各方差额变了的 … 再生成新候选).
    await bumpWithChangedDiffs(h, approvedOrder.o, 3);
    await bumpWithChangedDiffs(h, rejectedOrder.o, 3);
    h.clock.set(SECOND_RUN);

    const result = await h.run();

    const rows = await h.allRows();
    for (const before of decided) {
      expect(rows.find((r) => r.id === before.id)).toEqual(before);
    }
    for (const { o, seq } of [approvedOrder, rejectedOrder]) {
      const own = await h.rowsOf(o);
      expect(own).toHaveLength(5);
      expect(ordered(own.filter((r) => r.commission_version === 3))).toEqual([
        beneficiaryRow(o, 'direct', 7n, seq, 3),
        platformRow(59n, seq, 3),
      ]);
    }
    expect(result).toMatchObject({ orders: 2, candidates: 4, superseded: 0 });
    expect(await h.audits(SUPERSEDED_ACTION)).toEqual([]);
    await h.expectNoEmptyBatch();
  },
  TIMEOUT,
);
