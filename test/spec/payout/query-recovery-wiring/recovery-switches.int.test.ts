// B2-06i rule tests (规划/08 BR-WDR-14; B2-06e): recovery runs whatever the mode and the switches.
// A PAYING withdrawal must still finish under dry_run, and payout.enabled / payout.queue_paused stop
// new transfers, not the queries of transfers already made. The scan covers every app of the
// database, so these tests read per withdrawal and never compare counts.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PayoutModeDecision } from '../../../../apps/api/src/modules/payout/payout-mode.ts';
import { LIVE_CREDENTIALS } from '../entry/mode-kit.ts';
import {
  DAY,
  MINUTE,
  TIMEOUT,
  at,
  close,
  jobsOf,
  open,
  queryJobRow,
  setup,
  withdrawal,
  type Harness,
  type QueryFixture,
} from '../query/kit.ts';
import { payoutRuntime } from './runtime-int-kit.ts';
import { logged, settle, startedRecovery } from './support.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

/** One round under `decision`: the lost withdrawal gets its job, the late one needs_manual. */
async function expectRecovered(f: QueryFixture, decision: PayoutModeDecision): Promise<void> {
  const lost = await f.seedPaying(at(-7 * MINUTE));
  const late = await f.seedPaying(at(-(DAY + MINUTE)));
  const runtime = payoutRuntime(f);
  runtime.start(decision);

  const worker = startedRecovery(runtime);
  expect(await settle(worker.stop())).toEqual({ ok: true });

  expect(await jobsOf(f, lost.id)).toEqual([queryJobRow(lost, 2, 23 * 60)]);
  expect((await withdrawal(f, late.id)).needs_manual).toBe(true);
  expect(await jobsOf(f, late.id)).toEqual([]);
  expect(logged(f.logger.info, 'payout_query_recovery_scanned')).toHaveLength(1);
  expect(logged(f.logger.warn, 'payout_query_recovery_failed')).toEqual([]);
}

it('[AC-B2-06i#10] payout.enabled=off 且 queue_paused=true：仍补投查询任务、仍标 needs_manual', async () => {
  const f = await setup(h);
  await f.set('payout.enabled', false);
  await f.set('payout.queue_paused', true);
  await expectRecovered(f, { mode: 'dry_run' });
});

it('[AC-B2-06i#10] live 决定下恢复照样跑：只查库、发任务，日志不含私钥', async () => {
  const f = await setup(h);
  await expectRecovered(f, { mode: 'live', credentials: LIVE_CREDENTIALS });
  const lines = JSON.stringify([...f.logger.info.mock.calls, ...f.logger.warn.mock.calls]);
  expect(lines).not.toContain(LIVE_CREDENTIALS.privateKey);
});
