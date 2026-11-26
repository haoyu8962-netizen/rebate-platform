import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import { instance } from '../stream-finalize/kit.ts';
import { runRow, usePgEach } from '../stream-recovery/kit.ts';
import { at, leftover } from '../stream-sweeper/kit.ts';
import { booking, dayRow, NEXT_DAY, reservationRow } from './pg-kit.ts';

const pg = usePgEach(createTestDatabase);

it('[AC-B3-09m#37] 别处接手跨日的遗留 run 时将预占和版本结清到原 run，重做不重记', async () => {
  const budget = booking(pg.db);
  const acceptedAt = new Date('2026-10-06T23:59:50+08:00');
  const { runId, lockMs } = await leftover(pg.db, acceptedAt.getTime());
  expect(await budget.reserve({ runId, acceptedAt })).toMatchObject({ exhausted: false });

  const worker = instance(pg.pool(), { clock: at(lockMs + 1_000) });
  expect(await worker.ports.finalizer.finalize(runId)).toMatchObject({
    kind: 'final',
    wrote: true,
  });
  expect(await runRow(pg.db, runId)).toMatchObject({
    cost_mfen: 5_000n,
    price_version: 'synthetic-v1',
  });
  expect(await reservationRow(pg.db, runId)).toMatchObject({ settled_at: expect.any(Date) });
  expect(await worker.ports.finalizer.finalize(runId)).toMatchObject({
    kind: 'final',
    wrote: false,
  });
  expect(await dayRow(pg.db)).toMatchObject({ actual_mfen: 5_000n, reserved_mfen: 0n });
  expect((await dayRow(pg.db, NEXT_DAY))?.actual_mfen ?? 0n).toBe(0n);
}, 60_000);
