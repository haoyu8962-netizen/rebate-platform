// B2-02t rule test: the handler LedgerCreditPostcheckModule.forWorker really registers on queue
// `ledger-credit-postcheck` does the check. Real pieces: Nest's module build, PostgreSQL, the ledger, the
// R5 credit that wrote the wrong voucher, commission's readCommissionAttribution and payout's
// createWithdrawHolds. Synthetic: the queue, which records register() so the handler can be delivered
// the job R5 sent, as JSON (what a real queue hands over).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  LedgerCreditPostcheckModule,
  type CreditPostcheckAttributionReader,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { createWithdrawHolds } from '../../../../apps/api/src/modules/payout/application/withdraw-holds.ts';
import type { JobPayload } from '../../../../apps/api/src/modules/platform/index.ts';
import { TIMEOUT, creditKey, databaseFixture } from '../../settlement/credit/kit.ts';
import { fakeQueue, workerContext } from '../daily-check-schedule/kit.ts';
import {
  QUEUE,
  diffsOf,
  expectDiff,
  expectHold,
  expectOneAlert,
  expectQuiet,
  holdsOf,
  r5Side,
  voucherIdOf,
} from './kit.ts';

// Loaded at run time, as the kit does: the URL import keeps Nest decorators out of the test TS project.
const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as { readCommissionAttribution: CreditPostcheckAttributionReader };

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-02t#27] 模块装配：forWorker 实际注册到 ledger-credit-postcheck 的处理器，收到一张差一分的真实凭证，产生差错单、冻结和告警',
  async () => {
    const { h, side, credit, skew } = await r5Side(p.db);
    const o = await h.order();
    skew(creditKey(o, 'self'), -1n);
    await credit(o);
    expect(side.sends, 'the job of the credit').toHaveLength(1);
    await expectQuiet(side);

    const queue = fakeQueue();
    const context = await workerContext(
      LedgerCreditPostcheckModule.forWorker({
        holds: (clock) => createWithdrawHolds({ ...side.withdrawHoldOptions, clock }),
        readAttribution: commission.readCommissionAttribution,
      }),
      { clock: h.clock, logger: side.logger, db: p.db, queue },
    );
    try {
      expect(
        queue.registered.map((entry) => entry.queue),
        'one handler, on this queue only',
      ).toEqual([QUEUE]);

      const sent = side.sends[0]!;
      await queue.registered[0]!.handler({
        id: 'credit-postcheck-job',
        queue: sent.queue,
        name: sent.name,
        payload: JSON.parse(JSON.stringify(sent.payload)) as JobPayload,
        attempt: 1,
      });
    } finally {
      await context.close();
    }

    const diff = await expectDiff(side, {
      voucherId: await voucherIdOf(h, creditKey(o, 'self')),
      expectedFen: 425n,
      actualFen: 424n,
      orderKey: o.orderKey,
      userId: o.user('self'),
      role: 'self',
      baseFen: '850',
      ratioBp: '5000',
    });
    expect(await diffsOf(side), 'only the wrong voucher is registered').toHaveLength(1);
    const holds = await holdsOf(side);
    expect(holds, 'one hold, the wrong voucher’s user only').toHaveLength(1);
    expectHold(side, holds[0], diff.id, o.user('self'));
    expectOneAlert(
      side,
      o.people.map((person) => person.userId),
    );
  },
  TIMEOUT,
);
