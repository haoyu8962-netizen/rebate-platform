// B3-03f fixture: the stream entry's assembly (agent/stream/mount createAgentStreamRuntime, mounted
// by AgentModule.forStream; B3-05-plan §1.1, §3.3; B3-03g design §5.1, §6.2; BR-AI-13, BR-AI-23).
// Pieces:
// - databases: one fresh PostgreSQL database per test through the B3-03h kit (usePgEach); the
//   integration tests pass createTestDatabase (only *.int.test.ts may import @couli/db/testing);
// - real rows: devices / users, config_items (agent.* switches, legal.ai_third_party.version) and
//   consent_records (ai_third_party) written as couli_app; nothing of the runtime is faked;
// - one runtime = createAgentStreamRuntime over the real database, a ManualTime clock and
//   scheduler (B3-03b kit) and identity's real createAiConsentReader (loaded by URL: identity's
//   index carries Nest controllers the `test` project does not compile);
// - seams only where the notes allow them: an input check that lets the message through in the
//   model form (redactForModel, as the future input review will) and recording / held tools.
// Everything under test is built inside tests (never in hooks), so the NotImplemented of the
// skeleton reddens each test itself. Expected values stay in the rule tests or are read from
// contracts/texts.default.json.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { createContentReader } from '../../../../apps/api/src/modules/content/index.ts';
import type {
  AiConsentReader,
  AiConsentReaderOptions,
} from '../../../../apps/api/src/modules/identity/ports/ai-consent.ts';
import type { Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import {
  createAgentStreamRuntime,
  type AgentConsentReaderFactory,
  type AgentContentReader,
  type AgentStreamRuntime,
  type AgentStreamSeams,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import type {
  InputCheckPort,
  KeywordSearchOutcome,
  OrchestratorTools,
  ToolContext,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { KeywordSearchPlan } from '../../../../apps/api/src/modules/agent/model-gateway/degraded/index.ts';
import { redactForModel } from '../../../../apps/api/src/modules/agent/preprocess/redact/index.ts';
import { connect, insertRow, newUser } from '../../db/linking-bindings/kit.ts';
import { ManualTime } from '../stream-run/kit.ts';
import { FakeReply, Logs, settleWork, type Row } from '../stream-recovery/kit.ts';

export { FakeReply, LEVEL, Logs, framesOf, type Frame, type Row } from '../stream-recovery/kit.ts';
export {
  agentSnapshot,
  fileErrorMsg,
  runRow,
  runsOf,
  sessionRow,
  settleWork,
  until,
  usePgEach,
  usedOf,
} from '../stream-recovery/kit.ts';
export { ManualTime } from '../stream-run/kit.ts';

/** The app of the tests (devices, users, config and consent rows all carry it). */
export const APP = 'couli';

const TEXTS_FILE = new URL('../../../../contracts/texts.default.json', import.meta.url);

/** texts['<key>'] of contracts/texts.default.json (read from the file, never copied here). */
export function fileText(key: string): string {
  const file = JSON.parse(readFileSync(TEXTS_FILE, 'utf8')) as { texts: Record<string, string> };
  const text = file.texts[key];
  expect(text, `texts.default.json ${key}`).toBeTypeOf('string');
  return text!;
}

// ---- configuration and consent rows -----------------------------------------------------------

/** Writes config_items (app_id, key) = value as couli_app; an existing row gets a new version. */
export async function setConfig(
  db: Kysely<DB>,
  appId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const json = JSON.stringify(value);
  const updated = await db
    .updateTable('config_items')
    .set({
      value: sql`${json}::jsonb`,
      version: sql`version + 1`,
      row_version: sql`row_version + 1`,
    })
    .where('app_id', '=', appId)
    .where('key', '=', key)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) > 0) return;
  await db
    .insertInto('config_items')
    .values({ app_id: appId, key, value: sql`${json}::jsonb`, updated_by: 'b3-03f-rule-test' })
    .execute();
}

/** Removes config_items (app_id, key): the key is missing. */
export async function unsetConfig(db: Kysely<DB>, appId: string, key: string): Promise<void> {
  await db.deleteFrom('config_items').where('app_id', '=', appId).where('key', '=', key).execute();
}

/** Agent open to everyone of `appId` (no whitelist, no phone requirement). */
export async function openAgent(db: Kysely<DB>, appId: string = APP): Promise<void> {
  await setConfig(db, appId, 'agent.enabled', true);
  await setConfig(db, appId, 'agent.whitelist_only', false);
}

let consentNo = 0;

/**
 * One ai_third_party consent record of the caller (user level with a user id, else device level),
 * later than every record written before it (server_at strictly increasing).
 */
export async function consent(
  db: Kysely<DB>,
  caller: AgentCaller,
  options: { accepted?: boolean; version?: number } = {},
): Promise<void> {
  consentNo += 1;
  const at = new Date(Date.parse('2026-10-05T00:00:00Z') + consentNo * 1_000);
  await db
    .insertInto('consent_records')
    .values({
      app_id: caller.appId,
      subject_type: caller.userId === null ? 'device' : 'user',
      user_id: caller.userId,
      device_id: caller.deviceId,
      type: 'ai_third_party',
      accepted: options.accepted ?? true,
      version: options.version ?? 1,
      channel: 'agent_sheet',
      server_at: at,
      client_at: at,
    })
    .execute();
}

// ---- callers ----------------------------------------------------------------------------------

let traceNo = 0;

async function newDevice(db: Kysely<DB>, appId: string, userId: string | null): Promise<string> {
  connect(db);
  const deviceId = randomUUID();
  await insertRow('devices', {
    id: deviceId,
    app_id: appId,
    user_id: userId,
    install_secret_cipher: Buffer.from('synthetic-install-secret'),
    last_seen_at: new Date('2026-10-06T00:00:00Z'),
  });
  return deviceId;
}

function callerOf(appId: string, deviceId: string, userId: string | null, phoneBound: boolean) {
  traceNo += 1;
  const caller: AgentCaller = {
    appId,
    traceId: `trace_b3_03f_${String(traceNo)}`,
    deviceId,
    deviceHash: `dh-${deviceId}`,
    ipKey: `ipk-${deviceId}`,
    userId,
    phoneBound,
  };
  return caller;
}

/**
 * A logged-in caller on real users / devices rows; phoneBound as given (default true). A bound
 * phone is real identity data: users.phone_hmac and users.phone_cipher are set (synthetic values),
 * an unbound user has both null, so the stream entry can derive it from the account itself.
 */
export async function newMember(
  db: Kysely<DB>,
  options: { appId?: string; phoneBound?: boolean } = {},
): Promise<AgentCaller> {
  const appId = options.appId ?? APP;
  const phoneBound = options.phoneBound ?? true;
  connect(db);
  const userId = await newUser({
    app_id: appId,
    ...(phoneBound
      ? {
          phone_hmac: randomBytes(32).toString('hex'),
          phone_cipher: Buffer.from(`synthetic-phone-cipher-${randomUUID()}`),
        }
      : { phone_hmac: null, phone_cipher: null }),
  });
  const deviceId = await newDevice(db, appId, userId);
  return callerOf(appId, deviceId, userId, phoneBound);
}

/** The same account on another real devices row (a second phone of the user). */
export async function anotherDevice(db: Kysely<DB>, caller: AgentCaller): Promise<AgentCaller> {
  const deviceId = await newDevice(db, caller.appId, caller.userId);
  return callerOf(caller.appId, deviceId, caller.userId, caller.phoneBound);
}

/** The guest's own device after the user logs in on it (devices.user_id set to the account). */
export async function loginOnDevice(
  db: Kysely<DB>,
  guest: AgentCaller,
  member: AgentCaller,
): Promise<AgentCaller> {
  await db
    .updateTable('devices')
    .set({ user_id: member.userId })
    .where('id', '=', guest.deviceId)
    .execute();
  return callerOf(guest.appId, guest.deviceId, member.userId, member.phoneBound);
}

/** A guest on a real devices row. */
export async function newGuest(db: Kysely<DB>, appId: string = APP): Promise<AgentCaller> {
  const deviceId = await newDevice(db, appId, null);
  return callerOf(appId, deviceId, null, false);
}

/** The same caller on a new request (a new trace id). */
export function retrace(caller: AgentCaller): AgentCaller {
  traceNo += 1;
  return { ...caller, traceId: `trace_b3_03f_${String(traceNo)}` };
}

// ---- runtime ----------------------------------------------------------------------------------

/** identity's createAiConsentReader (B1-02r) as identity exports it (it takes a handle). */
export type IdentityConsentReader = (options: AiConsentReaderOptions) => AiConsentReader;

/** identity's real AiConsentReader factory (B1-02r), loaded by URL. */
export async function loadConsentReader(): Promise<IdentityConsentReader> {
  const identity = (await import(
    new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
  )) as typeof import('../../../../apps/api/src/modules/identity/ports/ai-consent.ts');
  return identity.createAiConsentReader;
}

/**
 * B3-08k: identity's consent reader bound to `db`, as app.module provides it through
 * agentConsentReaderToken() (agent hands it the version source only, never a handle).
 */
export function bindConsentReader(
  identityReader: IdentityConsentReader,
  db: Kysely<DB>,
): AgentConsentReaderFactory {
  return ({ currentVersion }) => identityReader({ db, currentVersion });
}

/**
 * B3-08k: content's reads as app.module provides them through agentContentReaderToken(), built
 * here over `db`'s app schema as the runtime built its own reader before: configValue through one
 * cached content reader, freshConfigValue through a content reader built per call.
 */
export function contentReaderFor(db: Kysely<DB>, clock: Clock): AgentContentReader {
  const handle = db.withSchema('app');
  const shared = createContentReader({ db: handle, clock });
  return {
    configValue: (appId, key) => shared.configValue(appId, key),
    freshConfigValue: (appId, key) =>
      createContentReader({ db: handle, clock }).configValue(appId, key),
  };
}

export interface Rig {
  readonly time: ManualTime;
  readonly logs: Logs;
  readonly runtime: AgentStreamRuntime;
}

/**
 * One stream runtime over `db` (no Redis), on a ManualTime clock and scheduler. `seams` may
 * replace the input check and the tools only (schedule is always the ManualTime scheduler).
 */
export async function rig(
  db: Kysely<DB>,
  seams: Pick<AgentStreamSeams, 'inputCheck' | 'tools'> = {},
): Promise<Rig> {
  const consentReader = bindConsentReader(await loadConsentReader(), db);
  const time = new ManualTime();
  const logs = new Logs();
  const contentReader = contentReaderFor(db, time.clock);
  const runtime = createAgentStreamRuntime(
    { db, clock: time.clock, logger: logs.logger, contentReader, consentReader },
    { ...seams, schedule: time.scheduler },
  );
  return { time, logs, runtime };
}

/** createSession through the runtime's HTTP layer; returns the new session id. */
export async function openSession(r: Rig, caller: AgentCaller): Promise<string> {
  const reply = new FakeReply();
  await r.runtime.http.createSession(retrace(caller), reply);
  const call = reply.single();
  expect(call.status, JSON.stringify(call.body)).toBe(200);
  const id = (call.body['data'] as Row)['session_id'];
  expect(id, 'session id').toBeTypeOf('string');
  return id as string;
}

export function message(text = '提现记录在哪看', clientMsgId: string = randomUUID()): Row {
  return { client_msg_id: clientMsgId, text };
}

/** sendMessage on the runtime; resolves when the handler resolved. */
export async function send(
  r: Rig,
  caller: AgentCaller,
  sessionId: string,
  body: Row,
): Promise<FakeReply> {
  const reply = new FakeReply();
  await r.runtime.http.sendMessage(retrace(caller), sessionId, body, reply);
  return reply;
}

/** The JSON error code of a refused request (exactly one JSON answer, no stream opened). */
export function refusedCode(reply: FakeReply): unknown {
  expect(reply.streams, 'no stream opened').toEqual([]);
  expect(reply.jsons, 'one JSON answer').toHaveLength(1);
  return reply.jsons[0]!.body['code'];
}

// ---- seams ------------------------------------------------------------------------------------

/**
 * An input check that lets every message through in the model form (BR-AI-14 table with <num_k>
 * placeholders, as the input review of B3-05d will hand it on); records what it was given.
 */
export class PassInputCheck implements InputCheckPort {
  readonly texts: string[] = [];
  check(input: Parameters<InputCheckPort['check']>[0]): ReturnType<InputCheckPort['check']> {
    this.texts.push(input.text);
    const model = redactForModel(input.text);
    return Promise.resolve({
      kind: 'proceed',
      modelText: model.text,
      placeholders: model.placeholders,
      links: [],
      notices: [],
      untrustedInput: false,
      paramsRequested: false,
    });
  }
}

/**
 * Tools with one enabled platform whose keyword search records its plan and answers an empty
 * success; with hold(), the search waits until its run's signal aborts (a run kept in progress).
 */
export class RecordingTools implements OrchestratorTools {
  readonly plans: KeywordSearchPlan[] = [];
  #held = false;
  hold(): this {
    this.#held = true;
    return this;
  }
  definitions(): ReturnType<OrchestratorTools['definitions']> {
    return Promise.resolve([]);
  }
  execute(): ReturnType<OrchestratorTools['execute']> {
    return Promise.resolve({ kind: 'rejected', modelView: { error: 'invalid_args' } });
  }
  enabledSearchPlatforms(): Promise<readonly string[]> {
    return Promise.resolve(['taobao']);
  }
  searchKeyword(plan: KeywordSearchPlan, ctx: ToolContext): Promise<KeywordSearchOutcome> {
    this.plans.push(structuredClone(plan));
    if (!this.#held) {
      return Promise.resolve({ results: [{ platform: 'taobao', ok: true, items: [] }], cards: [] });
    }
    return new Promise<KeywordSearchOutcome>((_resolve, reject) => {
      if (ctx.signal.aborted) {
        reject(new Error('fixture: aborted'));
        return;
      }
      ctx.signal.addEventListener('abort', () => reject(new Error('fixture: aborted')), {
        once: true,
      });
    });
  }
}

// ---- database text scan -----------------------------------------------------------------------

/** Every row of every app.agent_* table, as JSON text (all text columns included). */
export async function agentTablesText(db: Kysely<DB>): Promise<string> {
  const tables = await sql<{ name: string }>`SELECT table_name AS name
    FROM information_schema.tables
    WHERE table_schema = 'app' AND table_name LIKE 'agent\\_%' AND table_type = 'BASE TABLE'
    ORDER BY table_name`.execute(db);
  expect(tables.rows.map((t) => t.name)).toEqual(
    expect.arrayContaining(['agent_messages', 'agent_runs', 'agent_sessions']),
  );
  const parts: string[] = [];
  for (const { name } of tables.rows) {
    const rows = await sql<{ j: unknown }>`SELECT to_jsonb(t) AS j
      FROM ${sql.table(`app.${name}`)} t`.execute(db);
    parts.push(JSON.stringify(rows.rows.map((row) => row.j)));
  }
  return parts.join('\n');
}

// B3-03fa (D10-980, FU-FLAKY-B3-03F-10): settleWork alone (5 x SELECT 1 and a microtask flush)
// let the manual time outrun real database work. [AC-B3-03f#10] went red on a loaded CI runner
// with 10 s of scheduler time used up in 282 ms of real time: the run's guard reads and its
// closing transaction had not finished while every step had already moved the clock on. Each
// step therefore also waits, with a bound, until the test's own database is quiet.

/** Real-time bound of the wait for a quiet database after one step (D10-980 (b)). */
const QUIET_WAIT_MS = 2_000;
/** Real-time pause between two looks while the database is still busy. */
const QUIET_POLL_MS = 10;
/** Consecutive quiet looks that count as quiet (a chain of statements may be between two). */
const QUIET_LOOKS = 2;

/**
 * Sessions of this test's database that are inside a statement or a transaction. Only this
 * test's database counts (datname = current_database(): every test has its own database, so
 * test files running in parallel never count, D10-980 (a)), and the session asking is left out.
 */
async function busySessions(db: Kysely<DB>): Promise<number> {
  const result = await sql<{ busy: number }>`SELECT count(*)::int AS busy
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND backend_type = 'client backend'
      AND state IN ('active', 'idle in transaction', 'idle in transaction (aborted)')`.execute(db);
  return result.rows[0]?.busy ?? 0;
}

/**
 * Waits until this test's database is quiet, at most QUIET_WAIT_MS of real time; at the bound
 * it returns as if quiet (no error, no retry: the step goes on and the assertions decide).
 */
async function quietDatabase(db: Kysely<DB>): Promise<void> {
  const bound = performance.now() + QUIET_WAIT_MS;
  let quietLooks = 0;
  while (quietLooks < QUIET_LOOKS && performance.now() < bound) {
    if ((await busySessions(db)) === 0) {
      quietLooks += 1;
      // Let a statement the runtime is about to send reach the server before the next look.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } else {
      quietLooks = 0;
      await new Promise<void>((resolve) => setTimeout(resolve, QUIET_POLL_MS));
    }
  }
}

/**
 * Advances the manual time in steps, letting database work in flight finish between steps:
 * after each step settleWork flushes the microtasks, then the test's database must be quiet
 * (bounded, see quietDatabase) before the clock moves again.
 */
export async function stepUntil(
  r: Rig,
  db: Kysely<DB>,
  done: () => boolean,
  limitMs: number,
  stepMs = 250,
): Promise<boolean> {
  await settleWork(db);
  await quietDatabase(db);
  while (!done() && r.time.t < limitMs) {
    await r.time.to(Math.min(limitMs, r.time.t + stepMs));
    await settleWork(db);
    await quietDatabase(db);
  }
  return done();
}
