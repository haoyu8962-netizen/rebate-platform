// B2-02t rule test: closing the recon diff the check registered releases its withdrawal hold, through
// the existing close use case (closeAdminReconDiff, B2-09b) and payout's releaseWithdrawHoldsBySource.
// The admin HTTP layer of that close is pinned by test/spec/ledger/admin-recon-close; here the
// idempotency wrapper is a plain transaction.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { closeAdminReconDiff } from '../../../../apps/api/src/modules/ledger/application/admin-recon-diff-close.ts';
import { releaseWithdrawHoldsBySource } from '../../../../apps/api/src/modules/payout/application/withdraw-holds.ts';
import type { Idempotency } from '../../../../apps/api/src/modules/platform/index.ts';
import { TIMEOUT, creditKey, databaseFixture } from '../../settlement/credit/kit.ts';
import { diffsOf, holdsOf, lastJob, r5Side } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-02t#11] 关闭差错单解除这条冻结：released_at 写入，差错单 closed',
  async () => {
    const { h, side, credit, skew } = await r5Side(p.db);
    const o = await h.order();
    skew(creditKey(o, 'self'), -1n);
    await credit(o);
    await side.handle(lastJob(side));
    const [diff] = await diffsOf(side);
    expect(diff, 'the registered diff').toBeDefined();
    expect(await holdsOf(side)).toHaveLength(1);

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
    h.clock.advanceMs(60_000);

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

    const [closed] = await diffsOf(side);
    expect(closed).toMatchObject({ id: diff!.id, status: 'closed', handler_id: adminId });
    const [hold] = await holdsOf(side);
    expect(hold).toMatchObject({
      source_ref: `recon_diff:${diff!.id}`,
      released_at: h.clock.now(),
      released_by: adminId,
    });
  },
  TIMEOUT,
);
