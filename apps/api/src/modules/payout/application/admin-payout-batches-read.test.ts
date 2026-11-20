// Unit test of the pure parts of the batch reads (B2-07g): memberNextQueryAt and the refusals made
// before any statement. The reads over the real admin entry and database are the rule tests
// (test/spec/payout/admin-payout-batches-read). No database: the handle here throws when touched.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  AdminPayoutBatchFieldsError,
  getAdminPayoutBatch,
  listAdminPayoutBatches,
  memberNextQueryAt,
  type AdminPayoutBatchesReadDeps,
  type MemberQueryFacts,
} from './admin-payout-batches-read.ts';
import { defaultPayoutChannelConfig } from './judgement.ts';

const MINUTE = 60_000;
const T = new FixedClock(new Date('2026-11-03T02:00:00.000Z')).now();
const SCHEDULE = defaultPayoutChannelConfig().querySchedule;

function after(ms: number): Date {
  const at = structuredClone(T);
  at.setTime(T.getTime() + ms);
  return at;
}

function facts(overrides: Partial<MemberQueryFacts> = {}): MemberQueryFacts {
  return {
    status: 'PAYING',
    needsManual: false,
    channelState: null,
    firstTransferAt: T,
    ...overrides,
  };
}

function untouchedDeps(): AdminPayoutBatchesReadDeps {
  const fail = (): never => {
    throw new Error('the database must not be touched');
  };
  return {
    db: { transaction: fail, withSchema: fail } as unknown as Kysely<DB>,
    clock: new FixedClock(T),
    config: { configValue: fail },
    logger: { warn: fail },
  };
}

it('[AC-B2-07g-UNIT#1] memberNextQueryAt: T + the first default point after now, capped at T + 24 h', () => {
  const due = (elapsed: number) =>
    memberNextQueryAt(SCHEDULE, facts(), after(elapsed))!.getTime() - T.getTime();
  expect([due(0), due(MINUTE), due(11 * MINUTE), due(121 * MINUTE), due(30 * 60 * MINUTE)]).toEqual(
    [MINUTE, 5 * MINUTE, 30 * MINUTE, 240 * MINUTE, 24 * 60 * MINUTE],
  );
});

it('[AC-B2-07g-UNIT#2] memberNextQueryAt: null when not PAYING, needs_manual, no transfer or a WeChat confirmation stage; processing counts', () => {
  const now = after(3 * MINUTE);
  expect([
    memberNextQueryAt(SCHEDULE, facts({ status: 'APPROVED' }), now),
    memberNextQueryAt(SCHEDULE, facts({ needsManual: true }), now),
    memberNextQueryAt(SCHEDULE, facts({ firstTransferAt: null }), now),
    memberNextQueryAt(SCHEDULE, facts({ channelState: 'wait_user_confirm' }), now),
    memberNextQueryAt(SCHEDULE, facts({ channelState: 'canceling' }), now),
    memberNextQueryAt(SCHEDULE, facts({ channelState: 'processing' }), now)?.toISOString(),
  ]).toEqual([null, null, null, null, null, after(5 * MINUTE).toISOString()]);
});

it('[AC-B2-07g-UNIT#3] the list refuses a bound that is no instant or created_from later than created_to before reading', async () => {
  const deps = untouchedDeps();
  const fieldsOf = async (range: { createdFrom?: string; createdTo?: string }) => {
    try {
      await listAdminPayoutBatches(deps, 'app-1', { page: 1, pageSize: 20, ...range });
    } catch (error: unknown) {
      return error instanceof AdminPayoutBatchFieldsError ? error.fields : error;
    }
    return 'not refused';
  };
  expect([
    await fieldsOf({ createdFrom: 'yesterday' }),
    await fieldsOf({ createdTo: 'soon' }),
    await fieldsOf({
      createdFrom: '2026-11-03T10:00:00.001+08:00',
      createdTo: '2026-11-03T02:00:00Z',
    }),
  ]).toEqual([['created_from'], ['created_to'], ['created_from', 'created_to']]);
});

it('[AC-B2-07g-UNIT#4] the detail answers null for a batch_id that is no uuid without reading', async () => {
  expect(await getAdminPayoutBatch(untouchedDeps(), 'app-1', 'not-a-batch-id')).toBeNull();
});
