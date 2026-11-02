// B2-06i rule test (规划/08 BR-WDR-14; 规划/12 §5.4): the whole chain from the real runtime to the
// database. stop() waits for the round in flight, so once it resolves the round's rows are committed
// and readable. The scan covers every app of the database: this file holds a single test so the
// logged counts are its own.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DAY,
  MINUTE,
  NEEDS_MANUAL_ALERT,
  TIMEOUT,
  at,
  close,
  expectNoPayeeInLogs,
  jobsOf,
  open,
  queryJobRow,
  setup,
  withdrawal,
  type Harness,
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

it('[AC-B2-06i#9] 真实运行体：start(dry_run) 再 startRecovery，查询任务丢失的 PAYING 单被补投，超过 24 小时的被标 needs_manual；stop 后不挂死', async () => {
  const f = await setup(h);
  const lost = await f.seedPaying(at(-7 * MINUTE));
  const late = await f.seedPaying(at(-(DAY + MINUTE)));
  const lateBefore = await withdrawal(f, late.id);
  const runtime = payoutRuntime(f);
  runtime.start({ mode: 'dry_run' });

  const worker = startedRecovery(runtime);
  expect(await settle(worker.stop())).toEqual({ ok: true });

  expect(await jobsOf(f, lost.id)).toEqual([queryJobRow(lost, 2, 23 * 60)]);
  expect(await jobsOf(f, late.id)).toEqual([]);
  expect(await withdrawal(f, late.id)).toEqual({
    ...lateBefore,
    needs_manual: true,
    row_version: lateBefore.row_version + 1,
    updated_at: expect.any(Date),
  });
  expect(logged(f.logger.info, 'payout_query_recovery_scanned')).toStrictEqual([
    { scanned: 2, enqueued: 1, manual: 1 },
  ]);
  expect(logged(f.logger.warn, 'payout_query_recovery_failed')).toEqual([]);
  expect(logged(f.logger.warn, NEEDS_MANUAL_ALERT)).toHaveLength(1);
  expectNoPayeeInLogs(f);

  expect(await settle(worker.stop())).toEqual({ ok: true });
});
