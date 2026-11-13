// B3-08zf: real PG and stream HTTP; synthetic rows, no model or external adapter involved.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type { Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import { at, compile, contract, operation } from '../../contracts/agent-history/kit.ts';
import { httpStatusOf } from '../stream-http/kit.ts';
import {
  guestClient,
  json,
  memberClient,
  startClock,
  streamApp,
  type Client,
  type Sent,
  type StreamApp,
} from '../session-history-http/kit.ts';
import { consent, newGuest, newMember, openAgent } from '../stream-mount/kit.ts';

export type Action = 'feedback' | 'report';
export const actions = ['feedback', 'report'] as const;
export const validBody = { feedback: { feedback: 'down' }, report: { reason: '内容有误，请核查' } };
export const template = (action: Action): string => `/v1/agent/messages/{message_id}/${action}`;
export const url = (action: Action, id: string): string => `/v1/agent/messages/${id}/${action}`;

/** Both roles share a real session and run; the second assistant is an untouched control row. */
export async function seedMessages(db: Kysely<DB>, clock: Clock, owner: AgentCaller) {
  const sessionId = randomUUID();
  const runId = randomUUID();
  const assistantId = randomUUID();
  const userId = randomUUID();
  const controlId = randomUUID();
  await db
    .insertInto('agent_sessions')
    .values({
      id: sessionId,
      app_id: owner.appId,
      user_id: owner.userId,
      device_id: owner.deviceId,
      started_at: clock.now(),
      last_active_at: clock.now(),
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  await db
    .insertInto('agent_runs')
    .values({
      id: runId,
      app_id: owner.appId,
      session_id: sessionId,
      prompt_version: 'b3-08zf-test',
      accepted_at: clock.now(),
      quota_subjects: [JSON.stringify(['device', owner.deviceHash])],
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  for (const [id, role] of [
    [assistantId, 'assistant'],
    [userId, 'user'],
    [controlId, 'assistant'],
  ] as const) {
    await db
      .insertInto('agent_messages')
      .values({
        id,
        app_id: owner.appId,
        session_id: sessionId,
        run_id: role === 'user' || id === assistantId ? runId : null,
        client_msg_id: role === 'user' ? randomUUID() : null,
        role,
        text: '合成测试消息',
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
  }
  return { sessionId, assistantId, userId, controlId };
}

export async function messageRow(db: Kysely<DB>, id: string) {
  return db.selectFrom('agent_messages').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

export async function seedAdmin(db: Kysely<DB>, clock: Clock, appId: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('admin_users')
    .values({
      id,
      app_id: appId,
      login_name: `b3_08zf_${id}`,
      password_hash: 'synthetic-unused-hash',
      is_super: false,
      status: 'active',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  return id;
}

/** Seed report states independently of the user HTTP implementation to isolate the admin port. */
export async function seedReport(
  db: Kysely<DB>,
  clock: Clock,
  id: string,
  handlerId?: string,
): Promise<void> {
  await db
    .updateTable('agent_messages')
    .set({
      reported: true,
      report_reason: '首次举报',
      reported_at: clock.now(),
      row_version: 7,
      report_status: handlerId === undefined ? 'pending' : 'handled',
      report_handler_id: handlerId ?? null,
      report_handled_at: handlerId === undefined ? null : clock.now(),
      report_note: handlerId === undefined ? null : '原处理说明',
    })
    .where('id', '=', id)
    .execute();
}

export interface HttpFixture {
  db: Kysely<DB>;
  clock: ReturnType<typeof startClock>;
  owner: AgentCaller;
  app: StreamApp;
  call: Client;
  messages: Awaited<ReturnType<typeof seedMessages>>;
}

export async function withHttp(
  db: Kysely<DB>,
  who: 'member' | 'guest',
  run: (f: HttpFixture) => Promise<void>,
): Promise<void> {
  const clock = startClock();
  const owner = who === 'member' ? await newMember(db) : await newGuest(db);
  await openAgent(db);
  await consent(db, owner);
  const messages = await seedMessages(db, clock, owner);
  const app = await streamApp(db, clock);
  try {
    const call =
      who === 'member' ? await memberClient(app, db, clock, owner) : guestClient(app, owner);
    await run({ db, clock, owner, app, call, messages });
  } finally {
    await app.close();
  }
}

/** Validate the actual operation's response, including EmptyResponse and error data shape. */
export async function answer(action: Action, sent: Sent, code = 0) {
  expect(sent.response.statusCode, sent.response.body).toBe(code === 0 ? 200 : httpStatusOf(code));
  const body = json(sent.response);
  expect(body['code'], sent.response.body).toBe(code);
  expect(body['trace_id']).toBe(sent.traceId);
  const op = operation(await contract(), 'post', template(action));
  const schema = at(
    op,
    'responses',
    code === 0 ? '200' : '4XX',
    'content',
    'application/json',
    'schema',
  );
  const validate = compile(schema);
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  if (code === 0) {
    expect(body['msg']).toBe('');
    expect(body['data']).toEqual({});
  } else {
    expect(body['msg']).toBeTypeOf('string');
    expect(body['msg']).not.toBe('');
    if (code === 30504) expect(body).not.toHaveProperty('data');
  }
  return body;
}

// Dynamic import keeps Nest decorators out of the spec project's compilation, as existing kits do.
export async function adminPort(clock: Clock) {
  const agent = (await import(
    new URL('../../../../apps/api/src/modules/agent/index.ts', import.meta.url).href
  )) as {
    createAgentReportAdminPort: typeof import('../../../../apps/api/src/modules/agent/application/agent-report.ts').createAgentReportAdminPort;
  };
  expect(agent.createAgentReportAdminPort).toBeTypeOf('function');
  return agent.createAgentReportAdminPort({ clock });
}
