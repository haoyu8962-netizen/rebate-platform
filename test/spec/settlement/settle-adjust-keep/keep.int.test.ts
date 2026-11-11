// B1-18gk rule test (claude-independent, D10-1263; 06_FUND BR-FUND-09 细则「正差批准的默认」⑤ as
// narrowed by SPEC_REF 25a07f858b57; D10-770, D10-780): the candidate run voids and rebuilds an
// order's pending candidates only when its commission_version moved on. With the same seq and the
// same version, a beneficiary whose state changed since the candidates were written (here: banned)
// does not make the run write anything — the existing rows stay exactly as they are and the
// approval re-judges the state order by order (approve.ts, D10-770 ②).
// Built on the B2-09zb harness (../settle-adjust-generate/harness.ts): real credit service, real
// generator, admin's real system audit writer. Example: 1234 (617 / 123 / 494) → 1300: +33 / +7 / +26.
import { expect, it } from 'vitest';
import {
  EXAMPLE,
  SUPERSEDED_ACTION,
  TIMEOUT,
  adjustHarness,
  beneficiaryRow,
  createDatabase,
  databaseFixture,
  ordered,
  platformRow,
} from '../settle-adjust-generate/harness.ts';

const p = databaseFixture(createDatabase);

const SECOND_RUN = '2032-07-24T11:00:00+08:00';

it(
  '[AC-B1-18gk#1] 同 seq 同版本、本人在生成后被封禁再跑：原三行（本人 +33、直推 +7、平台 +26）原样保留（仍 pending、金额与 decided 字段不变），不新增行、不写 settle_adjust_candidate_superseded 审计、不建新批次',
  async () => {
    const h = await adjustHarness(p.db);
    const { o, seq } = await h.raised(EXAMPLE, 1300n);
    const first = await h.run();
    expect(first).toMatchObject({ orders: 1, candidates: 3, superseded: 0 });
    expect(first.batchId).not.toBeNull();
    const rowsBefore = await h.rowsOf(o);
    expect(ordered(rowsBefore)).toEqual([
      beneficiaryRow(o, 'self', 33n, seq),
      beneficiaryRow(o, 'direct', 7n, seq),
      platformRow(26n, seq),
    ]);
    const batchesBefore = await h.batches();
    expect(batchesBefore).toHaveLength(1);
    const versionBefore = (await h.read(o)).commission_version;
    const seqBefore = await h.currentSeq(o);

    // The state changes; neither the commission_version nor the seq does.
    await h.risk(o.user('self'), 'banned');
    h.clock.set(SECOND_RUN);
    const second = await h.run();

    expect((await h.read(o)).commission_version).toBe(versionBefore);
    expect(await h.currentSeq(o)).toBe(seqBefore);
    expect(second).toEqual({ batchId: null, orders: 0, candidates: 0, superseded: 0 });
    const rowsAfter = await h.rowsOf(o);
    expect(rowsAfter).toHaveLength(3);
    expect(rowsAfter).toEqual(rowsBefore);
    for (const row of rowsAfter) {
      expect(row, row.id).toMatchObject({
        status: 'pending',
        decided_at: null,
        approver: null,
        reason: null,
        batch_id: first.batchId,
      });
    }
    expect(await h.allRows()).toEqual(rowsBefore);
    expect(await h.audits(SUPERSEDED_ACTION)).toEqual([]);
    expect(await h.batches()).toEqual(batchesBefore);
  },
  TIMEOUT,
);
