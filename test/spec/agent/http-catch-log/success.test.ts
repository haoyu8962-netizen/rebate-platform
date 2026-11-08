// B3-08v rule tests (brief §9.3 3): success paths and ordinary refusals write no error line. Each
// test first makes one request of the operation fail (① access.check rejects, caught by the
// operation's fallback catch) so that the logger holds exactly that one line; the later successful
// or refused requests on the same instance must not add an error line.
import { expect, it } from 'vitest';

import {
  call,
  expectJsonError,
  expectOk,
  expectOneErrorLine,
  failure,
  flush,
  identifiersOf,
  messageBody,
  rig,
  RecordingLogger,
  type Operation,
  type Rig,
} from './kit.ts';
import { PORT_FAILURE } from './scenarios.ts';

/** One failed request of `op` (access.check rejects): exactly one error line afterwards. */
async function failFirst(r: Rig, op: Operation): Promise<void> {
  r.access.fail = failure(PORT_FAILURE);
  const body = messageBody();
  const reply = await call(r, op, body);
  expectJsonError(reply, r.caller, 50001);
  expectOneErrorLine(r.log!, {
    op,
    errorName: PORT_FAILURE,
    forbidden: identifiersOf(r.caller, op === 'send_message' ? body.client_msg_id : undefined),
  });
  r.access.fail = undefined;
}

/** Still exactly the one error line of failFirst (warn lines, e.g. of the cancel signal, aside). */
function expectStillOneError(r: Rig, op: Operation): void {
  const errors = r.log!.errors();
  expect(errors, 'no further error line').toHaveLength(1);
  const only = new RecordingLogger();
  only.entries.push(...errors);
  expectOneErrorLine(only, { op, errorName: PORT_FAILURE, forbidden: identifiersOf(r.caller) });
}

it('[B3-08v#5] createSession 成功（200）不记 error', async () => {
  const r = rig();
  await failFirst(r, 'create_session');
  const body = expectOk(await call(r, 'create_session'), r.caller);
  expect(body['data']).toHaveProperty('session_id');
  expectStillOneError(r, 'create_session');
});

it('[B3-08v#5] currentSession 成功（200，有会话）不记 error', async () => {
  const r = rig();
  await failFirst(r, 'current_session');
  const body = expectOk(await call(r, 'current_session'), r.caller);
  expect(body['data']).toHaveProperty('session.session_id', r.sessionId);
  expectStillOneError(r, 'current_session');
});

it('[B3-08v#5] cancelRun 受理（200，信号照发）不记 error', async () => {
  const r = rig();
  await failFirst(r, 'cancel_run');
  const body = expectOk(await call(r, 'cancel_run'), r.caller);
  expect(body['data']).toStrictEqual({});
  await flush();
  expect(r.signals.calls).toEqual([r.runId]);
  expectStillOneError(r, 'cancel_run');
});

it('[B3-08v#5] cancelRun 受理后 Redis 信号失败：仍是 200，不记 error（可选的 warn 不在此列）', async () => {
  const r = rig();
  await failFirst(r, 'cancel_run');
  r.signals.mode = 'reject';
  const body = expectOk(await call(r, 'cancel_run'), r.caller);
  expect(body['data']).toStrictEqual({});
  await flush();
  expect(r.signals.calls).toEqual([r.runId]);
  expectStillOneError(r, 'cancel_run');
});

it('[B3-08v#5] sendMessage 受理并流式结束（SSE，无 JSON）不记 error', async () => {
  const r = rig();
  await failFirst(r, 'send_message');
  const reply = await call(r, 'send_message');
  expect(reply.jsons).toEqual([]);
  expect(reply.streams).toHaveLength(1);
  expect(reply.chunks.length).toBeGreaterThan(0);
  expect(reply.ended).toBe(1);
  expect(r.runs.starts).toHaveLength(1);
  expectStillOneError(r, 'send_message');
});

it('[B3-08v#6] 普通拒绝不记 error：会话不归属 30504、超长 20001、run 不归属 30505、取消 not_running 30505、受理拒绝 30506、重复消息两帧', async () => {
  const r = rig();
  await failFirst(r, 'create_session');

  const foreign = { ...r, sessionId: '019a0000-0000-7000-8b30-ffffffffffff' };
  expectJsonError(await call(foreign, 'send_message'), r.caller, 30504);

  const long = await call(r, 'send_message', {
    client_msg_id: messageBody().client_msg_id,
    text: 'x'.repeat(501),
  });
  expect(long.jsons).toHaveLength(1);
  expect(long.jsons[0]!.body['code']).toBe(20001);

  const notMine = { ...r, runId: '019a0000-0000-7000-8b30-fffffffffffe' };
  expectJsonError(await call(notMine, 'cancel_run'), r.caller, 30505);

  r.cancel.answer = 'not_running';
  expectJsonError(await call(r, 'cancel_run'), r.caller, 30505);

  r.admission.answer = () => ({ kind: 'rejected', code: 30506 });
  expectJsonError(await call(r, 'send_message'), r.caller, 30506);

  r.admission.answer = () => ({
    kind: 'duplicate',
    original: {
      runId: r.runId,
      userMessageId: '019a0000-0000-7000-8b30-fffffffffffd',
      assistantMessageId: '019a0000-0000-7000-8b30-fffffffffffc',
      promptVersion: 'agent-prompt@b308v',
      modelSnapshot: 'snap-b308v',
    },
    reply: { kind: 'running' },
  });
  const duplicate = await call(r, 'send_message');
  expect(duplicate.jsons).toEqual([]);
  expect(duplicate.chunks).toHaveLength(2);

  expectStillOneError(r, 'create_session');
});
