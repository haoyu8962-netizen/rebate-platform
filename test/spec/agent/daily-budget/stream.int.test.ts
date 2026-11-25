import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import { FLASH, PLUS } from '../model-routing/kit.ts';
import { LINK } from '../stream-assembly/kit.ts';
import { noticeCard, searchTools } from '../stream-model-prereq/kit.ts';
import {
  APP,
  message,
  openSession,
  runRow,
  send,
  setConfig,
  usePgEach,
} from '../stream-mount/kit.ts';
import { dayRow, reservationRow } from './pg-kit.ts';
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

it('[AC-B3-09m#24] 预算耗尽后链接与商品情境入口依旧按无需模型的路径结束', async () => {
  const rig = await mountBudget(pg.db);
  const { caller } = rig;
  try {
    await setConfig(pg.db, caller.appId, DAILY, 0);
    await setConfig(pg.db, caller.appId, MODELS, flashPrices());
    const sessionId = await openSession(rig, caller);
    const linkReply = await send(rig, caller, sessionId, message(`合成保温杯 ${LINK}`));
    const link = doneView(linkReply, 'stop');
    expect(rig.resolveLink).toHaveBeenCalledWith(
      LINK,
      expect.objectContaining({ appId: caller.appId, purpose: 'online' }),
    );
    expect(link.frames.some((frame) => frame.event === 'card')).toBe(true);

    const entry = doneView(
      await send(rig, caller, sessionId, {
        ...message(QUERY),
        context: { product_key: 'tb:synthetic-cup' },
      }),
      'stop',
    );
    expect(entry.frames.some((frame) => frame.data['type'] === 'rebate_quote')).toBe(true);
    expect(rig.transport).not.toHaveBeenCalled();
    expect(await runRow(pg.db, link.runId)).toMatchObject({ cost_mfen: null });
    expect(await runRow(pg.db, entry.runId)).toMatchObject({ cost_mfen: null });
  } finally {
    await rig.runtime.close();
  }
}, 60_000);

it('[AC-B3-09m#25] 第二轮请求放不下就不发，保留第一轮文本和工具卡并按 budget 收尾', async () => {
  const kept = '第一轮已出的合成卡';
  const search = searchTools([
    { kind: 'ok', cards: [noticeCard(kept)], modelView: { result: '合成'.repeat(12_000) } },
  ]);
  const rig = await mountBudget(pg.db, {
    tools: search.tools,
    answer: async () => answer(2_000, 300, true),
  });
  const { caller } = rig;
  try {
    await setConfig(pg.db, caller.appId, DAILY, 100);
    await setConfig(pg.db, caller.appId, RESERVE, 5_000);
    await setConfig(pg.db, caller.appId, MODELS, flashPrices());
    const sessionId = await openSession(rig, caller);
    const reply = await send(rig, caller, sessionId, message(QUERY));
    expect(search.execute).toHaveBeenCalledTimes(1);
    expect(rig.transport).toHaveBeenCalledTimes(1);
    const request = rig.transport.mock.calls[0]![0];
    const bytes = BigInt(Buffer.byteLength(JSON.stringify(request.body), 'utf8'));
    const worstInput = (bytes + 9n) / 10n;
    expect(request.body).toMatchObject({
      max_tokens: Number(((5_000n - worstInput) * 5n) / 2n),
    });
    const view = doneView(reply, 'budget');
    expect(view.text).toContain(ANSWER);
    expect(view.frames).toContainEqual(
      expect.objectContaining({
        event: 'card',
        data: expect.objectContaining({ type: 'notice', fallback_text: kept }),
      }),
    );
    expect(await runRow(pg.db, view.runId)).toMatchObject({
      cost_mfen: 320n,
      price_version: 'synthetic-v1',
    });
  } finally {
    await rig.runtime.close();
  }
}, 60_000);

it('[AC-B3-09m#26] 主模型缺单价时只调用有单价的备模型并记它的版本', async () => {
  const rig = await mountBudget(pg.db, { attempts: ['flash', 'plus'] });
  const { caller } = rig;
  try {
    await setConfig(pg.db, caller.appId, MODELS, {
      [FLASH]: price('invalid', 0),
      [PLUS]: price('plus-v1', 200_000, 600_000),
    });
    const sessionId = await openSession(rig, caller);
    const view = doneView(await send(rig, caller, sessionId, message(QUERY)), 'stop');
    expect(rig.transport.mock.calls.map(([request]) => request.model)).toEqual([PLUS]);
    expect(await runRow(pg.db, view.runId)).toMatchObject({
      cost_mfen: 580n,
      price_version: 'plus-v1',
    });
  } finally {
    await rig.runtime.close();
  }
}, 60_000);

it.each(['missing', 'read-fails'] as const)(
  '[AC-B3-09m#27] 模型单价不可用（%s）时无模型降级、发告警且成本为 null',
  async (mode) => {
    const rig = await mountBudget(pg.db, { failPriceRead: mode === 'read-fails' });
    const { caller } = rig;
    try {
      if (mode === 'read-fails') await setConfig(pg.db, caller.appId, MODELS, flashPrices());
      const sessionId = await openSession(rig, caller);
      const view = doneView(await send(rig, caller, sessionId, message(QUERY)), 'budget');
      expect(rig.transport).not.toHaveBeenCalled();
      expect(JSON.stringify(rig.logs.all())).toContain('agent.budget_price_missing');
      expect(await runRow(pg.db, view.runId)).toMatchObject({ cost_mfen: null });
      expect((await dayRow(pg.db))?.reserved_mfen ?? 0n).toBe(0n);
    } finally {
      await rig.runtime.close();
    }
  },
  60_000,
);

it('[AC-B3-09m#28] 同一 run 第二轮前改价，两个调用都按受理时的单价并且只记一个版本', async () => {
  const search = searchTools([{ kind: 'ok', cards: [], modelView: { result: '合成商品' } }]);
  let calls = 0;
  const rig = await mountBudget(pg.db, {
    tools: search.tools,
    answer: async () => {
      calls += 1;
      if (calls === 1) {
        await setConfig(pg.db, APP, MODELS, { [FLASH]: price('later-v2', 200_000, 800_000) });
        return answer(2_000, 300, true);
      }
      return answer(3_000, 200);
    },
  });
  try {
    await setConfig(pg.db, APP, MODELS, flashPrices());
    const sessionId = await openSession(rig, rig.caller);
    const view = doneView(await send(rig, rig.caller, sessionId, message(QUERY)), 'stop');
    expect(rig.transport).toHaveBeenCalledTimes(2);
    expect(await runRow(pg.db, view.runId)).toMatchObject({
      cost_mfen: 700n,
      price_version: 'synthetic-v1',
    });
    expect(await reservationRow(pg.db, view.runId)).toMatchObject({
      price_version: 'synthetic-v1',
      settled_at: expect.any(Date),
    });
    expect(await dayRow(pg.db)).toMatchObject({ actual_mfen: 700n, reserved_mfen: 0n });
    const next = doneView(await send(rig, rig.caller, sessionId, message(QUERY)), 'stop');
    expect(await runRow(pg.db, next.runId)).toMatchObject({
      cost_mfen: 760n,
      price_version: 'later-v2',
    });
  } finally {
    await rig.runtime.close();
  }
}, 60_000);

it('[AC-B3-09m#38] 有日预算和有效单价时，预占设为 0 仍让新 run 按 budget 降级', async () => {
  const rig = await mountBudget(pg.db);
  const { caller } = rig;
  try {
    await setConfig(pg.db, caller.appId, DAILY, 100);
    await setConfig(pg.db, caller.appId, RESERVE, 0);
    await setConfig(pg.db, caller.appId, MODELS, flashPrices());
    const sessionId = await openSession(rig, caller);
    const view = doneView(await send(rig, caller, sessionId, message(QUERY)), 'budget');
    expect(rig.transport).not.toHaveBeenCalled();
    expect(await reservationRow(pg.db, view.runId)).toBeUndefined();
    expect(await runRow(pg.db, view.runId)).toMatchObject({ cost_mfen: null });
  } finally {
    await rig.runtime.close();
  }
}, 60_000);
