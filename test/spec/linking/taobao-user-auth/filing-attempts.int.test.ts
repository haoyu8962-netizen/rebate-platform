import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { UnionBindingExchanger } from '../../../../apps/api/src/modules/linking/application/union-binding-exchanger.ts';
import { createUnionBindings } from '../../../../apps/api/src/modules/linking/application/union-bindings.ts';
import { systemScheduler } from '../../../../apps/api/src/modules/platform/index.ts';
import { createGovernedAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import {
  connect,
  insertRow,
  newAccount,
  newAuth,
  newUser,
  requireTable,
} from '../../db/linking-bindings/kit.ts';
import { endpoint, response, setup } from '../../union/taobao-core/kit.ts';
import {
  APP_KEY,
  CODE,
  SECRET,
  TOKEN_ENDPOINT,
  tokenAnswer,
} from '../../union/taobao-site-oauth/kit.ts';
import { INVITER_CODE, USER_REDIRECT } from './kit.ts';

const TABLE = 'union_filing_attempts';
const APP_ID = 'couli';
const SAVE = 'taobao.tbk.sc.publisher.info.save';
const GET = 'taobao.tbk.sc.publisher.info.get';
const RELATION = '819712';
const APP_REF = 'synthetic-issued-app';
const OAUTH_APP = { appKey: APP_KEY, redirectUri: USER_REDIRECT };
const SAVED = response({
  tbk_sc_publisher_info_save_response: { data: { relation_id: RELATION } },
});
const DUPLICATE = response({
  tbk_sc_publisher_info_save_response: { data: { desc: '重复绑定渠道' } },
});
const REJECTED = response({ error_response: { code: 15, msg: 'synthetic filing refusal' } });
const FOUND = response({
  tbk_sc_publisher_info_get_response: {
    data: {
      total_count: 1,
      inviter_list: { map_data: [{ relation_app: 'common', relation_id: RELATION }] },
    },
  },
});

type Outcome = 'saved' | 'rejected' | 'duplicate';
type Answer = Outcome | 'save_timeout' | 'lookup_timeout';
interface Attempt {
  id: string;
  app_id: string;
  user_id: string;
  platform: string;
  union_account_id: string;
  state: string;
  started_at: Date;
  outcome: Outcome | null;
  finished_at: Date | null;
}

let database: TestDatabase;
let app: Kysely<DB>;
let observer: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  const connectionString = database.urlFor('couli_app');
  app = createDb({ connectionString, max: 3 });
  observer = createDb({ connectionString, max: 1 });
  connect(app);
});

afterAll(async () => {
  if (observer) await destroyDb(observer);
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

async function attempts(db: Kysely<DB>, state: string): Promise<Attempt[]> {
  const result = await sql<Attempt>`
    SELECT id, app_id, user_id, platform, union_account_id, state, started_at, outcome, finished_at
    FROM app.union_filing_attempts WHERE state = ${state}
  `.execute(db);
  return result.rows;
}

type AfterHandler = (trx: Kysely<DB>) => Promise<void>;

async function fixture() {
  const account = String(await newAccount(APP_ID));
  const credentials = async () => ({
    appKey: APP_KEY,
    appSecret: SECRET,
    userOAuth: { redirectUri: USER_REDIRECT, inviterCode: INVITER_CODE, inviterAccountId: account },
  });
  const { adapter, clock, transport, warn } = setup({ credentials });
  const times = {
    created_at: new Date(clock.now().getTime() - 60_000),
    expire_at: new Date(clock.now().getTime() + 300_000),
  };
  const userId = await newUser({ app_id: APP_ID });
  const deviceId = randomUUID();
  await insertRow('devices', {
    id: deviceId,
    app_id: APP_ID,
    user_id: userId,
    platform: 'ios',
    install_secret_cipher: Buffer.from('fixture-ciphertext'),
  });

  expect(adapter.bindPublisher).toBeTypeOf('function');
  const governed = createGovernedAdapter(adapter, {
    endpoint,
    scheduler: systemScheduler(),
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: () => true },
  });
  const publisher = vi.fn(governed.bindPublisher?.bind(governed));
  let ready = true;
  // The carried-over implementation takes these options. The red baseline predates them.
  const exchanger: UnionBindingExchanger = Reflect.construct(UnionBindingExchanger, [
    () => publisher,
    {
      ready: () => ready,
      resolveApp: (ref: string, method: string) =>
        ref === APP_REF && method === 'web_code' ? OAUTH_APP : null,
    },
  ]);
  const warning = vi.fn();

  function bindings(db: Kysely<DB> = observer) {
    return db
      .selectFrom('union_bindings')
      .select(['app_id', 'user_id', 'platform', 'union_account_id', 'relation_id', 'status'])
      .where('app_id', '=', APP_ID)
      .where('user_id', '=', userId)
      .execute();
  }

  async function nextState(usedAt: Date | null = null): Promise<string> {
    const next = randomUUID();
    await app
      .insertInto('union_auth_sessions')
      .values({
        ...times,
        state: next,
        app_id: APP_ID,
        user_id: userId,
        device_id: deviceId,
        client: 'ios',
        platform: 'taobao',
        mode: 'bind',
        used_at: usedAt,
        auth_methods: ['web_code'],
        auth_app_refs: { web_code: APP_REF },
      })
      .execute();
    return next;
  }

  function submit(currentState: string, answer: Answer, afterHandler?: AfterHandler) {
    const methods: string[] = [];
    const visibleAtSave: Attempt[][] = [];
    const startedAt = clock.now();
    transport.mockImplementation(async ({ url, body }) => {
      if (url === TOKEN_ENDPOINT) {
        methods.push('oauth');
        return response(tokenAnswer());
      }
      const method = new URLSearchParams(body ?? '').get('method');
      methods.push(method ?? 'missing');
      if (method === SAVE) {
        visibleAtSave.push(await attempts(observer, currentState));
        if (answer === 'save_timeout') throw new Error('synthetic publisher.info.save timeout');
        if (answer === 'saved') return SAVED;
        if (answer === 'rejected') return REJECTED;
        return DUPLICATE;
      }
      if (method === GET) {
        if (answer === 'lookup_timeout') throw new Error('synthetic publisher.info.get timeout');
        return FOUND;
      }
      throw new Error('unexpected synthetic Taobao request');
    });

    const service = createUnionBindings({
      db: app,
      clock,
      callerContext: { current: async () => ({ appId: APP_ID, userId, deviceId }) },
      reads: {
        binding: async () => ({ status: 'unbound', accountId: null }),
        authAccountId: async () => account,
        siteAuthAvailable: async () => true,
        configuredMethods: async () => ['web_code'],
        userBanned: async () => false,
      },
      idempotency: {
        executeInTransaction: async (_request, handler) => {
          const { status, envelope } = await app.transaction().execute(async (trx) => {
            const result = await handler(trx);
            await afterHandler?.(trx);
            return result;
          });
          return { status, body: JSON.stringify(envelope), source: 'handler' };
        },
      },
      exchanger,
      logger: { warn: warning },
    });
    const reply = service.bind({
      platform: 'taobao',
      body: { state: currentState, auth_method: 'web_code', code: CODE },
      idempotencyKey: randomUUID(),
      traceId: randomUUID(),
    });
    return { reply, methods, visibleAtSave, currentState, startedAt };
  }

  return {
    account,
    bindings,
    clock,
    nextState,
    publisher,
    state: await nextState(),
    submit,
    userId,
    warn,
    warning,
    setReady(value: boolean) {
      ready = value;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Submission = ReturnType<Fixture['submit']>;

function expectStarted(f: Fixture, request: Submission, lookup = false): Attempt {
  expect(request.methods).toEqual(lookup ? ['oauth', SAVE, GET] : ['oauth', SAVE]);
  expect(request.visibleAtSave).toEqual([
    [
      expect.objectContaining({
        id: expect.any(String),
        app_id: APP_ID,
        user_id: f.userId,
        platform: 'taobao',
        union_account_id: f.account,
        state: request.currentState,
        started_at: request.startedAt,
        outcome: null,
        finished_at: null,
      }),
    ],
  ]);
  return request.visibleAtSave[0]![0]!;
}

function activeBinding(f: Fixture) {
  return {
    app_id: APP_ID,
    user_id: f.userId,
    platform: 'taobao',
    union_account_id: f.account,
    relation_id: RELATION,
    status: 'active',
  };
}

async function expectDuplicateUnverified(f: Fixture, request: Submission) {
  expect(await request.reply).toMatchObject({ status: 500, envelope: { code: 50001 } });
  const started = expectStarted(f, request, true);
  expect(await attempts(observer, request.currentState)).toEqual([
    { ...started, outcome: 'duplicate', finished_at: expect.any(Date) },
  ]);
  expect(await f.bindings()).toEqual([]);
  const warnings = [...f.warn.mock.calls, ...f.warning.mock.calls];
  expect(
    warnings.some(([fields]) =>
      [fields?.reason, fields?.failure, fields?.code].includes('duplicate_unverified'),
    ),
  ).toBe(true);
}

it('[AC-B1-04zzzzn#5] save 发出前独立连接已能读到备案尝试，传输超时后结局仍为空', async () => {
  await requireTable(TABLE);
  const f = await fixture();
  const request = f.submit(f.state, 'save_timeout');
  expect(await request.reply).toMatchObject({ envelope: { code: 50001 } });
  const started = expectStarted(f, request);
  expect(await attempts(observer, f.state)).toEqual([started]);
  expect(await f.bindings()).toEqual([]);
});

it.each([false, true])(
  '[AC-B1-04zzzzn#6] saved 和绑定在同一事务内提交或回滚（回滚=%s）',
  async (rollback) => {
    await requireTable(TABLE);
    const f = await fixture();
    const interrupted = new Error('synthetic interruption before local commit');
    const request = f.submit(f.state, 'saved', async (trx) => {
      expect(await attempts(trx, f.state)).toEqual([
        expect.objectContaining({ outcome: 'saved', finished_at: expect.any(Date) }),
      ]);
      expect(await f.bindings(trx)).toEqual([activeBinding(f)]);
      expect(await attempts(observer, f.state)).toEqual([
        expect.objectContaining({ outcome: null, finished_at: null }),
      ]);
      expect(await f.bindings()).toEqual([]);
      if (rollback) throw interrupted;
    });
    if (rollback) {
      await expect(request.reply).rejects.toBe(interrupted);
    } else {
      expect(await request.reply).toMatchObject({ status: 200, envelope: { code: 0 } });
    }
    const started = expectStarted(f, request);
    expect(await attempts(observer, f.state)).toEqual([
      rollback ? started : { ...started, outcome: 'saved', finished_at: expect.any(Date) },
    ]);
    expect(await f.bindings()).toEqual(rollback ? [] : [activeBinding(f)]);
  },
);

it.each([
  { answer: 'rejected', outcome: 'rejected', lookup: false },
  { answer: 'lookup_timeout', outcome: 'duplicate', lookup: true },
] as const)(
  '[AC-B1-04zzzzn#7] save 明确给出 $outcome 即记录结局和时间，本次没有绑定',
  async ({ answer, outcome, lookup }) => {
    await requireTable(TABLE);
    const f = await fixture();
    const request = f.submit(f.state, answer);
    expect((await request.reply).envelope.code).not.toBe(0);
    const started = expectStarted(f, request, lookup);
    expect(await attempts(observer, f.state)).toEqual([
      { ...started, outcome, finished_at: expect.any(Date) },
    ]);
    expect(await f.bindings()).toEqual([]);
  },
);

it('[AC-B1-04zzzzn#8] 同一归属更早的 save 结局未知，重复查询的编号可写入绑定', async () => {
  await requireTable(TABLE);
  const f = await fixture();
  const earlier = f.submit(f.state, 'save_timeout');
  expect((await earlier.reply).envelope.code).not.toBe(0);
  const unknown = expectStarted(f, earlier);
  f.clock.advanceMs(1000);
  const next = await f.nextState();
  const request = f.submit(next, 'duplicate');
  expect(await request.reply).toMatchObject({ status: 200, envelope: { code: 0 } });
  const started = expectStarted(f, request, true);
  expect(await f.bindings()).toEqual([activeBinding(f)]);
  expect(await attempts(observer, next)).toEqual([
    { ...started, outcome: 'duplicate', finished_at: expect.any(Date) },
  ]);
  expect(await attempts(observer, f.state)).toEqual([unknown]);
});

it('[AC-B1-04zzzzn#9] 本次请求自己的尝试不能证明重复查回的编号归属', async () => {
  await requireTable(TABLE);
  const f = await fixture();
  await expectDuplicateUnverified(f, f.submit(f.state, 'duplicate'));
});

it('[AC-B1-04zzzzn#10] 更早明确返回重复的尝试不能证明重复查回的编号归属', async () => {
  await requireTable(TABLE);
  const f = await fixture();
  await expectDuplicateUnverified(f, f.submit(f.state, 'duplicate'));
  f.clock.advanceMs(1000);
  f.warning.mockClear();
  f.warn.mockClear();
  await expectDuplicateUnverified(f, f.submit(await f.nextState(), 'duplicate'));
});

it('[AC-B1-04zzzzn#11] 没有真实备案能力时返回 auth_unavailable，恢复后同一 state 仍可绑定', async () => {
  const f = await fixture();
  f.setReady(false);
  const refused = f.submit(f.state, 'saved');
  expect(await refused.reply).toMatchObject({
    status: 422,
    envelope: { code: 30101, data: { reason: 'auth_unavailable' } },
  });
  expect(refused.methods).toEqual([]);
  expect(f.publisher).not.toHaveBeenCalled();
  const session = await observer
    .selectFrom('union_auth_sessions')
    .select('used_at')
    .where('state', '=', f.state)
    .executeTakeFirst();
  expect(session).toEqual({ used_at: null });
  expect(await f.bindings()).toEqual([]);
  await requireTable(TABLE);
  expect(await attempts(observer, f.state)).toEqual([]);

  f.setReady(true);
  const retried = f.submit(f.state, 'saved');
  expect(await retried.reply).toMatchObject({ status: 200, envelope: { code: 0 } });
  expectStarted(f, retried);
  expect(await f.bindings()).toEqual([activeBinding(f)]);
});

it.each(['其他联盟账号', '其他用户', '开始时间更晚'] as const)(
  '[AC-B1-04zzzzn#12] 结局未知的尝试属于%s时，不能用作重复查回的凭据',
  async (scenario) => {
    await requireTable(TABLE);
    const f = await fixture();
    const offset = scenario === '开始时间更晚' ? 1000 : -1000;
    const startedAt = new Date(f.clock.now().getTime() + offset);
    const session =
      scenario === '其他用户'
        ? await newAuth({
            created_at: new Date(startedAt.getTime() - 1000),
            expire_at: new Date(startedAt.getTime() + 60_000),
            used_at: startedAt,
          })
        : { state: await f.nextState(startedAt), user_id: f.userId };
    const account = scenario === '其他联盟账号' ? await newAccount(APP_ID) : f.account;
    await sql`
      INSERT INTO app.union_filing_attempts
        (id, app_id, user_id, platform, union_account_id, state, started_at, outcome, finished_at)
      VALUES (${randomUUID()}, ${APP_ID}, ${session['user_id']}, 'taobao', ${account},
        ${session['state']}, ${startedAt}, NULL, NULL)
    `.execute(app);

    await expectDuplicateUnverified(f, f.submit(f.state, 'duplicate'));
  },
);
