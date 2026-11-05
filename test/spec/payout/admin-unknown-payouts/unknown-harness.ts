// B2-09s / SPEC_REF 6f50a051. Real admin composition root, auth, step-up, PG idempotency,
// ledger, audit, queue and notification; synthetic members and fake payout channel only.
// Reuses B2-09m's role-correct DB/Redis fixture (computed URL import of db testing).
// No channel credentials, payout-account updates or production services.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresQueryCompiler, sql, type KyselyPlugin } from 'kysely';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  FIELD_CRYPTO,
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
  type FieldCrypto,
  type FixedClock,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { contractPaths } from '../../ledger/admin-recon-write-off/kit.ts';
import type { Sealer, WithdrawalSeed } from '../admin-withdrawals/kit.ts';
import { newKey, textOf, type ReviewFixture } from '../admin-withdrawal-review/review-harness.ts';
import {
  reviewing,
  rowOf,
  seedAttempt,
  serial,
  type Member,
  type WithdrawalRow,
} from '../admin-manual-paid/manual-paid-harness.ts';
import { createQueryJob } from '../../../../apps/api/src/modules/payout/jobs/query-job.ts';
import { configPort } from '../proven-success/kit.ts';
import type { QueryResult } from '../../../../apps/api/src/modules/payout/domain/channel-result.ts';
import {
  JOB_QUEUE,
  EVENT_BUS,
  type JobQueue,
  type EventBus,
  type ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { vi } from 'vitest';
export * from '../admin-manual-paid/manual-paid-harness.ts';

const ROOT = new URL('../../../../', import.meta.url);

export type FaultPoint = 'audit' | 'voucher' | 'tax_ytd';

export interface Fault {
  /** One-shot: set it, the next matching statement fails and it goes back to null. */
  point: FaultPoint | null;
  /** When set, only a statement whose parameters contain this text matches (one id of a request). */
  contains: string | null;
  tripped: number;
}

function insertsInto(text: string, table: string): boolean {
  return new RegExp(String.raw`\binsert\s+into\s+(?:"?app"?\s*\.\s*)?"?${table}\b`, 'i').test(text);
}

function faultPlugin(fault: Fault): KyselyPlugin {
  const compiler = new PostgresQueryCompiler();
  return {
    transformQuery({ node, queryId }) {
      const point = fault.point;
      if (point === null) return node;
      const compiled = compiler.compileQuery(node, queryId);
      const parameters = textOf(compiled.parameters);
      const statement =
        point === 'voucher'
          ? insertsInto(compiled.sql, 'ledger_vouchers')
          : point === 'tax_ytd'
            ? insertsInto(compiled.sql, 'tax_ytd')
            : insertsInto(compiled.sql, 'audit_logs') &&
              (parameters.includes('withdrawal_resolve') ||
                parameters.includes('payout_query_request'));
      if (statement && (fault.contains === null || parameters.includes(fault.contains))) {
        fault.point = null;
        fault.contains = null;
        fault.tripped += 1;
        throw new Error(`synthetic failure at ${point}`);
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export type Operation = 'resolve' | 'query' | 'list' | 'audit' | 'manualPaid' | 'reject';

export interface Envelope {
  code: number;
  msg: string;
  data?: unknown;
  trace_id: string;
}

export interface AdminSent {
  readonly op: Operation;
  readonly statusCode: number;
  readonly body: string;
  json(): Envelope;
}

export interface AdminCaller {
  readonly id: string;
  readonly token: string;
  readonly sessionId: string;
}

export interface WriteOptions {
  /** Idempotency-Key: a fresh one by default; null sends none. */
  readonly key?: string | null;
  /** The caller: the operation's default account by default; null sends no token. */
  readonly caller?: AdminCaller | null;
  /** X-Step-Up-Token: a fresh totp-tier token of the caller by default; null sends none. */
  readonly stepUp?: string | null;
}

export interface UnknownAdmin extends Sealer {
  readonly fault: Fault;
  readonly queue: JobQueue;
  readonly events: EventBus;
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  stepUp(caller: AdminCaller, tier?: 'totp' | 'sms'): Promise<string>;
  readonly executor: AdminCaller;
  resolve(id: string, body: unknown, options?: WriteOptions): Promise<AdminSent>;
  query(id: string, options?: WriteOptions, body?: unknown): Promise<AdminSent>;
  list(query?: string, options?: WriteOptions): Promise<AdminSent>;
  audit(id: string, options?: WriteOptions): Promise<AdminSent>;
  manualPaid(items: readonly unknown[], options?: WriteOptions): Promise<AdminSent>;
  reject(id: string, options?: WriteOptions): Promise<AdminSent>;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'POST' | 'GET';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

/** Runs `run` against a started admin entry on the fixture's database, clock and Redis. */
export async function withUnknownAdmin(
  f: ReviewFixture,
  run: (h: UnknownAdmin) => Promise<void>,
): Promise<void> {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'admin',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: RootLogger;
        dbHandles: DbHandles;
        redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b2-09s-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  const fault: Fault = { point: null, contains: null, tripped: 0 };
  const store = f.db.withPlugin(faultPlugin(fault));
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp('admin', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
        ADMIN_TOKEN_SIGNING_KEY: tokenKey.toString('base64url'),
        ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
        ADMIN_CORS_ORIGIN: 'https://admin.example.invalid',
        JWT_KEY_ID: 'b2_09s_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'admin', appEnv: 'test', level: 'silent' },
        { write: () => undefined },
      ),
      dbHandles: { db: store, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('admin', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        DATABASE_READ_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: f.s.redisUrl(),
      }).redisUrl,
    });
    await app.init();
    const server = app;
    const redis = server.get<RedisHandle>(REDIS);
    const crypto = server.get<FieldCrypto>(FIELD_CRYPTO);
    const caller: UnknownAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `mp_${id}`,
          password_hash: 'unused-test-login',
          is_super: options.superAdmin === true,
          status: 'active',
          password_must_change: false,
          totp_bound_at: f.clock.now(),
          created_at: f.clock.now(),
          updated_at: f.clock.now(),
        })
        .execute();
      if (permissions.length > 0) {
        await f.db
          .insertInto('admin_permissions')
          .values(
            permissions.map((permission_key) => ({
              app_id: f.appId,
              admin_id: id,
              permission_key,
              granted_by: id,
              granted_at: f.clock.now(),
            })),
          )
          .execute();
      }
      const { token, claims } = await createAdminTokens({ key: tokenKey, clock: f.clock }).issue({
        adminId: id,
        appId: f.appId,
      });
      await createAdminSessions({ redis: redis.namespace('admin-auth'), clock: f.clock }).create(
        claims.sessionId,
        {
          adminId: id,
          appId: f.appId,
          expiresAtMs: claims.expiresAt * 1000,
          lastSeenMs: f.clock.now().getTime(),
        },
      );
      return { id, token, sessionId: claims.sessionId };
    };
    const stepUp: UnknownAdmin['stepUp'] = async (who, tier = 'totp') => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const executor = await caller(['payout.execute']);
    const post = async (
      op: Operation,
      url: string,
      body: unknown,
      options: WriteOptions,
      fallback: AdminCaller,
    ): Promise<AdminSent> => {
      const who = options.caller === undefined ? fallback : options.caller;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-trace-id': randomUUID(),
      };
      if (who !== null) headers['authorization'] = `Bearer ${who.token}`;
      if (options.key !== null) headers['idempotency-key'] = options.key ?? newKey();
      const token =
        options.stepUp !== undefined ? options.stepUp : who === null ? null : await stepUp(who);
      if (token !== null) headers['x-step-up-token'] = token;
      const response = await server.inject({
        method: op === 'list' || op === 'audit' ? 'GET' : 'POST',
        url,
        headers,
        ...(op === 'list' || op === 'audit' ? {} : { payload: JSON.stringify(body) }),
        remoteAddress: '127.0.0.1',
      });
      return {
        op,
        statusCode: response.statusCode,
        body: response.body,
        json: () => JSON.parse(response.body) as Envelope,
      };
    };
    await run({
      crypto,
      fault,
      caller,
      stepUp,
      executor,
      queue: server.get<JobQueue>(JOB_QUEUE),
      events: server.get<EventBus>(EVENT_BUS),
      resolve: (id, body, options = {}) =>
        post('resolve', `/admin/v1/withdrawals/${id}/resolve`, body, options, executor),
      query: (id, options = {}, body = {}) =>
        post('query', `/admin/v1/withdrawals/${id}/query`, body, options, executor),
      list: (query = '', options = {}) =>
        post(
          'list',
          `/admin/v1/unknown-payouts${query}`,
          {},
          { stepUp: null, ...options },
          executor,
        ),
      audit: (id, options = {}) =>
        post('audit', `/admin/v1/audit-logs?target_id=${id}`, {}, options, executor),
      manualPaid: (items, options = {}) =>
        post('manualPaid', '/admin/v1/withdrawals/batch-manual-paid', { items }, options, executor),
      reject: (id, options = {}) =>
        post(
          'reject',
          `/admin/v1/withdrawals/${id}/reject`,
          { reason_code: 'OTHER', note: '合成驳回原因' },
          options,
          executor,
        ),
    });
  } finally {
    try {
      await app?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The contract.

const PATHS: Record<Operation, string> = {
  resolve: '/admin/v1/withdrawals/{withdrawal_id}/resolve',
  query: '/admin/v1/withdrawals/{withdrawal_id}/query',
  list: '/admin/v1/unknown-payouts',
  audit: '/admin/v1/audit-logs',
  manualPaid: '/admin/v1/withdrawals/batch-manual-paid',
  reject: '/admin/v1/withdrawals/{withdrawal_id}/reject',
};

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20901: 409,
  20902: 409,
  40901: 409,
  50001: 500,
};

/** The response body conforms to its operation's schema of its status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const path = PATHS[sent.op];
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[path]?.[
    sent.op === 'list' || sent.op === 'audit' ? 'get' : 'post'
  ]?.responses[status]?.content?.['application/json']?.schema;
  expect(schema, `${path} ${status}`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(sent.body) as unknown;
  } catch {
    parsed = sent.body;
  }
  expect(check(parsed), `${sent.body} ${JSON.stringify(check.errors)}`).toBe(true);
}

/** Status, code and (when given) exact data, then the contract schema. */
export async function answer(sent: AdminSent, code: number, data?: unknown): Promise<Envelope> {
  expect(sent.statusCode, sent.body).toBe(HTTP_STATUS[code]);
  const body = sent.json();
  expect(body.code, sent.body).toBe(code);
  if (data !== undefined) expect(body.data, sent.body).toEqual(data);
  await conforms(sent);
  return body;
}

export const DAY = 86_400_000;
export const PROOF = '合成凭证：账单没有这笔、查询返回订单不存在';

export function paidBody(
  f: ReviewFixture,
  row: WithdrawalRow,
  patch: Record<string, unknown> = {},
) {
  return {
    resolution: 'paid',
    proof_text: `合成成功凭证 out_biz_no=${row.out_biz_no}`,
    channel_order_id: serial(),
    paid_at: new Date(f.clock.now().getTime() - 60_000).toISOString(),
    ...patch,
  };
}

export function refused(sent: AdminSent, reason: string, field = 'resolution') {
  return answer(sent, 20001, { fields: [field], reason });
}

export function queryWorker(f: ReviewFixture, h: UnknownAdmin, result: QueryResult) {
  const query = vi.fn(async (outBizNo: string) => {
    void outBizNo;
    return result;
  });
  const transfer = vi.fn(async () => ({
    kind: 'unknown' as const,
    raw: { code: 'SYNTHETIC' },
    latencyMs: 0,
  }));
  const channel = { query, transfer };
  const handler = createQueryJob({
    db: f.db,
    attemptsDb: f.payout,
    clock: f.clock,
    config: configPort(),
    ledger: f.ledger,
    lockUsersForUpdate,
    queue: h.queue,
    eventBus: h.events,
    channels: { alipay: channel, bank_card: channel, wechat: channel },
    sleep: async () => undefined,
    logger: { info: () => undefined, warn: () => undefined },
  });
  return { handler, query, transfer };
}

export function automaticJob(row: WithdrawalRow): ReceivedJob {
  return {
    id: randomUUID(),
    queue: 'payout',
    name: 'query',
    payload: { app_id: row.app_id, withdrawal_id: row.id, execute_seq: row.execute_seq, point: 0 },
    attempt: 0,
  };
}

/** Real T+24h job marks needs_manual; early cases explicitly seed this payout-only flag. */
export async function unknownWithdrawal(
  f: ReviewFixture,
  h: UnknownAdmin,
  who: Member,
  options: { age?: number; seed?: WithdrawalSeed; automatic?: boolean } = {},
): Promise<WithdrawalRow> {
  const age = options.age ?? DAY;
  const t = new Date(f.clock.now().getTime() - age);
  const row = await reviewing(f, h, who, {
    status: 'PAYING',
    execute_seq: 1,
    created_at: new Date(t.getTime() - 60_000),
    executed_at: t,
    ...options.seed,
  });
  await seedAttempt(f, row, { kind: 'transfer', result: 'unknown', at: t });
  if (age >= DAY && options.automatic !== false) {
    const worker = queryWorker(f, h, { kind: 'unknown', raw: { code: 'SYNTHETIC_UNKNOWN' } });
    await worker.handler(automaticJob(row));
    expect(worker.query).not.toHaveBeenCalled();
    expect(worker.transfer).not.toHaveBeenCalled();
  } else {
    await f.payout
      .withSchema('app')
      .updateTable('withdrawals')
      .set({ needs_manual: true })
      .where('app_id', '=', row.app_id)
      .where('id', '=', row.id)
      .execute();
  }
  const current = await rowOf(f, row);
  expect(current).toMatchObject({ status: 'PAYING', needs_manual: true });
  return current;
}

export function attemptsOf(f: ReviewFixture, row: WithdrawalRow) {
  return f.db
    .selectFrom('payout_attempts')
    .selectAll()
    .where('app_id', '=', row.app_id)
    .where('withdrawal_id', '=', row.id)
    .orderBy('at')
    .orderBy('id')
    .execute();
}

/** Only jobs actually enqueued by the HTTP command, never a reconstructed manual payload. */
export async function queuedQueries(f: ReviewFixture) {
  const result = await sql<{
    id: string;
    data: { name: string; payload: ReceivedJob['payload'] };
  }>`
    SELECT id, data FROM pgboss.job WHERE name = 'payout'
      AND data->>'name' = 'query' AND data->'payload'->>'app_id' = ${f.appId}
    ORDER BY created_on, id`.execute(f.db);
  return result.rows.map((row): ReceivedJob => ({
    id: row.id,
    name: row.data.name,
    queue: 'payout',
    payload: row.data.payload,
    attempt: 0,
  }));
}

/** Synthetic bill rows are evidence, not a claim that an entire bill was downloaded. */
export async function bill(
  f: ReviewFixture,
  row: WithdrawalRow,
  status: string,
  billDate = '2026-11-02',
  outBizNo = row.out_biz_no,
) {
  await sql`INSERT INTO app.recon_channel
    (id, app_id, date, bill_date, out_biz_no, channel_order_id, our_status,
     channel_status, our_amount_fen, channel_amount_fen, result, created_at, updated_at)
    VALUES (${randomUUID()}, ${row.app_id}, ${billDate}::date, ${billDate}::date,
      ${outBizNo}, ${serial()}, ${row.status}, ${status}, ${row.net_fen}, ${row.net_fen},
      'matched', ${f.clock.now()}, ${f.clock.now()})`.execute(f.db);
}
