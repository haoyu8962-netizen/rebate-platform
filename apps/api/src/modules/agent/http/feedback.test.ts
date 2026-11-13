import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  createAgentMessageFeedbackHttp,
  parseFeedbackBody,
  parseReportBody,
  type AgentMessageFeedbackDeps,
} from './feedback.ts';
import type { AgentCaller, AgentHttpReply } from './index.ts';

const MESSAGE = '019a0000-0000-7000-8000-000000000201';

const member: AgentCaller = {
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

function deps(over: Partial<AgentMessageFeedbackDeps> = {}) {
  const feedback = vi.fn<AgentMessageFeedbackDeps['store']['feedback']>(async () => true);
  const report = vi.fn<AgentMessageFeedbackDeps['store']['report']>(async () => true);
  const error = vi.fn();
  const value: AgentMessageFeedbackDeps = {
    access: { check: vi.fn(async () => null) },
    identity: { check: vi.fn(async () => null) },
    consent: { check: vi.fn(async () => null) },
    store: { feedback, report },
    texts: { errorMsg: (code) => `错误-${code}` },
    clock: new FixedClock('2026-10-15T00:00:00Z'),
    logger: { error, warn: vi.fn() },
    ...over,
  };
  return { value, feedback, report, error };
}

it('[AC-B3-08zf#9] 请求体只认契约字段：取值、长度（按码点）与多余字段', () => {
  expect(parseFeedbackBody({ feedback: 'up' })).toEqual({ ok: true, value: 'up' });
  expect(parseFeedbackBody({ feedback: 'down' })).toEqual({ ok: true, value: 'down' });
  expect(parseFeedbackBody({})).toEqual({ ok: false, fields: ['feedback'] });
  expect(parseFeedbackBody({ feedback: null })).toEqual({ ok: false, fields: ['feedback'] });
  expect(parseFeedbackBody({ feedback: 'up', x: 1 })).toEqual({ ok: false, fields: ['x'] });
  expect(parseFeedbackBody(['up'])).toEqual({ ok: false, fields: ['body'] });
  expect(parseFeedbackBody(undefined)).toEqual({ ok: false, fields: ['body'] });
  expect(parseReportBody({ reason: '😀'.repeat(200) })).toEqual({
    ok: true,
    value: '😀'.repeat(200),
  });
  expect(parseReportBody({ reason: '' })).toEqual({ ok: false, fields: ['reason'] });
  expect(parseReportBody({ reason: '字'.repeat(201) })).toEqual({ ok: false, fields: ['reason'] });
  expect(parseReportBody({ reason: 1 })).toEqual({ ok: false, fields: ['reason'] });
  expect(parseReportBody({ extra: true })).toEqual({ ok: false, fields: ['reason', 'extra'] });
});

it('[AC-B3-08zf#11][BR-AI-23] 坏请求体 20001 先答；闸门 ①→③ 先失败的先答，不写库', async () => {
  const a = deps();
  const bad = capture();
  await createAgentMessageFeedbackHttp(a.value).setFeedback(member, MESSAGE, {}, bad.reply);
  expect(bad.calls).toEqual([
    {
      status: 400,
      body: {
        code: 20001,
        msg: '错误-20001',
        trace_id: 'trace-unit',
        data: { fields: ['feedback'] },
      },
    },
  ]);
  expect(a.value.access.check).not.toHaveBeenCalled();

  for (const [gate, code, data] of [
    ['access', 30501, undefined],
    ['identity', 10001, undefined],
    ['consent', 10004, { consent_type: 'ai_third_party' }],
  ] as const) {
    const d = deps({ [gate]: { check: vi.fn(async () => ({ code })) } });
    const out = capture();
    await createAgentMessageFeedbackHttp(d.value).report(
      member,
      MESSAGE,
      { reason: '有误' },
      out.reply,
    );
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]!.body).toEqual({
      code,
      msg: `错误-${code}`,
      trace_id: 'trace-unit',
      ...(data === undefined ? {} : { data }),
    });
    expect(d.report).not.toHaveBeenCalled();
  }
});

it('[AC-B3-08zf#5][BR-AI-20] 写库未命中为 30504 不带 data；命中为 EmptyResponse，时刻取注入时钟', async () => {
  const d = deps();
  d.feedback.mockResolvedValueOnce(false);
  const http = createAgentMessageFeedbackHttp(d.value);
  const refused = capture();
  await http.setFeedback(member, 'not-a-uuid', { feedback: 'down' }, refused.reply);
  expect(refused.calls).toEqual([
    { status: 422, body: { code: 30504, msg: '错误-30504', trace_id: 'trace-unit' } },
  ]);
  const ok = capture();
  await http.report(member, MESSAGE, { reason: '有误' }, ok.reply);
  expect(ok.calls).toEqual([
    { status: 200, body: { code: 0, msg: '', data: {}, trace_id: 'trace-unit' } },
  ]);
  expect(d.report).toHaveBeenCalledWith(
    { kind: 'user', appId: 'synthetic-app', userId: 'user-unit', deviceId: 'device-unit' },
    MESSAGE,
    '有误',
    new FixedClock('2026-10-15T00:00:00Z').now(),
  );
  const guest = { ...member, userId: null, phoneBound: false };
  await http.setFeedback(guest, MESSAGE, { feedback: 'up' }, capture().reply);
  expect(d.feedback).toHaveBeenLastCalledWith(
    { kind: 'device', appId: 'synthetic-app', deviceId: 'device-unit' },
    MESSAGE,
    'up',
    new FixedClock('2026-10-15T00:00:00Z').now(),
  );
});

it('[AC-B3-08zf#2] 存储失败为 50001，并记一行 agent_http_failed（只含操作与错误名）', async () => {
  const d = deps();
  d.report.mockRejectedValueOnce(new TypeError('boom 用户原文'));
  const out = capture();
  await createAgentMessageFeedbackHttp(d.value).report(
    member,
    MESSAGE,
    { reason: '有误' },
    out.reply,
  );
  expect(out.calls).toEqual([
    { status: 500, body: { code: 50001, msg: '错误-50001', trace_id: 'trace-unit' } },
  ]);
  expect(d.error).toHaveBeenCalledWith(
    { op: 'report_message', stage: 'write', error_name: 'TypeError' },
    'agent_http_failed',
  );
});
