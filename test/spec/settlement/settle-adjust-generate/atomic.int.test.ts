// B2-09zb rule tests (claude-independent, SPEC_REF 18f0015): each order's candidates commit or roll
// back together (task §9: 同单所有行在同一事务); a failure in one order leaves none of its rows and
// does not stop the other orders; the batch only holds the orders that succeeded (never an empty
// batch). The fault is injected after PostgreSQL ran the order's candidate INSERT (a Kysely plugin on
// the generator's executor), so the rows really existed before the error reached the generator.
import { expect, it } from 'vitest';
import {
  EXAMPLE,
  SUPERSEDED_ACTION,
  TIMEOUT,
  adjustHarness,
  beneficiaryRow,
  createDatabase,
  databaseFixture,
  failAfter,
  ordered,
  platformRow,
} from './harness.ts';

const p = databaseFixture(createDatabase);

const CANDIDATE_INSERT = /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?settle_adjustments"?/i;

it(
  '[AC-B2-09zb#8] 一单写到一半失败（注入故障）：该单的行全不留，另一单照常生成；批次只有成功的单；故障解除后再跑补上失败的单',
  async () => {
    const h = await adjustHarness(p.db);
    const broken = await h.raised(EXAMPLE, 1300n);
    const healthy = await h.raised(EXAMPLE, 1300n);
    const before = await h.state();
    const faulty = failAfter(
      p.db,
      (query) =>
        CANDIDATE_INSERT.test(query.sql) &&
        query.parameters.some((value) => value === broken.o.orderId),
    );

    // The run either reports the failed order (resolves) or rethrows after the others; both are
    // allowed. What it leaves behind is the rule.
    const outcome = await h.run({ db: faulty.db }).then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({ result: null, error }),
    );

    expect(faulty.injected()).toBeGreaterThanOrEqual(1);
    expect(String(outcome.error ?? '')).not.toMatch(/NotImplemented/u);
    expect(await h.rowsOf(broken.o)).toEqual([]);
    expect(ordered(await h.rowsOf(healthy.o))).toEqual([
      beneficiaryRow(healthy.o, 'self', 33n, healthy.seq),
      beneficiaryRow(healthy.o, 'direct', 7n, healthy.seq),
      platformRow(26n, healthy.seq),
    ]);
    const batches = await h.batches();
    expect(batches).toHaveLength(1);
    const rows = await h.allRows();
    expect(rows.every((r) => r.batch_id === batches[0]!.batch_id)).toBe(true);
    expect(rows.every((r) => r.order_id === healthy.o.orderId)).toBe(true);
    if (outcome.result !== null) {
      expect(outcome.result).toMatchObject({
        batchId: batches[0]!.batch_id,
        orders: 1,
        candidates: 3,
      });
    }
    expect(await h.state()).toEqual(before);

    // Without the fault the next run writes the failed order, in a new batch of its own.
    const retry = await h.run();
    expect(retry).toMatchObject({ orders: 1, candidates: 3, superseded: 0 });
    expect(ordered(await h.rowsOf(broken.o))).toEqual([
      beneficiaryRow(broken.o, 'self', 33n, broken.seq),
      beneficiaryRow(broken.o, 'direct', 7n, broken.seq),
      platformRow(26n, broken.seq),
    ]);
    expect(await h.batches()).toHaveLength(2);
    await h.expectNoEmptyBatch();
  },
  TIMEOUT,
);

// B1-18g (08 BR-FUND-09 细则「正差批准的默认」⑤; D10-1258 / D10-1259): the superseding audit only
// exists when the differences changed. A version bump alone keeps them (the difference is B_settle
// with the snapshot's fixed ratios less the nets), so the changed case bans the self beneficiary with
// the bump (BR-CALC-09: direct +7, platform +59).
const AUDIT_INSERT = /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?audit_logs"?/i;

it(
  '[AC-B2-09zb#8] [AC-B1-18g#5] 写换候选审计失败：换版本而差额不变时根本不写该审计（注入不触发、运行不报错、行不变）；换版本且差额变了时注入同一审计写失败——运行报错，该单的旧行不作废、新行不写（同一事务回滚），审计也不留；故障解除后再跑照常作废并重建',
  async () => {
    const h = await adjustHarness(p.db);
    const { o, seq } = await h.raised(EXAMPLE, 1300n);
    await h.run();
    const old = await h.allRows();

    // Differences unchanged: the audit write is never reached.
    await h.bumpCommissionVersion(o, 2);
    const quiet = failAfter(p.db, (query) => AUDIT_INSERT.test(query.sql));
    const unchanged = await h.run({ db: quiet.db }).then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({ result: null, error }),
    );
    expect(String(unchanged.error ?? '')).not.toMatch(/NotImplemented/u);
    expect(quiet.injected()).toBe(0);
    expect(unchanged).toEqual({
      result: { batchId: null, orders: 0, candidates: 0, superseded: 0 },
      error: null,
    });
    expect(await h.allRows()).toEqual(old);
    expect(await h.batches()).toHaveLength(1);
    expect(await h.audits()).toEqual([]);

    // Differences changed: the failed audit write rolls the order back.
    await h.risk(o.user('self'), 'banned');
    await h.bumpCommissionVersion(o, 3);
    const faulty = failAfter(p.db, (query) => AUDIT_INSERT.test(query.sql));

    const outcome = await h.run({ db: faulty.db }).then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({ result: null, error }),
    );

    expect(faulty.injected()).toBeGreaterThanOrEqual(1);
    expect(String(outcome.error ?? '')).not.toMatch(/NotImplemented/u);
    expect(outcome.error).not.toBeNull();
    expect(await h.allRows()).toEqual(old);
    expect(await h.batches()).toHaveLength(1);
    expect(await h.audits()).toEqual([]);

    // Without the fault the next run supersedes the old rows and writes the new ones.
    expect(await h.run()).toMatchObject({ orders: 1, candidates: 2, superseded: 3 });
    const rows = await h.allRows();
    for (const before of old) {
      expect(rows.find((r) => r.id === before.id)?.status, before.id).toBe('voided_stale_seq');
    }
    expect(ordered(rows.filter((r) => r.status === 'pending'))).toEqual([
      beneficiaryRow(o, 'direct', 7n, seq, 3),
      platformRow(59n, seq, 3),
    ]);
    expect(await h.audits(SUPERSEDED_ACTION)).toHaveLength(1);
    await h.expectNoEmptyBatch();
  },
  TIMEOUT,
);
