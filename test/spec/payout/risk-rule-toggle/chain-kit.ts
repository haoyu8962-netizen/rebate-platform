// B2-11f: the two production chains through the real AppModule. `createBlocklistMatchReader`'s
// `rules` is optional, so an assembly that forgets it would silently keep judging disabled rules:
// only the assembled entries can show both call sites pass the read port (D10-566).
//   - api entry: real Fastify inject, signature, tokens, step-up, PG and Redis (the kit of
//     test/spec/identity/payout-account, the client of test/spec/payout/apply/http.int.test.ts).
//   - worker entry: the real AppModule with an in-memory queue (test/spec/notification/
//     risk-state-message/worker-kit.ts, here with the same keyring as the api entry, because the
//     decision's ⑩ decrypts the verified birth date); its evt.payout-auto-payout handler is called
//     with the withdrawal.created job of a withdrawal the api entry created.
// Members are funded on 2026-10-01, so nothing is credited on the day of the application (⑥). A
// registered device has devices.user_id NULL (identity never sets it); the reader only looks at the
// member's own device rows, so the fixture binds the device to the member. All values are synthetic.
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import { expect, vi } from 'vitest';
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { JobHandler, QueueRuntime } from '../../../../apps/api/src/modules/platform/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import {
  LOGIN,
  ROOT,
  account,
  config,
  fixture,
  type Kit,
} from '../../identity/payout-account/kit.ts';
import { sign } from '../../risk/signature/kit.ts';
import { PATH, fund, seedUser } from '../apply/kit.ts';
import { block, setRule, type Dimension, type RuleStatus, type Violation } from './kit.ts';

export { close, open, type Kit } from '../../identity/payout-account/kit.ts';

/** 2026-10-19 (Monday) 10:00 +08:00, the Clock of every chain test unless a test moves it. */
export const T = '2026-10-19T02:00:00.000Z';
const FUNDED_AT = '2026-10-01T02:00:00.000Z';
/** The dimensions a member of the kit can have: an alipay account, phone, id number, device. */
export const CHAIN_DIMENSIONS = ['phone', 'id_no', 'device', 'alipay'] as const;
export const CHAIN_TIMEOUT = 120_000;
/** The plaintext phone of the identity kit's fixture members. */
export const PHONE = '13800138000';

const AUTO_QUEUE = 'evt.payout-auto-payout';
const DEVICE_SHARED = 'e'.repeat(64);
const DAY = 86_400_000;

export interface MemberOptions {
  /** An existing app of this test; absent: a fresh one. */
  appId?: string;
  /** The alipay login: members of one app need their own (their own payee digest). */
  login?: string;
  /** Two other accounts logged in earlier on a device this member used: BR-ID-37 ranks them third. */
  thirdOnDevice?: boolean;
  /** A released recon_diff hold (BR-WDR-29 ⑧), so that W1 writes that label. */
  reconDiff?: boolean;
}

/** A real member of the api entry: session, device, alipay account, 10000 fen, auto payout on. */
export async function member(kit: Kit, options: MemberOptions = {}) {
  const f = await fixture(kit, options.appId === undefined ? {} : { appId: options.appId });
  const payee = await account(kit, f, options.login ?? LOGIN);
  const headers = {
    'content-type': 'application/json',
    'x-app-id': f.appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const device = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(device.statusCode).toBe(200);
  const { device_id, install_secret } = device.json<{
    data: { device_id: string; install_secret: string };
  }>().data;
  await sql`UPDATE app.devices SET user_id = ${f.uid}
    WHERE app_id = ${f.appId} AND id = ${device_id}`.execute(kit.db);
  await fund(
    kit.db,
    createLedger({ clock: new FixedClock(FUNDED_AT) }),
    { appId: f.appId, userId: f.uid },
    10000n,
  );
  for (const [name, value] of Object.entries({
    'legal.labor_agreement.version': 1,
    'legal.labor_agreement.text_url': 'https://example.test/labor',
    'legal.labor_agreement.text_sha256': 'a'.repeat(64),
    'legal.labor_agreement.resign_from_version': 1,
    'withdraw.daily_count_per_user': 0,
    'withdraw.monthly_count_per_user': 0,
    'withdraw.payee_daily_count': 0,
    'withdraw.payee_daily_distinct_users': 0,
    'withdraw.auto_payout.enabled': true,
  })) {
    await config(kit, f, name, value);
  }
  await sql`INSERT INTO app.consent_records
    (app_id, subject_type, user_id, device_id, type, version, accepted, channel, text_sha256,
     signer_snapshot, client_at, server_at)
    VALUES (${f.appId}, 'user', ${f.uid}, ${device_id}, 'labor_agreement', 1, true, 'withdraw_flow',
      ${'a'.repeat(64)}, '{}'::jsonb, ${kit.clock.now()}, ${kit.clock.now()})`.execute(kit.db);
  if (options.thirdOnDevice === true) await thirdOnDevice(kit, f.appId, f.uid);
  if (options.reconDiff === true) await releasedReconHold(kit, f.appId, f.uid);
  const session = await kit.db
    .transaction()
    .execute((trx) =>
      kit.createSession(
        trx,
        { uid: f.uid, app_id: f.appId, device_id, scp: 'full' },
        { clock: kit.clock, tokens: kit.tokens },
      ),
    );
  const principal = { uid: f.uid, app_id: f.appId, sid: session.sid, device_id };

  async function digestOf(dimension: Dimension): Promise<string> {
    if (dimension === 'alipay') return payee.alipay_hmac!;
    if (dimension === 'phone') {
      const { rows } = await sql<{ digest: string }>`SELECT phone_hmac AS digest FROM app.users
        WHERE app_id = ${f.appId} AND id = ${f.uid}`.execute(kit.db);
      return rows[0]!.digest;
    }
    if (dimension === 'id_no') {
      const { rows } = await sql<{ digest: string }>`SELECT id_no_hmac AS digest FROM app.realname
        WHERE app_id = ${f.appId} AND user_id = ${f.uid}`.execute(kit.db);
      return rows[0]!.digest;
    }
    if (dimension === 'device') {
      const { rows } = await sql<{ digest: string }>`SELECT device_hash AS digest FROM app.devices
        WHERE app_id = ${f.appId} AND id = ${device_id}`.execute(kit.db);
      return rows[0]!.digest;
    }
    throw new Error(`chain kit: the member has no ${dimension} value`);
  }

  /** POST /v1/withdrawals for 1000 fen: a new idempotency key and a new step-up each time. */
  async function post() {
    const body = JSON.stringify({ amount_fen: 1000 });
    const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const step = await kit.signScopedToken(kit.keys, {
      audience: 'step_up',
      claims: { ...principal, action: 'withdraw', jti: randomUUID() },
      issuedAt: Math.floor(kit.clock.now().getTime() / 1000),
      ttlSeconds: 300,
    });
    return kit.app.inject({
      method: 'POST',
      url: PATH,
      payload: body,
      headers: {
        ...headers,
        'x-device-id': device_id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': sign('POST', PATH, Buffer.from(body), timestamp, nonce, install_secret),
        authorization: `Bearer ${session.access_token}`,
        'idempotency-key': randomUUID(),
        'x-step-up-token': step,
      },
    });
  }

  return {
    appId: f.appId,
    userId: f.uid,
    post,
    /** A POST that must create the withdrawal: its id. */
    async apply(): Promise<string> {
      const response = await post();
      expect(response.json()).toMatchObject({ code: 0 });
      return response.json<{ data: { withdrawal_id: string } }>().data.withdrawal_id;
    },
    async block(dimension: Dimension, violation: Violation = 'other'): Promise<void> {
      await block(kit.db, f.appId, dimension, await digestOf(dimension), violation);
    },
    setRule(ruleId: string, status: RuleStatus): Promise<void> {
      return setRule(kit.db, f.appId, ruleId, status, kit.clock.now());
    },
    setConfig(name: string, value: unknown): Promise<void> {
      return config(kit, f, name, value).then(() => undefined);
    },
    async withdrawal(id: string) {
      const { rows } = await sql<{
        status: string;
        review_mode: string | null;
        auto_decision: unknown;
        risk_flags: unknown;
      }>`SELECT status, review_mode, auto_decision, risk_flags FROM app.withdrawals
        WHERE app_id = ${f.appId} AND id = ${id}`.execute(kit.db);
      expect(rows).toHaveLength(1);
      return rows[0]!;
    },
  };
}
export type Member = Awaited<ReturnType<typeof member>>;

/** The codes of a stored risk_flags snapshot. */
export function flagCodes(value: unknown): string[] {
  expect(Array.isArray(value)).toBe(true);
  return (value as { code: string }[]).map((flag) => flag.code);
}

/** Two other accounts first, then the member, on one device within the 720 h window (BR-ID-37). */
async function thirdOnDevice(kit: Kit, appId: string, userId: string): Promise<void> {
  const now = kit.clock.now().getTime();
  const first = await seedUser(kit.db, appId);
  const second = await seedUser(kit.db, appId);
  for (const [who, daysAgo] of [
    [first, 3],
    [second, 2],
    [userId, 1],
  ] as const) {
    await sql`INSERT INTO app.login_logs
      (app_id, user_id, device_hash, device_id_hash, ip, method, created_at)
      VALUES (${appId}, ${who}, ${DEVICE_SHARED}, ${randomBytes(32).toString('hex')}, '192.0.2.37',
        'sms', ${new Date(now - daysAgo * DAY)})`.execute(kit.db);
  }
}

async function releasedReconHold(kit: Kit, appId: string, userId: string): Promise<void> {
  const now = kit.clock.now().getTime();
  await sql`INSERT INTO app.withdraw_holds
    (id, app_id, user_id, reason, created_by, created_at, released_at, released_by)
    VALUES (${randomUUID()}, ${appId}, ${userId}, 'recon_diff', 'synthetic',
      ${new Date(now - 20 * DAY)}, ${new Date(now - 10 * DAY)}, 'synthetic')`.execute(kit.db);
}

export interface Worker {
  /** The worker's pino lines. */
  readonly lines: string[];
  /** One delivery of the withdrawal.created job; the auto_decision the withdrawal then carries. */
  decide(m: Member, id: string): Promise<unknown>;
}

/** The real AppModule on the worker entry, for one test; closed afterwards. */
export async function withWorker(kit: Kit, run: (worker: Worker) => Promise<void>): Promise<void> {
  // URL imports keep parameter decorators in API controllers out of test's erasable TS project.
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): unknown };
  };
  const { PlatformModule, JOB_QUEUE, loadConfig } = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as {
    PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
    JOB_QUEUE: symbol;
    loadConfig(env: Record<string, string>): unknown;
  };
  const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: {
      createApplicationContext(
        module: unknown,
        options: object,
      ): Promise<{ close(): Promise<void> }>;
    };
  };
  const registrations: Array<{ name: string; handler: JobHandler }> = [];
  const queue: QueueRuntime = {
    register(name, handler) {
      registrations.push({ name, handler });
    },
    send: vi.fn<QueueRuntime['send']>(async () => 'fixture-job'),
    async start() {},
    async stop() {},
  };
  const original = PlatformModule.forRoot.bind(PlatformModule);
  const spy = vi.spyOn(PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = original(options);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === JOB_QUEUE
          ? { provide: JOB_QUEUE, useValue: queue }
          : provider,
      ),
    };
  });
  const lines: string[] = [];
  const context = await NestFactory.createApplicationContext(
    AppModule.forEntry({
      entry: 'worker',
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(kit.dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(kit.dir, 'keyring.json'),
      }),
      clock: kit.clock,
      logger: createRootLogger(
        { level: 'trace', entry: 'worker', appEnv: 'test' },
        { write: (line: string) => void lines.push(line) },
      ),
      dbHandles: { db: kit.db, dbRead: null, close: async () => undefined },
    }),
    { logger: false, abortOnError: false },
  ).finally(() => spy.mockRestore());
  try {
    await run({
      lines,
      async decide(m, id) {
        const matches = registrations.filter((registration) => registration.name === AUTO_QUEUE);
        expect(matches).toHaveLength(1);
        await matches[0]!.handler({
          id: randomUUID(),
          queue: AUTO_QUEUE,
          name: 'withdrawal.created',
          attempt: 1,
          payload: {
            app_id: m.appId,
            v: 1,
            occurred_at: kit.clock.now().toISOString(),
            data: { withdrawal_id: id, user_id: m.userId, amount_fen: 1000, review_mode: null },
          },
        });
        return (await m.withdrawal(id)).auto_decision;
      },
    });
  } finally {
    await context.close();
  }
}
