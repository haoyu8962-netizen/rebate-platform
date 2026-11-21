import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import * as trace from '../../../../apps/api/src/modules/agent/stream/mount/trace.ts';
import { ORDER_LOGIN, expectLogin } from '../previous-intent/kit.ts';
import { newGuest, openSession, usePgEach } from '../stream-mount/kit.ts';
import { cardTypesOf, finishOf, runIdOf } from '../trace-persist/kit.ts';
import { intent, runtimeRig, SPEC_TIMEOUT, storedRun } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

it.each([
  '订单返利规则是什么？别查我的订单',
  '别查我的订单',
  '不用查我的订单，返利规则是什么',
  '不是查我的订单',
  '我的订单返利规则是什么',
  '我的订单是怎么来的',
])(
  '[AC-B3-08ta#1] 游客说「%s」时保留规则意图，不出订单登录卡',
  async (question) => {
    const verdict = vi.spyOn(trace, 'recordIntentVerdict');
    const caller = await newGuest(pg.db);
    const x = await runtimeRig(pg.db, { caller, steps: [intent('rule_qa')] });
    try {
      const frames = await x.ask(await openSession(x.r, caller), question);
      const runId = runIdOf(frames);
      expect(cardTypesOf(frames)).not.toContain('auth_required');
      expect(finishOf(frames)).toBe('stop');
      expect(verdict).toHaveBeenCalledWith(
        x.appId,
        runId,
        expect.objectContaining({ intent: 'rule_qa' }),
      );
      expect(await storedRun(pg.db, x.appId, runId)).toMatchObject({
        intent: 'rule_qa',
        input_passed: true,
      });
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);

it.each(['查一下我的订单', '帮我查一下我的订单，谢谢'])(
  '[AC-B3-08ta#2] 游客说「%s」时服务端改判订单意图并出订单登录卡',
  async (question) => {
    const caller = await newGuest(pg.db);
    const x = await runtimeRig(pg.db, { caller, steps: [intent('rule_qa')] });
    try {
      const frames = await x.ask(await openSession(x.r, caller), question);
      expect(x.complete).toHaveBeenCalled();
      expectLogin(frames, ORDER_LOGIN);
      expect(await storedRun(pg.db, x.appId, runIdOf(frames))).toMatchObject({
        intent: 'order_query',
      });
    } finally {
      await x.r.runtime.close();
    }
  },
  SPEC_TIMEOUT,
);
