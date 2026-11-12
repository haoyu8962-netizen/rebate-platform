import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  createAgentHistoryHttp,
  decodeHistoryCursor,
  encodeHistoryCursor,
  type AgentHistoryDeps,
  type AgentHistoryReader,
} from './history.ts';
import type { AgentCaller, AgentHttpReply } from './index.ts';

const SESSION = '019a0000-0000-7000-8000-000000000001';
const MESSAGE = '019a0000-0000-7000-8000-000000000201';

const caller: AgentCaller = {
  appId: 'synthetic-app',
  traceId: 'trace-unit',
  deviceId: 'device-unit',
  deviceHash: 'hash-unit',
  ipKey: 'ip-unit',
  userId: 'user-unit',
  phoneBound: true,
};

function capture() {
  const calls: { status: number; body: Record<string, unknown> }[] = [];
  const reply: AgentHttpReply = {
    json: (status, _headers, body) => calls.push({ status, body: body as Record<string, unknown> }),
    stream: () => {
      throw new Error('no stream here');
    },
  };
  return { calls, reply };
}

function deps(over: Partial<AgentHistoryDeps> = {}) {
  const page = vi.fn<AgentHistoryReader['page']>(async () => ({
    items: [
      {
        messageId: MESSAGE,
        role: 'assistant' as const,
        createdAt: new FixedClock('2026-10-14T02:00:00Z').now(),
        text: null,
        cards: [
          {
            card_id: 'c1',
            type: 'earnings_summary',
            schema_version: 1,
            data: { as_of: '2026-10-14T10:00:00+08:00', actions: [], withdrawable_fen: 100 },
            fallback_text: '合成',
          },
        ],
        finishReason: 'stop',
      },
    ],
    nextCursor: MESSAGE,
  }));
  const value: AgentHistoryDeps = {
    access: { check: vi.fn(async () => null) },
    identity: { check: vi.fn(async () => null) },
    consent: { check: vi.fn(async () => null) },
    sessions: {
      owned: vi.fn(async () => ({
        session: {
          id: SESSION,
          startedAt: new FixedClock('2026-10-14T00:00:00Z').now(),
          lastActiveAt: new FixedClock('2026-10-14T00:00:00Z').now(),
        },
        expired: true,
      })),
    },
    messages: { page },
    texts: { errorMsg: (code) => `错误-${code}` },
    clock: new FixedClock('2026-10-15T00:00:00Z'),
    ...over,
  };
  return { value, page };
}

it('[AC-B3-08zc#6][BR-AI-23] 校验顺序 ①→④：先失败的先答，后面的端口不调用', async () => {
  const d = deps({
    access: { check: async () => ({ code: 30501 as const }) },
    identity: { check: vi.fn(async () => ({ code: 10001 as const })) },
  });
  const r = capture();
  await createAgentHistoryHttp(d.value).listMessages(caller, SESSION, {}, r.reply);
  expect(r.calls[0]?.body['code']).toBe(30501);
  expect(d.value.identity.check).not.toHaveBeenCalled();
  expect(d.page).not.toHaveBeenCalled();

  const consent = deps({ consent: { check: async () => ({ code: 10004 as const }) } });
  const c = capture();
  await createAgentHistoryHttp(consent.value).listMessages(caller, SESSION, {}, c.reply);
  expect(c.calls[0]?.body).toMatchObject({ code: 10004, data: { consent_type: 'ai_third_party' } });
  expect(consent.value.sessions.owned).not.toHaveBeenCalled();
});

it('[AC-B3-08zc#6][BR-AI-20] 非 UUID 与不归属一律 30504 无 data；过期会话仍 200、expired=true，收益卡不带金额', async () => {
  const missing = deps({ sessions: { owned: async () => null } });
  const m = capture();
  await createAgentHistoryHttp(missing.value).listMessages(caller, SESSION, {}, m.reply);
  expect(m.calls[0]?.body['code']).toBe(30504);
  expect(m.calls[0]?.body).not.toHaveProperty('data');

  const d = deps();
  const bad = capture();
  await createAgentHistoryHttp(d.value).listMessages(caller, 'not-a-uuid', {}, bad.reply);
  expect(bad.calls[0]?.body['code']).toBe(30504);
  expect(d.value.sessions.owned).not.toHaveBeenCalled();

  const ok = capture();
  await createAgentHistoryHttp(d.value).listMessages(caller, SESSION, undefined, ok.reply);
  expect(ok.calls[0]?.status).toBe(200);
  expect(ok.calls[0]?.body['data']).toEqual({
    items: [
      {
        message_id: MESSAGE,
        role: 'assistant',
        created_at: '2026-10-14T02:00:00.000Z',
        text: '',
        cards: [
          {
            card_id: 'c1',
            type: 'earnings_summary',
            schema_version: 1,
            data: { as_of: '2026-10-14T10:00:00+08:00', actions: [] },
            fallback_text: '合成',
          },
        ],
        finish_reason: 'stop',
      },
    ],
    next_cursor: encodeHistoryCursor(MESSAGE),
    expired: true,
  });
  expect(d.page).toHaveBeenCalledWith('synthetic-app', SESSION, { cursor: null, limit: 20 });
});

it('[AC-B3-08zc#6] 查询参数：limit 1..50（字符串数字可），cursor 只认自己发出的；不合法 20001 data.fields', async () => {
  const d = deps();
  const http = createAgentHistoryHttp(d.value);
  const good = capture();
  await http.listMessages(
    caller,
    SESSION,
    { limit: '50', cursor: encodeHistoryCursor(MESSAGE) },
    good.reply,
  );
  expect(good.calls[0]?.status).toBe(200);
  expect(d.page).toHaveBeenLastCalledWith('synthetic-app', SESSION, {
    cursor: MESSAGE,
    limit: 50,
  });
  const bad = capture();
  await http.listMessages(caller, SESSION, { limit: 51, cursor: 'zz' }, bad.reply);
  expect(bad.calls[0]?.body).toMatchObject({ code: 20001, data: { fields: ['limit', 'cursor'] } });
  expect(decodeHistoryCursor(encodeHistoryCursor('not-a-uuid'))).toBeNull();
});
