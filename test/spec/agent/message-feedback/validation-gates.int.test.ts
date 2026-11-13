import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  guestClient,
  memberClient,
  pastSwitchCache,
  type Sent,
} from '../session-history-http/kit.ts';
import {
  agentSnapshot,
  consent,
  newGuest,
  newMember,
  setConfig,
  usePgEach,
} from '../stream-mount/kit.ts';
import { actions, answer, url, validBody, withHttp } from './kit.ts';

const pg = usePgEach(createTestDatabase);

it.each(actions)(
  '[AC-B3-08zf#9] %s 缺字段、非法值及多余字段为 20001，拒绝后消息不变',
  async (action) => {
    await withHttp(pg.db, 'member', async (f) => {
      const bodies =
        action === 'feedback'
          ? [{}, { feedback: 'none' }, { feedback: null }, { feedback: 'up', extra: true }]
          : [{}, { reason: '' }, { reason: '字'.repeat(201) }, { reason: '有误', extra: true }];
      for (const body of bodies) {
        const before = await agentSnapshot(f.db);
        await answer(
          action,
          await f.call('POST', url(action, f.messages.assistantId), body),
          20001,
        );
        expect(await agentSnapshot(f.db)).toBe(before);
      }
      // Reaching a real successful write also distinguishes schema rejection from an unmounted route.
      await answer(
        action,
        await f.call('POST', url(action, f.messages.assistantId), validBody[action]),
      );
    });
  },
  120_000,
);

it.each(actions)(
  '[AC-B3-08zf#10] %s 设备头必填；低版本 10405 先于 AI 未开放 30501；解除限制后所有者成功',
  async (action) => {
    await withHttp(pg.db, 'guest', async (f) => {
      await sql`INSERT INTO app.app_versions
        (id, app_id, platform, channel, latest_version, min_supported_version,
         update_title, update_notes, store_url, default_store, store_listings)
        VALUES (${randomUUID()}, ${f.owner.appId}, 'ios', 'appstore', '2.0.0', '2.0.0',
          'test', 'test', 'https://example.invalid/app', 'appstore', '[]'::jsonb)
        ON CONFLICT (app_id, platform, channel) DO UPDATE
          SET min_supported_version = EXCLUDED.min_supported_version`.execute(f.db);
      const headers = {
        'x-app-id': f.owner.appId,
        'x-platform': 'ios',
        'x-channel': 'appstore',
        'x-app-version': '2.0.0',
        'content-type': 'application/json',
      };
      const send = async (extra: Record<string, string>): Promise<Sent> => {
        const traceId = randomUUID();
        const response = await f.app.inject({
          method: 'POST',
          url: url(action, f.messages.assistantId),
          headers: { ...headers, ...extra, 'x-trace-id': traceId },
          payload: JSON.stringify(validBody[action]),
        });
        return { response, traceId };
      };
      const before = await agentSnapshot(f.db);
      await answer(action, await send({}), 20001);
      await setConfig(f.db, f.owner.appId, 'agent.enabled', false);
      pastSwitchCache(f.clock);
      const low = await answer(
        action,
        await send({
          'x-device-id': f.owner.deviceId,
          'x-app-version': '1.9.9',
        }),
        10405,
      );
      expect(low['data']).toEqual({ min_supported_version: '2.0.0' });
      await answer(
        action,
        await f.call('POST', url(action, f.messages.assistantId), validBody[action]),
        30501,
      );
      expect(await agentSnapshot(f.db)).toBe(before);
      await setConfig(f.db, f.owner.appId, 'agent.enabled', true);
      pastSwitchCache(f.clock);
      await answer(
        action,
        await f.call('POST', url(action, f.messages.assistantId), validBody[action]),
      );
    });
  },
  120_000,
);

it.each(['guest', 'unbound_member'] as const)(
  '[AC-B3-08zf#11] 举报闸门顺序：%s 的 30501 → 10001/10005 → 10004 → 30504；所有者可成功',
  async (who) => {
    await withHttp(pg.db, 'member', async (f) => {
      const caller =
        who === 'guest' ? await newGuest(f.db) : await newMember(f.db, { phoneBound: false });
      const call =
        who === 'guest'
          ? guestClient(f.app, caller)
          : await memberClient(f.app, f.db, f.clock, caller);
      await setConfig(f.db, f.owner.appId, 'agent.enabled', false);
      await setConfig(f.db, f.owner.appId, 'agent.require_phone', true);
      pastSwitchCache(f.clock);
      const before = await agentSnapshot(f.db);
      const post = () => call('POST', url('report', f.messages.assistantId), validBody.report);
      await answer('report', await post(), 30501);
      await setConfig(f.db, f.owner.appId, 'agent.enabled', true);
      pastSwitchCache(f.clock);
      await answer('report', await post(), who === 'guest' ? 10001 : 10005);
      await setConfig(f.db, f.owner.appId, 'agent.require_phone', false);
      pastSwitchCache(f.clock);
      const refused = await answer('report', await post(), 10004);
      expect(refused['data']).toEqual({ consent_type: 'ai_third_party' });
      await consent(f.db, caller);
      await answer('report', await post(), 30504);
      expect(await agentSnapshot(f.db)).toBe(before);
      await answer(
        'report',
        await f.call('POST', url('report', f.messages.assistantId), validBody.report),
      );
    });
  },
  120_000,
);
