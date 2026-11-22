import type { Schema } from '@couli/contracts-ts';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { setConfig, usePgEach } from '../../agent/stream-mount/kit.ts';
import {
  READ,
  WRITE,
  member,
  openStream,
  refused,
  type Fixture,
  type Response,
} from '../deletion-guard-stream/kit.ts';
import { deletion } from '../deletion-guard/kit.ts';
import { MIN_KEY, consent, privacyError } from '../privacy-min-version/kit.ts';

const pg = usePgEach(createTestDatabase);

async function outdatedMember(stream: Fixture) {
  const caller = await member(stream);
  await setConfig(stream.db, caller.appId, MIN_KEY, 3);
  await consent(stream.db, caller.appId, caller.uid, { version: 2 });
  return caller;
}

function expectPrivacyRefusal(response: Response) {
  const { status, response: envelope } = privacyError('');
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toEqual({ ...envelope, trace_id: expect.any(String) });
}

it('[AC-B3-08zi#9] stream 先判封禁和注销冷静期，再判隐私最低版本', async () => {
  const stream = await openStream(pg.db);
  try {
    const cooling = await outdatedMember(stream);
    await deletion(pg.db, cooling.appId, cooling.uid, 'cooling');
    refused(await cooling.send('POST', WRITE), 'cooling');

    const banned = await outdatedMember(stream);
    await pg.db
      .withSchema('app')
      .insertInto('user_risk_state')
      .values({
        app_id: banned.appId,
        user_id: banned.uid,
        state: 'banned',
        reason: 'synthetic ban',
        reason_category: 'other',
        changed_by: 'B3-08zi',
        changed_at: stream.clock.now(),
      })
      .execute();
    const bannedResponse = await banned.send('POST', WRITE);
    expect(bannedResponse.statusCode, bannedResponse.body).toBe(403);
    expect(bannedResponse.json()['code']).toBe(10006);

    // 同一入口没有封禁或注销时，确认低版本确实触发了第 ⑦ 段。
    const unrestricted = await outdatedMember(stream);
    expectPrivacyRefusal(await unrestricted.send('POST', WRITE));
  } finally {
    await stream.app.close();
  }
}, 120_000);

const SYNTHETIC_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
const SESSION_MESSAGES = `/v1/agent/sessions/${SYNTHETIC_ID}/messages`;
const routes = [
  { method: 'POST', path: WRITE, payload: undefined },
  { method: 'GET', path: READ, payload: undefined },
  {
    method: 'POST',
    path: SESSION_MESSAGES,
    payload: {
      client_msg_id: 'client_msg_01',
      text: '如何查看订单',
    } satisfies Schema<'AgentMessageRequest'>,
  },
  { method: 'GET', path: SESSION_MESSAGES, payload: undefined },
  { method: 'POST', path: `/v1/agent/runs/${SYNTHETIC_ID}/cancel`, payload: undefined },
  {
    method: 'POST',
    path: `/v1/agent/messages/${SYNTHETIC_ID}/feedback`,
    payload: { feedback: 'up' } satisfies Schema<'AgentFeedbackRequest'>,
  },
  {
    method: 'POST',
    path: `/v1/agent/messages/${SYNTHETIC_ID}/report`,
    payload: { reason: '回复与问题无关' } satisfies Schema<'AgentReportRequest'>,
  },
] as const;

it.each(routes)(
  '[AC-B3-08zi#10] 真实 stream 入口 $method $path 返回隐私版本拒绝信封',
  async ({ method, path, payload }) => {
    const stream = await openStream(pg.db);
    try {
      // member 负责登录和请求头，此处给需要正文的路由补上契约正文。
      const caller = await outdatedMember({
        ...stream,
        app: {
          ...stream.app,
          inject(input) {
            const options = payload === undefined ? input : { ...input, payload };
            return stream.app.inject(options);
          },
        },
      });
      expectPrivacyRefusal(await caller.send(method, path));
    } finally {
      await stream.app.close();
    }
  },
  120_000,
);
