// B2-09zb rule tests (claude-independent, SPEC_REF 18f0015): D10-780 — the same order and settlement
// seq already has pending candidates of another commission_version: on the same transaction they
// become voided_stale_seq (reason superseded_by_version, decided_at the Clock) before the new rows of
// the current version, with one system audit record (action settle_adjust_candidate_superseded:
// the order, the old and the new version). Approved / rejected rows of the old version are left as
// they are and do not stop the new version's rows.
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
} from './harness.ts';

const p = databaseFixture(createDatabase);

const SECOND_RUN = '2032-07-24T11:00:00+08:00';

it(
  '[AC-B2-09zb#7] 同 seq 已有 v1 的 pending，佣金版本变成 v2 再跑：旧行 voided_stale_seq（reason superseded_by_version、decided_at 为当时时钟、无审批人），新行 v2 pending；一条系统审计（单号、旧版本 1、新版本 2）',
  async () => {
    const h = await adjustHarness(p.db);
    const { o, seq } = await h.raised(EXAMPLE, 1300n);
    const first = await h.run();
    const old = await h.rowsOf(o);
    expect(old).toHaveLength(3);
    await h.bumpCommissionVersion(o, 2);
    h.clock.set(SECOND_RUN);

    const second = await h.run();

    const rows = await h.rowsOf(o);
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
    const fresh = rows.filter((r) => r.commission_version === 2);
    expect(ordered(fresh)).toEqual([
      beneficiaryRow(o, 'self', 33n, seq, 2),
      beneficiaryRow(o, 'direct', 7n, seq, 2),
      platformRow(26n, seq, 2),
    ]);
    expect(second.batchId).not.toBeNull();
    expect(second.batchId).not.toBe(first.batchId);
    expect(fresh.every((r) => r.batch_id === second.batchId)).toBe(true);
    expect(second).toMatchObject({ orders: 1, candidates: 3, superseded: 3 });

    const records = await h.audits(SUPERSEDED_ACTION);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record).toMatchObject({ admin_id: null, system_actor: 'system:settlement' });
    expect(record.at).toEqual(new Date(SECOND_RUN));
    expect(text([record.target, record.before, record.after])).toContain(o.orderId);
    expect(valuesOf(record.before)).toContain('1');
    expect(valuesOf(record.after)).toContain('2');
    await h.expectNoEmptyBatch();
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#7] 同 seq 同版本 v2 再跑一次：不再作废、不再写审计、不建批次',
  async () => {
    const h = await adjustHarness(p.db);
    const { o } = await h.raised(EXAMPLE, 1300n);
    await h.run();
    await h.bumpCommissionVersion(o, 2);
    await h.run();
    const settled = await h.allRows();

    expect(await h.run()).toEqual({ batchId: null, orders: 0, candidates: 0, superseded: 0 });
    expect(await h.allRows()).toEqual(settled);
    expect(await h.audits(SUPERSEDED_ACTION)).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#7] 旧版本的行已批准 / 已拒绝：不动它们，也不阻挡新版本照常生成；无作废、无审计',
  async () => {
    const h = await adjustHarness(p.db);
    const approvedOrder = await h.raised(EXAMPLE, 1300n);
    const rejectedOrder = await h.raised(EXAMPLE, 1300n);
    await h.run();
    const approver = await h.admin();
    await h.decide(approvedOrder.o, 'approved', approver, '2032-07-24T10:20:00+08:00');
    await h.decide(rejectedOrder.o, 'rejected', approver, '2032-07-24T10:20:00+08:00');
    const decided = await h.allRows();
    await h.bumpCommissionVersion(approvedOrder.o, 2);
    await h.bumpCommissionVersion(rejectedOrder.o, 2);
    h.clock.set(SECOND_RUN);

    const result = await h.run();

    const rows = await h.allRows();
    for (const before of decided) {
      expect(rows.find((r) => r.id === before.id)).toEqual(before);
    }
    for (const { o, seq } of [approvedOrder, rejectedOrder]) {
      expect(ordered((await h.rowsOf(o)).filter((r) => r.commission_version === 2))).toEqual([
        beneficiaryRow(o, 'self', 33n, seq, 2),
        beneficiaryRow(o, 'direct', 7n, seq, 2),
        platformRow(26n, seq, 2),
      ]);
    }
    expect(result).toMatchObject({ orders: 2, candidates: 6, superseded: 0 });
    expect(await h.audits(SUPERSEDED_ACTION)).toEqual([]);
  },
  TIMEOUT,
);
