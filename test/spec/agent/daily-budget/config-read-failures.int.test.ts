import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import { LEVEL, message, openSession, send, setConfig, usePgEach } from '../stream-mount/kit.ts';
import { dayRow, reservationRow } from './pg-kit.ts';
import {
  DAILY,
  MODELS,
  QUERY,
  RESERVE,
  answer,
  doneView,
  flashPrices,
  mountBudget,
} from './stream-kit.ts';

const pg = usePgEach(createTestDatabase);

it('[AC-B3-09m#44] 预占配置读失败时告警，按默认 5,000 mfen 预占并继续调用模型', async () => {
  const rig = await mountBudget(pg.db, { failConfigValuesByKey: RESERVE });
  const { caller } = rig;
  try {
    await setConfig(pg.db, caller.appId, DAILY, 100);
    await setConfig(pg.db, caller.appId, RESERVE, 2_000);
    await setConfig(pg.db, caller.appId, MODELS, flashPrices());
    const sessionId = await openSession(rig, caller);
    let pendingReservation: Awaited<ReturnType<typeof reservationRow>>;
    let pendingDay: Awaited<ReturnType<typeof dayRow>>;
    rig.transport.mockImplementationOnce(async () => {
      const { id } = await pg.db
        .selectFrom('agent_runs')
        .select('id')
        .where('session_id', '=', sessionId)
        .executeTakeFirstOrThrow();
      pendingReservation = await reservationRow(pg.db, id);
      pendingDay = await dayRow(pg.db);
      return answer();
    });

    const view = doneView(await send(rig, caller, sessionId, message(QUERY)), 'stop');
    expect(view.frames.map((frame) => frame.event)).not.toContain('error');
    expect(rig.transport).toHaveBeenCalledTimes(1);
    expect(pendingReservation).toMatchObject({ reserved_mfen: 5_000n, settled_at: null });
    expect(pendingDay).toMatchObject({ actual_mfen: 0n, reserved_mfen: 5_000n });
    expect(rig.logs.all()).toContainEqual(
      expect.objectContaining({ level: LEVEL.warn, config_key: RESERVE }),
    );
  } finally {
    await rig.runtime.close();
  }
}, 60_000);

it('[AC-B3-09m#45] 日预算配置读失败时按 budget 降级，既不调用模型也不预占', async () => {
  const rig = await mountBudget(pg.db, { failConfigValuesByKey: DAILY });
  const { caller } = rig;
  try {
    await setConfig(pg.db, caller.appId, DAILY, 100);
    await setConfig(pg.db, caller.appId, RESERVE, 5_000);
    await setConfig(pg.db, caller.appId, MODELS, flashPrices());
    const sessionId = await openSession(rig, caller);
    const view = doneView(await send(rig, caller, sessionId, message(QUERY)), 'budget');
    expect(view.frames.map((frame) => frame.event)).not.toContain('error');
    expect(rig.transport).not.toHaveBeenCalled();
    expect(await reservationRow(pg.db, view.runId)).toBeUndefined();
  } finally {
    await rig.runtime.close();
  }
}, 60_000);
