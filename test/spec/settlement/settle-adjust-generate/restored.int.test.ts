// B2-09zb rule test (claude-independent, SPEC_REF 18f0015; review r1 S2): a forfeited share restored on
// appeal takes adjustments again (08 BR-CALC-09: status=forfeited 的受益人新应得恒为 0，不生成任何调整（经申诉
// 恢复的除外，BR-CALC-13）; D10-481 ②: the latest event by event_seq decides, an active event after a
// forfeited one lifts it). Both events are written by commission's own writer (appendBeneficiaryEvent,
// commission's public entry; status active + reason null is the B2-09g appeal restore).
// Example: 1234 (617 / 123 / 494, reserve 0) → 1300 (650 / 130 / 520): +33 / +7 / +26.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import type { Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  EXAMPLE,
  TIMEOUT,
  adjustHarness,
  beneficiaryRow,
  createDatabase,
  databaseFixture,
  ordered,
  platformRow,
} from './harness.ts';

const p = databaseFixture(createDatabase);

interface ShareEventInput {
  readonly appId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly role: 'self' | 'share' | 'direct' | 'indirect';
  readonly status: 'active' | 'held' | 'forfeited';
  readonly reason: 'banned' | 'deleted' | 'minor' | null;
}

interface CommissionEvents {
  appendBeneficiaryEvent(
    trx: Transaction<DB>,
    input: ShareEventInput,
    deps: { readonly clock: Clock },
  ): Promise<void>;
}

// Loaded at run time: commission's entry carries Nest decorators the rule-test project does not check.
const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as CommissionEvents;

it(
  '[AC-B2-09zb#4] forfeited 后经申诉恢复（最新事件为 active）：结算上调 1234 → 1300，self +33 照常写，直推 +7、平台 +26',
  async () => {
    const h = await adjustHarness(p.db);
    const o = await h.credited(EXAMPLE);
    const share = {
      appId: h.appId,
      orderId: o.orderId,
      userId: o.user('self'),
      role: 'self' as const,
    };
    await p.db
      .transaction()
      .execute((trx) =>
        commission.appendBeneficiaryEvent(
          trx,
          { ...share, status: 'forfeited', reason: 'banned' },
          { clock: h.clock },
        ),
      );
    h.clock.advanceMs(5 * 60_000);
    await p.db
      .transaction()
      .execute((trx) =>
        commission.appendBeneficiaryEvent(
          trx,
          { ...share, status: 'active', reason: null },
          { clock: h.clock },
        ),
      );
    h.clock.advanceMs(5 * 60_000);
    const seq = await h.settle(o, 1300n);
    // The seeded state: self's latest event is the restore, its net is the credited 617.
    const selfEvents = (await h.newBeneficiaryEvents(o)).filter(
      (e) => e.user_id === o.user('self') && e.role === 'self',
    );
    expect(selfEvents.map((e) => e.status)).toEqual(['forfeited', 'active']);
    expect(await h.netOf(o, 'self')).toBe(617n);
    const before = await h.state();

    await h.run();

    expect(ordered(await h.rowsOf(o))).toEqual([
      beneficiaryRow(o, 'self', 33n, seq),
      beneficiaryRow(o, 'direct', 7n, seq),
      platformRow(26n, seq),
    ]);
    expect(await h.state()).toEqual(before);
  },
  TIMEOUT,
);
