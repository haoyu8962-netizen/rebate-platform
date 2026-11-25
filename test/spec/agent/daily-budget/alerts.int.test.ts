import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import { message, openSession, send, setConfig, usePgEach } from '../stream-mount/kit.ts';
import { DAILY, MODELS, QUERY, RESERVE, doneView, flashPrices, mountBudget } from './stream-kit.ts';

const pg = usePgEach(createTestDatabase);

it('[AC-B3-09m#39] 流式装配首次预占达到日预算时打出 80% 和 100% 告警', async () => {
  const rig = await mountBudget(pg.db);
  const { caller } = rig;
  try {
    await setConfig(pg.db, caller.appId, DAILY, 5);
    await setConfig(pg.db, caller.appId, RESERVE, 5_000);
    await setConfig(pg.db, caller.appId, MODELS, flashPrices());
    const sessionId = await openSession(rig, caller);
    doneView(await send(rig, caller, sessionId, message(QUERY)), 'stop');

    const events = rig.logs.all().flatMap((line) => [line.msg, line['event']]);
    expect(events).toEqual(expect.arrayContaining(['agent.budget_80', 'agent.budget_100']));
  } finally {
    await rig.runtime.close();
  }
}, 60_000);
