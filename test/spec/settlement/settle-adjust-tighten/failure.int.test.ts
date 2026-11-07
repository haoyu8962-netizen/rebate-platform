// B2-09zf rule tests (claude-independent, D10-828 ②; refs 08 BR-FUND-09 ②): one order's failure in
// the positive-difference run is not swallowed. The failing order keeps no row (its candidates
// commit or roll back together), the other orders are written as usual, and the run as a whole
// ends in failure — generator.run rejects, and on the worker path the settle_jobs row of
// job=settle_adjust is recorded `failed`, so the (app, platform, D) job is delivered again; once the
// fault is gone that delivery writes the missing order, the settle_jobs row reaches `done`, and the
// orders already written are not written twice.
// The fault is injected after PostgreSQL ran the failing order's candidate INSERT (a Kysely plugin
// on the executor), so the rows really existed before the error reached the generator. The failing
// order is the one with the smaller order_id: the run takes orders by order_id, so the healthy one
// always comes after the failure.
// Example (08 BR-FUND-09): reserve 0, self 5000 / direct 1000, credited at 1234 (617 / 123,
// platform 494), raised to 1300 (650 / 130 / 520): +33 / +7 / +26.
import { expect, it } from 'vitest';
import { harness as creditHarness, type SeededOrder } from '../credit/kit.ts';
import {
  EXAMPLE,
  TIMEOUT,
  adjustHarness,
  beneficiaryRow,
  createDatabase,
  databaseFixture,
  failAfter,
  ordered,
  platformRow,
  type CandidateRow,
} from '../settle-adjust-generate/harness.ts';
import {
  adjustBatches,
  adjustJob,
  candidateRows,
  jobRows,
  raiseSettlement,
  withAdjustWorker,
} from '../settle-adjust-generate/worker-harness.ts';

const p = databaseFixture(createDatabase);

const WORKER_TIMEOUT = 180_000;
const DAY = '2032-07-24';
const CANDIDATE_INSERT = /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?settle_adjustments"?/i;

/** The pair ordered by order_id: [first taken by the run, second]. */
function byOrderId<T extends { readonly o: SeededOrder }>(a: T, b: T): [T, T] {
  return a.o.orderId < b.o.orderId ? [a, b] : [b, a];
}

/** A matcher of the order's candidate INSERT. */
function candidateInsertOf(o: SeededOrder) {
  return (query: { readonly sql: string; readonly parameters: readonly unknown[] }) =>
    CANDIDATE_INSERT.test(query.sql) && query.parameters.some((value) => value === o.orderId);
}

type Brief = Pick<CandidateRow, 'order_id' | 'role' | 'diff_fen' | 'status' | 'settle_seq'>;

/** The (order, role, diff, status, seq) of the rows, in a stable order. */
function summary(rows: readonly Brief[]) {
  return rows
    .map((r) => [r.order_id, r.role ?? 'platform', r.diff_fen, r.status, r.settle_seq] as const)
    .sort((x, y) => `${x[0]}|${x[1]}`.localeCompare(`${y[0]}|${y[1]}`));
}

/** The example's three pending rows of the order at `seq`: +33 / +7 / +26. */
function expectedRows(o: SeededOrder, seq: number): Brief[] {
  return [
    { order_id: o.orderId, role: 'self', diff_fen: 33n, status: 'pending', settle_seq: seq },
    { order_id: o.orderId, role: 'direct', diff_fen: 7n, status: 'pending', settle_seq: seq },
    { order_id: o.orderId, role: null, diff_fen: 26n, status: 'pending', settle_seq: seq },
  ];
}

it(
  '[AC-B2-09zf#2] 生成器层：一次运行里先处理的那单写候选失败（注入故障）→ 该单不留任何行，后一单照常写出 +33 / +7 / +26，整次运行以失败结束（run 拒绝，而不是正常返回）；故障解除后再跑只补上失败的那单，已写的单不重复',
  async () => {
    const h = await adjustHarness(p.db);
    const [broken, healthy] = byOrderId(
      await h.raised(EXAMPLE, 1300n),
      await h.raised(EXAMPLE, 1300n),
    );
    const before = await h.state();
    const faulty = failAfter(p.db, candidateInsertOf(broken.o));

    const error = await h.run({ db: faulty.db }).then(
      (result) => expect.fail(`the run returned normally: ${JSON.stringify(result, toText)}`),
      (failure: unknown) => failure,
    );

    expect(faulty.injected()).toBeGreaterThanOrEqual(1);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toMatch(/NotImplemented/u);
    expect(await h.rowsOf(broken.o)).toEqual([]);
    expect(ordered(await h.rowsOf(healthy.o))).toEqual([
      beneficiaryRow(healthy.o, 'self', 33n, healthy.seq),
      beneficiaryRow(healthy.o, 'direct', 7n, healthy.seq),
      platformRow(26n, healthy.seq),
    ]);
    expect(await h.batches()).toHaveLength(1);
    await h.expectNoEmptyBatch();
    expect(await h.state()).toEqual(before);
    const written = await h.rowsOf(healthy.o);

    // The fault is gone: the next run writes the failed order only.
    const retry = await h.run();
    expect(retry).toMatchObject({ orders: 1, candidates: 3, superseded: 0 });
    expect(ordered(await h.rowsOf(broken.o))).toEqual([
      beneficiaryRow(broken.o, 'self', 33n, broken.seq),
      beneficiaryRow(broken.o, 'direct', 7n, broken.seq),
      platformRow(26n, broken.seq),
    ]);
    expect(await h.rowsOf(healthy.o)).toEqual(written);
    expect(await h.allRows()).toHaveLength(6);
    expect(await h.batches()).toHaveLength(2);
    await h.expectNoEmptyBatch();
    expect(await h.state()).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zf#2] worker 层：settle_adjust 投递里先处理的那单写候选失败 → 投递失败（handler 拒绝），settle_jobs 的 settle_adjust 那一行记 failed，后一单照常写出、失败单无行；故障解除后同一 (app, platform, D) 重投 → 补上失败单，同一行走到 done，已写的单不重复',
  async () => {
    const h = await creditHarness(p.db);
    const seed = async () => {
      const o = await h.order(EXAMPLE);
      expect(await h.credit(o)).toMatchObject({ outcome: 'credited' });
      const seq = await raiseSettlement(h, o, 1300n);
      return { o, seq };
    };
    const [broken, healthy] = byOrderId(await seed(), await seed());
    const faulty = failAfter(p.db, candidateInsertOf(broken.o));

    await withAdjustWorker(h, faulty.db, new Map(), async ({ handler }) => {
      await expect(handler(adjustJob(h.appId, 'taobao', DAY))).rejects.toThrow();
    });

    expect(faulty.injected()).toBeGreaterThanOrEqual(1);
    const failed = await jobRows(h, 'settle_adjust');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ platform: 'taobao', status: 'failed' });
    const afterFailure = await candidateRows(h);
    expect(summary(afterFailure)).toEqual(summary(expectedRows(healthy.o, healthy.seq)));
    expect(await adjustBatches(h)).toHaveLength(1);

    // The same (app, platform, D) delivered again without the fault.
    await withAdjustWorker(h, p.db, new Map(), async ({ handler }) => {
      await expect(handler(adjustJob(h.appId, 'taobao', DAY))).resolves.toBeUndefined();
    });

    const done = await jobRows(h, 'settle_adjust');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ id: failed[0]!.id, platform: 'taobao', status: 'done' });
    expect(done[0]!.finished_at).not.toBeNull();
    const rows = await candidateRows(h);
    expect(summary(rows)).toEqual(
      summary([...expectedRows(broken.o, broken.seq), ...expectedRows(healthy.o, healthy.seq)]),
    );
    // The healthy order's rows are the very rows of the failed delivery (not written again).
    const healthyIds = afterFailure.map((r) => r.id).sort();
    expect(
      rows
        .filter((r) => r.order_id === healthy.o.orderId)
        .map((r) => r.id)
        .sort(),
    ).toEqual(healthyIds);
    expect(await adjustBatches(h)).toHaveLength(2);
  },
  WORKER_TIMEOUT,
);

function toText(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
