// B2-09l edge rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutBatch, 08 BR-WDR-18 ③ (Σ PAYING seen across concurrent EXECUTEs; 到达在 t_W 之后),
// 编排 D10-595 review r1 of the rule tests: two EXECUTEs on one channel cannot both spend the same W;
// an id sent in capitals is the same id, answered as it was sent, and counts as a duplicate of its
// lower-case form; a withdrawal paid exactly at t_W is not counted as paid after it.
//
// The interleaving of #77 is made without timing. A table lock from outside is not available here:
// LOCK TABLE needs a table-level UPDATE, DELETE or TRUNCATE for this mode, and couli_app holds only
// SELECT and INSERT on payout_batches, and column-level UPDATE on withdrawals. So the entry's database
// handle stops the first request right after its INSERT into payout_batches: past ③, holding what ③
// took, nothing committed, the withdrawal not yet moved. The second request is seen waiting on the
// first one's backend (pg_blocking_pids) before the first may go on. An EXECUTE that does not hold the
// channel across ③ finds nothing in the way, runs to its end while the first is stopped, and fails
// there. The real PostgreSQL executes every statement; the stop only delays the first one's next.
// Requests go through the real admin entry (batch-harness.ts). Top-level it() only (规划/11 §4.3).
import { PostgresQueryCompiler, sql, type KyselyPlugin, type QueryId } from 'kysely';
import { expect, it } from 'vitest';
import {
  ACTION,
  EXECUTE,
  MINUTE,
  PLENTY,
  W_JUST_ENOUGH,
  ago,
  approved,
  asPaying,
  audits,
  changes,
  expectExecuted,
  expectOnlyTrail,
  expectRejected,
  fieldsError,
  fixture,
  item,
  itemsOf,
  ofNet,
  payee,
  payoutJobs,
  rowOf,
  seedReview,
  seedW,
  suite,
  track,
  transferJob,
  withBatchAdmin,
  world,
  type ReviewFixture,
} from './batch-harness.ts';

const s = suite();

const BATCH_INSERT = /\binsert\s+into\s+(?:"?app"?\s*\.\s*)?"?payout_batches\b/i;

interface BatchInsertGate {
  readonly plugin: KyselyPlugin;
  /** True once a request stopped at the gate, false when `request` ended without reaching it. */
  stoppedBefore(request: Promise<unknown>): Promise<boolean>;
  /** Lets the stopped request go on. */
  open(): void;
}

/** One-shot: the first INSERT into payout_batches runs, then its caller waits for open(). */
function gateAfterBatchInsert(): BatchInsertGate {
  const compiler = new PostgresQueryCompiler();
  const reached = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<void>();
  let armed = true;
  let target: QueryId | null = null;
  return {
    plugin: {
      transformQuery({ node, queryId }) {
        if (armed && BATCH_INSERT.test(compiler.compileQuery(node, queryId).sql)) {
          armed = false;
          target = queryId;
        }
        return node;
      },
      async transformResult({ result, queryId }) {
        if (queryId === target) {
          target = null;
          reached.resolve();
          await opened.promise;
        }
        return result;
      },
    },
    stoppedBefore(request) {
      return Promise.race([reached.promise.then(() => true), request.then(() => false)]);
    },
    open() {
      opened.resolve();
    },
  };
}

/** The backend of the stopped request: inside its transaction, the batch INSERT its last statement. */
async function stoppedBackend(f: ReviewFixture): Promise<number> {
  const result = await sql<{ pid: number }>`
    SELECT pid FROM pg_stat_activity
    WHERE datname = current_database() AND state = 'idle in transaction'
      AND query ILIKE '%insert into%payout_batches%'`.execute(f.db);
  expect(result.rows, '恰有一个事务停在写批次之后').toHaveLength(1);
  return result.rows[0]!.pid;
}

/** Polls (bounded, no timing assumption) until a backend waits on `pid`; false if `request` ended. */
async function blockedBy(
  f: ReviewFixture,
  pid: number,
  request: { readonly settled: boolean },
): Promise<boolean> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const result = await sql<{ blocked: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE ${pid}::integer = ANY (pg_blocking_pids(pid))
      ) AS blocked`.execute(f.db);
    if (result.rows[0]?.blocked === true) return true;
    if (request.settled) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

it('[AC-B2-09l#77] 水位并发（BR-WDR-18 ③）：两个会员各一张同通道单 net 12,347，W=13,719（可用 12,347.1）、P=0，两个管理员各用各的键执行；第二个必须等第一个的事务，第一个提交后它的 ③ 才算到那 12,347 → 恰一张 PAYING，另一个 rejected watermark_usable_exceeded，恰一个任务，被拒那张仍 APPROVED', async () => {
  const f = fixture(s);
  const gate = gateAfterBatchInsert();
  await withBatchAdmin({ ...f, db: f.db.withPlugin(gate.plugin) }, async (h) => {
    const colleague = await h.caller([EXECUTE]);
    const who = await payee(f, h);
    const taken = await approved(f, h, who);
    const refused = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: W_JUST_ENOUGH });

    const first = track(h.execute([taken.id]));
    const secondMayStart = Promise.withResolvers<void>();
    const second = track(
      secondMayStart.promise.then(() => h.execute([refused.id], { caller: colleague })),
    );
    try {
      expect(await gate.stoppedBefore(first.promise), '第一个应停在 ③ 之后、提交之前').toBe(true);
      const firstBackend = await stoppedBackend(f);
      expect(await rowOf(f, taken), '第一个还没有提交').toEqual(taken);

      secondMayStart.resolve();
      expect(await blockedBy(f, firstBackend, second), '第二个应等第一个的事务').toBe(true);
      expect(first.settled).toBe(false);
      expect(second.settled).toBe(false);
    } finally {
      gate.open();
      await first.promise;
    }

    const batchId = await expectExecuted(await first.promise, { paying: [taken.id] });
    // Only the first one's committed 12,347 can make 13,719 too little: 24,694 > 12,347.1.
    await expectRejected(await second.promise, 'watermark_usable_exceeded', 'alipay');

    expect(await rowOf(f, taken)).toEqual(asPaying(f, taken, batchId, h.executor.id));
    expect(await rowOf(f, refused)).toEqual(refused);
    expect(await payoutJobs(f)).toEqual([transferJob(f, taken, 1)]);
    expect(await changes(f.db, f.appId)).toEqual([
      { withdrawal_id: taken.id, user_id: who.userId, status: 'PAYING' },
    ]);
    expect(await itemsOf(f)).toEqual([item(batchId, taken, 'paying')]);
    expect((await world(f)).batches).toHaveLength(1);
    expect(await audits(f, ACTION)).toHaveLength(2);
  });
});

it('[AC-B2-09l#78] 大写 id：一张 APPROVED 单的 id 转大写发送 → 进 PAYING，paying 回的是发送时的写法；库里、item、任务和事件用的是单据自己的 id', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    await seedW(f, { fen: PLENTY });
    const sent = w.id.toUpperCase();
    expect(sent).not.toBe(w.id);

    const batchId = await expectExecuted(await h.execute([sent]), { paying: [sent] });

    expect(await rowOf(f, w)).toEqual(asPaying(f, w, batchId, h.executor.id));
    expect(await itemsOf(f)).toEqual([item(batchId, w, 'paying')]);
    expect(await payoutJobs(f)).toEqual([transferJob(f, w, 1)]);
    expect(await changes(f.db, f.appId)).toEqual([
      { withdrawal_id: w.id, user_id: who.userId, status: 'PAYING' },
    ]);
  });
});

it('[AC-B2-09l#79] 同一 id 大小写各一份算重复：20001 data.fields=[withdrawal_ids]，两种顺序、夹着别的单都一样，什么都不写', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    const other = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: PLENTY });
    const upper = w.id.toUpperCase();
    expect(upper).not.toBe(w.id);
    const before = await world(f);

    await fieldsError(await h.execute([w.id, upper]), ['withdrawal_ids']);
    await fieldsError(await h.execute([upper, w.id]), ['withdrawal_ids']);
    await fieldsError(await h.execute([upper, other.id, w.id]), ['withdrawal_ids']);

    expect(await world(f)).toEqual(before);
  });
});

it('[AC-B2-09l#80] 到账恰好在 t_W 不计入已付（BR-WDR-18「t_W 之后」）：本批 12,347 + PAYING 7,013，到账 1,009；W=22,632（可用 20,368.8）：t_W 早 1 毫秒时计入，20,369 拒绝；t_W 等于 paid_at 时不计，19,360 通过', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const paidAt = ago(f, 4);
    await seedReview(f, h, who, { status: 'PAYING', execute_seq: 1, ...ofNet(7_013n) });
    await seedReview(f, h, who, {
      status: 'PAID_API',
      amount_fen: 1_009n,
      fee_fen: 0n,
      tax_fen: 0n,
      paid_at: paidAt,
    });
    const w = await approved(f, h, who);

    const earlier = await seedW(f, { fen: 22_632n, ageMs: 4 * MINUTE + 1 });
    expect(earlier).toBe(paidAt.getTime() - 1);
    const before = await world(f);
    await expectRejected(await h.execute([w.id]), 'watermark_usable_exceeded', 'alipay');
    expectOnlyTrail(before, await world(f));

    const exact = await seedW(f, { fen: 22_632n, ageMs: 4 * MINUTE });
    expect(exact).toBe(paidAt.getTime());
    const batchId = await expectExecuted(await h.execute([w.id]), { paying: [w.id] });
    expect(await rowOf(f, w)).toEqual(asPaying(f, w, batchId, h.executor.id));
  });
});
