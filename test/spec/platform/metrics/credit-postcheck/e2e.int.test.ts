// B2-02v end to end on PostgreSQL: a real credit booked a fen off, the real post-credit check
// (createCreditPostcheck.handle, B2-02t), the real close of the diff (closeAdminReconDiff, B2-09b),
// and the gauge rendered by the real registry over the real port. The stand-ins are B2-02t's kit:
// the job queue, the config port and the idempotency wrapper of the close (a plain transaction; the
// HTTP layer is pinned by test/spec/ledger/admin-recon-close). Tests of this file share one database
// and each uses apps of its own, so they read the sample of their app only.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Kysely, Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { closeAdminReconDiff } from '../../../../../apps/api/src/modules/ledger/application/admin-recon-diff-close.ts';
import { readCreditPostcheckOpen } from '../../../../../apps/api/src/modules/ledger/index.ts';
import { releaseWithdrawHoldsBySource } from '../../../../../apps/api/src/modules/payout/application/withdraw-holds.ts';
import type { Idempotency } from '../../../../../apps/api/src/modules/platform/index.ts';
import { createMetricsRegistry } from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { diffsOf, lastJob, r5Side, voucherIdOf } from '../../../ledger/credit-postcheck/kit.ts';
import { TIMEOUT, creditKey, databaseFixture } from '../../../settlement/credit/kit.ts';
import { REF_PREFIX, creditPostcheckGauge } from './postcheck-harness.ts';

const p = databaseFixture(createTestDatabase);

type R5Side = Awaited<ReturnType<typeof r5Side>>;

/** The gauge as one scrape of the worker's registry shows it. */
async function scrape(db: Kysely<DB>): Promise<Record<string, number>> {
  const registry = createMetricsRegistry({
    entry: 'worker',
    collectCreditPostcheck: () => readCreditPostcheckOpen(db),
  });
  return creditPostcheckGauge(await registry.render());
}

/** One order whose self voucher is booked a fen short, credited; its check job and voucher. */
async function mismatch({ h, side, credit, skew }: R5Side) {
  const order = await h.order();
  const key = creditKey(order, 'self');
  skew(key, -1n);
  await credit(order);
  return { job: lastJob(side), voucherId: await voucherIdOf(h, key) };
}

/** Closes the diff of a voucher through the admin close use case; the holds go with it. */
async function closeDiffOf({ h, side }: R5Side, voucherId: string): Promise<void> {
  const refId = `${REF_PREFIX}${voucherId}`;
  const diff = (await diffsOf(side)).find((row) => row.ref_id === refId);
  expect(diff, `the diff of ${voucherId}`).toBeDefined();

  const adminId = randomUUID();
  await h.db
    .insertInto('admin_users')
    .values({
      id: adminId,
      app_id: h.appId,
      login_name: `close_${adminId}`,
      password_hash: 'unused-test-login',
      is_super: false,
      status: 'active',
      password_must_change: false,
      totp_bound_at: h.clock.now(),
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
    })
    .execute();

  await closeAdminReconDiff(
    {
      db: p.db,
      clock: h.clock,
      idempotency: {
        executeInTransaction: (
          _request: unknown,
          handler: (trx: Transaction<DB>) => Promise<unknown>,
        ) => p.db.transaction().execute(handler),
      } as unknown as Idempotency,
      auditOn: () => ({ append: () => Promise.resolve() }),
      holds: {
        releaseBySource: (trx, input) =>
          releaseWithdrawHoldsBySource(side.withdrawHoldOptions, trx, input),
      },
    },
    { appId: h.appId, adminId, ip: null },
    diff!.id,
    { body: { reason: '已核实' }, key: `close-${adminId}`, traceId: randomUUID() },
  );
}

it(
  '[AC-B2-02v#23] 真实证实核对造一次不一致 → 指标 1；再来一张 → 2；重投同一任务不增加；后台关一张 → 回到 1；已关单的任务再投不把告警带回来',
  async () => {
    const side = await r5Side(p.db);
    const appId = side.h.appId;

    const first = await mismatch(side);
    await side.side.handle(first.job);
    expect((await scrape(p.db))[appId], 'one mismatch').toBe(1);

    const second = await mismatch(side);
    await side.side.handle(second.job);
    expect((await scrape(p.db))[appId], 'two mismatches').toBe(2);

    await side.side.handle(first.job);
    await side.side.handle(second.job);
    expect((await scrape(p.db))[appId], 'the same jobs delivered again').toBe(2);
    expect(await diffsOf(side.side), 'no second diff of a voucher').toHaveLength(2);

    await closeDiffOf(side, first.voucherId);
    expect((await scrape(p.db))[appId], 'one diff closed').toBe(1);

    await side.side.handle(first.job);
    expect((await scrape(p.db))[appId], 'the closed one delivered again').toBe(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02v#24] 多租户各算各的（两个 app 各有自己的凭证）：金额一致的 app 没有样本；一个 app 关单不影响另一个；全部关完样本消失',
  async () => {
    const consistent = await r5Side(p.db);
    const wrong = await r5Side(p.db);
    const other = await r5Side(p.db);

    await consistent.credit(await consistent.h.order());
    await consistent.side.handle(lastJob(consistent.side));

    const wrongDiff = await mismatch(wrong);
    await wrong.side.handle(wrongDiff.job);
    const otherDiff = await mismatch(other);
    await other.side.handle(otherDiff.job);

    const both = await scrape(p.db);
    expect(both[wrong.h.appId], 'the app with a mismatch').toBe(1);
    expect(both[other.h.appId], 'the other app with a mismatch').toBe(1);
    expect(Object.hasOwn(both, consistent.h.appId), 'a consistent app has no sample').toBe(false);

    await closeDiffOf(wrong, wrongDiff.voucherId);
    const closed = await scrape(p.db);
    expect(Object.hasOwn(closed, wrong.h.appId), 'no sample once its only diff is closed').toBe(
      false,
    );
    expect(closed[other.h.appId], "the other app's diff is untouched").toBe(1);
  },
  TIMEOUT,
);
