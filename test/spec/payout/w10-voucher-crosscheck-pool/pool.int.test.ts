// B2-09zd / BR-WDR-15 细则 / D10-782 (FU-B209X-POOL-TEST): W10 cross-check refusals under the
// production admin pool. The admin entry runs on its own pool of POOL_SIZES.admin.db connections
// (ADR-0001 §4.2 #11), the constant the entry itself takes; seeds and observations use the suite's
// separate handles. Real HTTP entry, auth, step-up, idempotency, PG, Redis and queue; no business
// mocks and no production-code edits. A burst that has not answered by its deadline is a hang: the
// pool's own sessions (found by application_name) are terminated so the case fails instead of
// hanging, and the assertion on the outcomes reports it.
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import type { ChannelBillLine } from '../../../../apps/api/src/modules/payout/domain/channel-result.ts';
import { POOL_SIZES } from '../../../../apps/api/src/modules/platform/db/index.ts';
import { expectQueued, jobs } from '../recon-late-paid/late-paid-harness.ts';
import {
  AFTER_FREEZE,
  answer,
  balanceOf,
  billLine,
  bills,
  candidate,
  entries,
  platformLine,
  query,
  refused,
  rowOf,
  serial,
  snapshot,
  state,
  suite,
  userLine,
  voucherOf,
  withLoggedUnknownAdmin,
  type AdminCaller,
  type AdminSent,
  type Candidate,
  type ReconFixture,
  type ReviewFixture,
  type UnknownAdmin,
} from '../w10-voucher-crosscheck/crosscheck-harness.ts';

const s = suite(true);

/** The admin entry's main pool, as production sizes it. */
const ADMIN_POOL = POOL_SIZES.admin.db;
/** Session name of the entry's pool in pg_stat_activity, so a hung burst can be cut loose. */
const POOL_APP_NAME = 'b2-09zb-admin-pool';
/** A burst of a few dozen small requests answers in seconds; this is the hang threshold. */
const BURST_DEADLINE_MS = 60_000;

type Reason =
  'resolve_order_id_other_order' | 'resolve_order_id_mismatch' | 'resolve_amount_mismatch';
const REASONS: readonly Reason[] = [
  'resolve_order_id_other_order',
  'resolve_order_id_mismatch',
  'resolve_amount_mismatch',
];

interface Planned {
  readonly c: Candidate;
  readonly who: AdminCaller;
  readonly stepUp: string;
  /** null: expected to succeed. */
  readonly reason: Reason | null;
}

type Outcome =
  | { readonly kind: 'answered'; readonly sent: AdminSent }
  | { readonly kind: 'threw'; readonly error: string }
  | { readonly kind: 'timeout' };

interface PoolControl {
  /** Terminates the sessions of the entry's pool (only after a burst missed its deadline). */
  cut(): Promise<void>;
  /** The entry pool's open sessions right now. */
  sessions(): Promise<number>;
}

/** Runs `run` with the admin entry on a pool of exactly ADMIN_POOL connections. */
async function withProductionPool(
  a: ReviewFixture,
  logs: string[],
  run: (h: UnknownAdmin, pool: PoolControl) => Promise<void>,
): Promise<void> {
  const pool: Kysely<DB> = createDb({
    connectionString: s.h().database.urlFor('couli_app'),
    max: ADMIN_POOL,
    applicationName: POOL_APP_NAME,
  });
  const control: PoolControl = {
    async cut() {
      await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE application_name = ${POOL_APP_NAME} AND datname = current_database()
          AND pid <> pg_backend_pid()`.execute(s.h().observer);
    },
    async sessions() {
      const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE application_name = ${POOL_APP_NAME} AND datname = current_database()`.execute(
        s.h().observer,
      );
      return rows[0]!.n;
    },
  };
  try {
    await withLoggedUnknownAdmin({ ...a, db: pool }, logs, (h) => run(h, control));
  } finally {
    await Promise.race([destroyDb(pool), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  }
}

/** Seeds one candidate per planned outcome and the evidence that makes each refusal. */
async function plan(
  f: ReconFixture,
  a: ReviewFixture,
  h: UnknownAdmin,
  perReason: number,
  successes: number,
): Promise<Planned[]> {
  const out: { c: Candidate; reason: Reason | null }[] = [];
  const lines: ChannelBillLine[] = [];
  for (const reason of REASONS) {
    for (let i = 0; i < perReason; i += 1) {
      const c = await candidate(a, h);
      if (reason === 'resolve_order_id_other_order') {
        // Another withdrawal's success bill line carries this request's serial number.
        const owner = await candidate(a, h);
        lines.push(billLine(owner.w, c.body.channel_order_id));
      } else if (reason === 'resolve_order_id_mismatch') {
        // The latest success query of this withdrawal answered another serial number.
        await query(a, c, serial());
      } else {
        // This withdrawal's success bill line agrees on the serial, one fen off on the amount.
        lines.push(billLine(c.w, c.body.channel_order_id, { amountFen: c.w.net_fen + 1n }));
      }
      out.push({ c, reason });
    }
  }
  for (let i = 0; i < successes; i += 1) {
    const c = await candidate(a, h);
    // Every other success carries agreeing query evidence, the rest none at all.
    if (i % 2 === 1) await query(a, c, c.body.channel_order_id);
    out.push({ c, reason: null });
  }
  if (lines.length > 0) await bills(f, lines);
  const planned: Planned[] = [];
  for (const { c, reason } of out) {
    const who = await h.caller(['payout.execute']);
    planned.push({ c, who, stepUp: await h.stepUp(who), reason });
  }
  return planned;
}

/** Sends every request at once; none may stay unanswered past the deadline. */
async function burst(
  h: UnknownAdmin,
  planned: readonly Planned[],
  pool: PoolControl,
): Promise<Outcome[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), BURST_DEADLINE_MS);
  });
  const started = planned.map((p) =>
    h.resolve(p.c.w.id, p.c.body, { caller: p.who, stepUp: p.stepUp }).then(
      (sent): Outcome => ({ kind: 'answered', sent }),
      (error: unknown): Outcome => ({ kind: 'threw', error: String(error) }),
    ),
  );
  const outcomes = await Promise.all(started.map((p) => Promise.race([p, deadline])));
  clearTimeout(timer);
  if (!outcomes.some((o) => o.kind === 'timeout')) {
    // The entry really ran on the production-sized pool: its sessions exist and never exceed it.
    const open = await pool.sessions();
    expect(open).toBeGreaterThan(0);
    expect(open).toBeLessThanOrEqual(ADMIN_POOL);
  } else {
    await pool.cut();
    await Promise.race([
      Promise.allSettled(started),
      new Promise((resolve) => setTimeout(resolve, 30_000)),
    ]);
  }
  return outcomes;
}

function answered(outcomes: readonly Outcome[]): AdminSent[] {
  expect(
    outcomes.map((o) => o.kind),
    'every W10 request of the burst answers (no pool starvation, no hang)',
  ).toEqual(outcomes.map(() => 'answered'));
  return outcomes.map((o) => (o.kind === 'answered' ? o.sent : (undefined as never)));
}

type Audit = Awaited<ReturnType<typeof state>>['audits'][number];

/** Exactly one refusal audit per refused request, by its operator, and none for anything else. */
function expectRefusalAudits(
  a: ReviewFixture,
  planned: readonly Planned[],
  appended: readonly Audit[],
): void {
  const refusals = planned.filter((p) => p.reason !== null);
  const recorded = appended.filter((r) => r.action === 'withdrawal_resolve_refused');
  expect(recorded).toHaveLength(refusals.length);
  for (const p of refusals) {
    const mine = recorded.filter((r) => r.target === p.c.w.id);
    expect(mine, `refusal audit of ${p.reason}`).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      app_id: a.appId,
      admin_id: p.who.id,
      target: p.c.w.id,
      action: 'withdrawal_resolve_refused',
      after: { withdrawal_id: p.c.w.id, reason: p.reason },
    });
    expect(
      appended.filter((r) => r.target === p.c.w.id && r.action === 'withdrawal_resolve'),
    ).toEqual([]);
  }
  for (const p of planned.filter((x) => x.reason === null)) {
    expect(recorded.filter((r) => r.target === p.c.w.id)).toEqual([]);
  }
}

async function expectAnswers(planned: readonly Planned[], sent: readonly AdminSent[]) {
  for (const [i, p] of planned.entries()) {
    if (p.reason === null) await answer(sent[i]!, 0);
    else
      await refused(
        sent[i]!,
        p.reason,
        p.reason === 'resolve_amount_mismatch' ? 'resolution' : 'channel_order_id',
      );
  }
}

it('[AC-B2-09zd#1] 生产池大小下并发拒绝打满admin池：全部按时回答、每笔恰一条拒绝审计、业务数据不变', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const logs: string[] = [];
  await withProductionPool(a, logs, async (h, pool) => {
    // More refusals of each kind than the pool has connections, all in flight together.
    const planned = await plan(f, a, h, ADMIN_POOL + 1, 0);
    expect(planned.length).toBeGreaterThan(ADMIN_POOL * 3);
    const before = await snapshot(f, a);
    const sent = answered(await burst(h, planned, pool));
    await expectAnswers(planned, sent);
    const after = await snapshot(f, a);
    // Business data, queue and recon evidence untouched; only refusal audits appended.
    expect({ ...after, state: { ...after.state, audits: [] } }).toEqual({
      ...before,
      state: { ...before.state, audits: [] },
    });
    const appended = after.state.audits.filter(
      (r) => !before.state.audits.some((b) => b.id === r.id),
    );
    expect(appended.every((r) => r.action === 'withdrawal_resolve_refused')).toBe(true);
    expectRefusalAudits(a, planned, appended);
  });
}, 300_000);

it('[AC-B2-09zd#2] 生产池大小下拒绝与成功混合并发：成功照常入账，拒绝各留一条审计且本单不变', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const logs: string[] = [];
  await withProductionPool(a, logs, async (h, pool) => {
    const planned = await plan(f, a, h, ADMIN_POOL, ADMIN_POOL);
    const refusals = planned.filter((p) => p.reason !== null);
    const successes = planned.filter((p) => p.reason === null);
    expect(new Set(refusals.map((p) => p.reason))).toEqual(new Set(REASONS));
    expect(successes).toHaveLength(ADMIN_POOL);
    const before = await state(a);
    const rowsBefore = new Map<string, unknown>();
    const balancesBefore = new Map<string, unknown>();
    for (const p of planned) {
      rowsBefore.set(p.c.w.id, await rowOf(a, p.c.w));
      balancesBefore.set(p.c.w.id, await balanceOf(a.db, a.ledger, a.appId, p.c.who.userId));
    }
    const sent = answered(await burst(h, planned, pool));
    await expectAnswers(planned, sent);
    const after = await state(a);
    const appended = after.audits.filter((r) => !before.audits.some((b) => b.id === r.id));
    expectRefusalAudits(a, planned, appended);
    const queued = await jobs(f);
    for (const p of refusals) {
      // The refused withdrawal, its member's balance and its books are as they were.
      expect(await rowOf(a, p.c.w)).toEqual(rowsBefore.get(p.c.w.id));
      expect(await balanceOf(a.db, a.ledger, a.appId, p.c.who.userId)).toEqual(
        balancesBefore.get(p.c.w.id),
      );
      const key = `wd:${p.c.w.id}:PAID`;
      expect(await voucherOf(a.db, a.appId, key)).toEqual([]);
      expect(await entries(a.db, a.appId, key)).toEqual([]);
      expect(queued.filter((j) => j.data.payload['withdrawal_id'] === p.c.w.id)).toEqual([]);
    }
    for (const p of successes) {
      expect(await rowOf(a, p.c.w)).toMatchObject({
        status: 'PAID_API',
        manual_resolution: 'paid',
        resolver_ids: [p.who.id],
        channel_order_id: p.c.body.channel_order_id,
        paid_at: new Date(p.c.body.paid_at),
        proof_file: p.c.body.proof_text,
      });
      const key = `wd:${p.c.w.id}:PAID`;
      expect(await voucherOf(a.db, a.appId, key)).toEqual([
        { uniq_key: key, biz_type: 'withdrawal', biz_id: p.c.w.id, operator: `admin:${p.who.id}` },
      ]);
      expect(await entries(a.db, a.appId, key)).toEqual([
        userLine(88n, 'TAX_WITHHOLD'),
        platformLine('TAX_PAYABLE', -88n, 'TAX_WITHHOLD'),
        userLine(125n, 'WITHDRAW_FEE'),
        platformLine('FEE_INCOME', -125n, 'WITHDRAW_FEE'),
        userLine(12_347n, 'WITHDRAW_PAID'),
        platformLine('CASH_ALIPAY', -12_347n, 'WITHDRAW_PAID'),
      ]);
      expect(await balanceOf(a.db, a.ledger, a.appId, p.c.who.userId)).toEqual({
        available_fen: AFTER_FREEZE,
        frozen_fen: 0n,
      });
      await expectQueued(f, p.c.w.id);
      const resolved = appended.filter(
        (r) => r.target === p.c.w.id && r.action === 'withdrawal_resolve',
      );
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({ admin_id: p.who.id, target: p.c.w.id });
    }
  });
}, 300_000);
