// B2-04zzc (编排 D10-805 ②): the worker entry's production assembly carries the invite trigger port
// (a forgotten wiring would fail silently: credits would simply never trigger, the B2-04zn lesson).
// The module is not built (the forWorker call is captured); the port is only constructed over a
// database handle that is never connected.
import { createDb, destroyDb } from '@couli/db';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { captureLogger, productionTrigger } from './kit.ts';

it('[AC-B2-04zzc#2] 生产组装带了触发端口：app.module 在 worker 入口交给 SettlementModule.forWorker 的 inviteRewardTrigger 是函数，用 worker 的句柄构造出带 onCredited 的触发器（构造时不连库）', async () => {
  const factory = await productionTrigger();
  expect(typeof factory, 'the worker assembly has no inviteRewardTrigger port').toBe('function');
  const db = createDb({ connectionString: 'postgres://unused@127.0.0.1:9/unused', max: 1 });
  try {
    const trigger = factory?.({
      db,
      clock: new FixedClock('2032-07-24T10:00:00+08:00'),
      logger: captureLogger().logger,
    });
    expect(typeof trigger?.onCredited).toBe('function');
  } finally {
    await destroyDb(db);
  }
});
