import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import { FLASH } from '../model-routing/kit.ts';
import { searchTools } from '../stream-model-prereq/kit.ts';
import {
  LEVEL,
  consent,
  fileText,
  message,
  newMember,
  openAgent,
  openSession,
  runRow,
  send,
  setConfig,
  until,
  usePgEach,
} from '../stream-mount/kit.ts';
import { booking, dayRow, reservationRow } from './pg-kit.ts';
import {
  ANSWER,
  DAILY,
  MODELS,
  QUERY,
  RESERVE,
  answer,
  doneView,
  flashPrices,
  mountBudget,
  price,
} from './stream-kit.ts';

const pg = usePgEach(createTestDatabase);
const OTHER_APP = 'synthetic-budget-app';

async function openOtherApp() {
  const caller = await newMember(pg.db, { appId: OTHER_APP });
  await openAgent(pg.db, caller.appId);
  await consent(pg.db, caller);
  return caller;
}

it('[AC-B3-09m#29] 全平台按最小预算和最大预占熔断新 run，之前受理的仍可完成', async () => {
  const hold = Promise.withResolvers<void>();
  const search = searchTools([{ kind: 'ok', cards: [], modelView: { result: '合成商品' } }]);
  let calls = 0;
  const rig = await mountBudget(pg.db, {
    tools: search.tools,
    answer: async () => {
      calls += 1;
      if (calls === 1) {
        await hold.promise;
        return answer(2_000, 300, true);
      }
      return answer(3_000, 200);
    },
  });
  let first: ReturnType<typeof send> | undefined;
  try {
    const other = await openOtherApp();
    const { caller } = rig;
    await setConfig(pg.db, caller.appId, DAILY, 50);
    await setConfig(pg.db, caller.appId, RESERVE, 5_000);
    await setConfig(pg.db, other.appId, DAILY, 5);
    await setConfig(pg.db, other.appId, RESERVE, 1_000);
    await setConfig(pg.db, caller.appId, MODELS, flashPrices());
    await setConfig(pg.db, other.appId, MODELS, flashPrices());
    const one = await openSession(rig, other);
    const two = await openSession(rig, caller);
    first = send(rig, other, one, message(QUERY));
    await until('first run reached the synthetic model', () => rig.transport.mock.calls.length > 0);
    expect(await dayRow(pg.db)).toMatchObject({ actual_mfen: 0n, reserved_mfen: 5_000n });

    const blocked = doneView(await send(rig, caller, two, message(QUERY)), 'budget');
    expect(rig.transport).toHaveBeenCalledTimes(1);
    expect(blocked.frames.some((frame) => frame.data['type'] === 'product_list')).toBe(true);
    expect(blocked.text).toContain(fileText('agent.degraded'));
    expect(await reservationRow(pg.db, blocked.runId)).toBeUndefined();
    expect(await runRow(pg.db, blocked.runId)).toMatchObject({ cost_mfen: null });
    hold.resolve();
    const finished = doneView(await first, 'stop');
    expect(rig.transport).toHaveBeenCalledTimes(2);
    expect(search.execute).toHaveBeenCalledTimes(1);
    expect(finished.text).toContain(ANSWER);
    expect(await runRow(pg.db, finished.runId)).toMatchObject({ cost_mfen: 700n });
    expect(await dayRow(pg.db)).toMatchObject({ actual_mfen: 700n, reserved_mfen: 0n });
  } finally {
    hold.resolve();
    await first;
    await rig.runtime.close();
  }
}, 60_000);

it('[AC-B3-09m#30] 任意 app 的预算设为 0 时，另一 app 也从首条开始熔断', async () => {
  const rig = await mountBudget(pg.db);
  try {
    const other = await openOtherApp();
    const { caller } = rig;
    await setConfig(pg.db, caller.appId, DAILY, 100);
    await setConfig(pg.db, other.appId, DAILY, 0);
    await setConfig(pg.db, caller.appId, MODELS, flashPrices());
    const session = await openSession(rig, caller);
    const view = doneView(await send(rig, caller, session, message(QUERY)), 'budget');
    expect(rig.transport).not.toHaveBeenCalled();
    expect(await reservationRow(pg.db, view.runId)).toBeUndefined();
  } finally {
    await rig.runtime.close();
  }
}, 60_000);

it.each(['missing', 'invalid'] as const)(
  '[AC-B3-09m#31] 其他 app 的预算键 %s 时，默认预算和默认预占也参与全平台选择',
  async (mode) => {
    const rig = await mountBudget(pg.db);
    try {
      const other = await openOtherApp();
      const { caller } = rig;
      await setConfig(pg.db, caller.appId, DAILY, 120_000);
      await setConfig(pg.db, caller.appId, RESERVE, 1_500);
      if (mode === 'invalid') {
        await setConfig(pg.db, other.appId, DAILY, 12.5);
        await setConfig(pg.db, other.appId, RESERVE, '9000');
      }
      await setConfig(pg.db, caller.appId, MODELS, flashPrices());
      const session = await openSession(rig, caller);
      const live = doneView(await send(rig, caller, session, message(QUERY)), 'stop');
      expect(await reservationRow(pg.db, live.runId)).toMatchObject({ reserved_mfen: 5_000n });
      if (mode === 'invalid') {
        const warnings = rig.logs.all().filter((line) => line.level >= LEVEL.warn);
        const logged = JSON.stringify(warnings);
        expect(logged).toContain('daily_budget_fen');
        expect(logged).toContain('reserve_mfen_per_run');
      }

      // 模拟当天另有一条已受理并占住剩余的全平台预算。
      const budget = booking(pg.db);
      expect(
        await budget.reserve({ budgetMfen: 100_000_000n, reserveMfen: 99_999_680n }),
      ).toMatchObject({ exhausted: false });
      expect(await dayRow(pg.db)).toMatchObject({
        actual_mfen: 320n,
        reserved_mfen: 99_999_680n,
      });
      const blocked = doneView(await send(rig, caller, session, message(QUERY)), 'budget');
      expect(rig.transport).toHaveBeenCalledTimes(1);
      expect(await reservationRow(pg.db, blocked.runId)).toBeUndefined();
    } finally {
      await rig.runtime.close();
    }
  },
  60_000,
);

it('[AC-B3-09m#32] 同一模型在两个 app 用各自的单价和版本，累加到同一日账', async () => {
  const rig = await mountBudget(pg.db);
  try {
    const { caller } = rig;
    const other = await openOtherApp();
    await setConfig(pg.db, caller.appId, MODELS, flashPrices('app-a-v1'));
    await setConfig(pg.db, other.appId, MODELS, { [FLASH]: price('app-b-v2', 200_000, 800_000) });
    const one = await openSession(rig, caller);
    const two = await openSession(rig, other);
    const a = doneView(await send(rig, caller, one, message(QUERY)), 'stop');
    const b = doneView(await send(rig, other, two, message(QUERY)), 'stop');
    expect(rig.transport.mock.calls.map(([request]) => request.model)).toEqual([FLASH, FLASH]);
    expect(await runRow(pg.db, a.runId)).toMatchObject({
      app_id: caller.appId,
      cost_mfen: 320n,
      price_version: 'app-a-v1',
    });
    expect(await runRow(pg.db, b.runId)).toMatchObject({
      app_id: other.appId,
      cost_mfen: 640n,
      price_version: 'app-b-v2',
    });
    expect(await dayRow(pg.db)).toMatchObject({ actual_mfen: 960n, reserved_mfen: 0n });
  } finally {
    await rig.runtime.close();
  }
}, 60_000);
