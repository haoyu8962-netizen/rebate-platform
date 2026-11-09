// Unit tests of POST /v1/auth/merge's refusals before anything is written (B1-20c; no database): a
// fake Kysely driver answers the reads by their SQL, the ticket store is an in-memory stub. The
// merge itself runs against PostgreSQL and Redis in the rule tests (test/spec/identity/merge-account).
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import {
  FixedClock,
  RedisUnavailableError,
  type FieldCrypto,
  type RedisHandle,
  type RootLogger,
} from '../../platform/index.ts';
import type { TokenService } from './access-tokens.ts';
import { mergeTicketKey } from './bind-phone.ts';
import {
  createMergeAccountService,
  retryOnDeadlock,
  type MergeAccountCommand,
  type MergeAccountResult,
} from './merge-account.ts';

const APP = 'couli';
const SOURCE = '019a0000-0000-7000-8000-0000000000a1';
const TARGET = '019a0000-0000-7000-8000-0000000000b1';
const NUMBER_HMAC = 'hmac-of-the-number';
const TICKET = 'a'.repeat(64);

type Respond = (query: CompiledQuery) => readonly unknown[];

class FakeConnection implements DatabaseConnection {
  constructor(
    private readonly respond: Respond,
    private readonly queries: CompiledQuery[],
  ) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    this.queries.push(query);
    return { rows: this.respond(query) } as QueryResult<R>;
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('streamQuery is not used');
  }
}

class FakeDriver implements Driver {
  constructor(
    private readonly connection: FakeConnection,
    private readonly events: string[],
  ) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }
  async beginTransaction(): Promise<void> {
    this.events.push('begin');
  }
  async commitTransaction(): Promise<void> {
    this.events.push('commit');
  }
  async rollbackTransaction(): Promise<void> {
    this.events.push('rollback');
  }
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

interface Scenario {
  /** The stored ticket value; null: no ticket; 'down': the store is unavailable. */
  readonly stored: string | null | 'down';
  /** The target found by the number before the lock. */
  readonly found?: boolean;
  /** The target's number under the lock. */
  readonly lockedHmac?: string;
  /** The target's users.status under the lock (default normal). */
  readonly lockedStatus?: string;
  /** The request's session under the lock: live (default), revoked or gone. */
  readonly session?: 'live' | 'revoked' | 'missing';
  /** Users risk reads as banned (risk's fresh state). */
  readonly banned?: readonly string[];
  /** withdraw.dormant_reverify_days; absent: off. */
  readonly days?: number;
  /** The target last active long ago on another device, not flagged. */
  readonly dormant?: boolean;
}

interface Run {
  readonly result: MergeAccountResult;
  readonly queries: readonly CompiledQuery[];
  readonly events: readonly string[];
  readonly evals: number;
  readonly locks: number;
  readonly keys: readonly string[];
  readonly banChecks: readonly string[];
}

const ticketOf = (value: Record<string, unknown>) => JSON.stringify(value);
const NOW = '2026-11-09T00:00:00Z';
const LONG_AGO = new Date('2026-01-01T00:00:00Z');

function harness(scenario: Scenario) {
  const queries: CompiledQuery[] = [];
  const events: string[] = [];
  const respond: Respond = (query) => {
    const text = query.sql;
    events.push(text);
    if (/^(savepoint|rollback to savepoint|release savepoint)/i.test(text)) return [];
    if (text.includes('pg_advisory_xact_lock')) return [];
    if (/^update /i.test(text)) return [];
    if (text.includes('"last_active_at"') && text.includes('for no key update')) {
      const locked = {
        status: scenario.lockedStatus ?? 'normal',
        phone_hmac: scenario.lockedHmac ?? NUMBER_HMAC,
      };
      return [
        scenario.dormant === true
          ? {
              ...locked,
              last_active_at: LONG_AGO,
              last_login_device_hash: 'another-device',
              reverify_flagged_at: null,
            }
          : {
              ...locked,
              last_active_at: new Date(NOW),
              last_login_device_hash: 'dev',
              reverify_flagged_at: null,
            },
      ];
    }
    if (text.includes('from "app"."users"') && text.includes('for no key update')) {
      return [{ id: SOURCE }, { id: TARGET }];
    }
    if (text.includes('from "app"."users"') && text.includes('"phone_hmac" =')) {
      return scenario.found === false ? [] : [{ id: TARGET }];
    }
    if (text.includes('from "app"."users"') && text.includes('"parent_id" =')) return [];
    if (text.includes('from "app"."users"') && text.includes('"id" in')) {
      return [
        {
          id: SOURCE,
          register_method: 'wechat',
          phone_hmac: null,
          parent_id: null,
          status: 'normal',
          parent_bind_source: null,
        },
        {
          id: TARGET,
          register_method: 'sms',
          phone_hmac: scenario.lockedHmac ?? NUMBER_HMAC,
          parent_id: null,
          status: 'normal',
          parent_bind_source: null,
        },
      ];
    }
    if (text.includes('"sessions"')) {
      const session = scenario.session ?? 'live';
      if (session === 'missing') return [];
      return [{ revoked_at: session === 'revoked' ? new Date(NOW) : null }];
    }
    if (text.includes('"deletion_requests"')) {
      return [{ id: TARGET, status: 'normal', request_status: null }];
    }
    if (text.includes('"user_oauth"') || text.includes('"realname"')) return [];
    if (text.includes('"devices"')) return [{ device_hash: 'dev' }];
    throw new Error(`unexpected query: ${text}`);
  };
  const connection = new FakeConnection(respond, queries);
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new FakeDriver(connection, events),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const counters = { evals: 0, locks: 0 };
  const keys: string[] = [];
  const banChecks: string[] = [];
  const redis = {
    namespace: () => ({
      get: (key: string) => {
        keys.push(key);
        if (scenario.stored === 'down') {
          return Promise.reject(new RedisUnavailableError('command_failed'));
        }
        return Promise.resolve(scenario.stored);
      },
      set: () => Promise.resolve(),
      eval: () => {
        counters.evals += 1;
        return Promise.resolve(1);
      },
    }),
    close: () => Promise.resolve(),
    onApplicationShutdown: () => Promise.resolve(),
  } satisfies RedisHandle;
  const refuse = () => Promise.reject(new Error('not reached'));
  const service = createMergeAccountService({
    db,
    clock: new FixedClock(NOW),
    crypto: {} as FieldCrypto,
    tokens: {} as TokenService,
    redis,
    logger: { info: () => undefined, warn: () => undefined } as unknown as RootLogger,
    assets: {
      countOrders: () => Promise.resolve(0),
      hasClaims: () => Promise.resolve(false),
      hasLedgerEntries: () => Promise.resolve(false),
    },
    risk: {
      isBanned: (_db, account) => {
        banChecks.push(account.user_id);
        return Promise.resolve((scenario.banned ?? []).includes(account.user_id));
      },
    },
    merge: {
      hasAdjustments: () => Promise.resolve(false),
      hasDisabledBindings: () => Promise.resolve(false),
      lockRelationWrites: () => {
        counters.locks += 1;
        return Promise.resolve();
      },
      releaseBindings: refuse,
    },
  });
  const command: MergeAccountCommand = {
    app_id: APP,
    user_id: SOURCE,
    device_id: 'device-1',
    platform: 'ios',
    client_ip: '192.0.2.1',
    merge_ticket: TICKET,
    sid: 'sid-of-the-request',
    dormantReverifyDays: scenario.days,
  };
  return { db, service, command, queries, events, counters, keys, banChecks };
}

async function run(scenario: Scenario): Promise<Run> {
  const h = harness(scenario);
  const result = await h.db.transaction().execute((trx) => h.service.merge(trx, h.command));
  return {
    result,
    queries: h.queries,
    events: h.events,
    evals: h.counters.evals,
    locks: h.counters.locks,
    keys: h.keys,
    banChecks: h.banChecks,
  };
}

const writes = (queries: readonly CompiledQuery[]) =>
  queries.filter((query) => /^(update|insert|delete)/i.test(query.sql));

const own = ticketOf({ app_id: APP, uid: SOURCE, phone_hmac: NUMBER_HMAC });

it('[B1-20c] ticket 按 SHA-256 键读取；不存在 → 30411，不读库、不加锁、不核销', async () => {
  const { result, queries, evals, keys } = await run({ stored: null });
  expect(result).toEqual({ code: 30411 });
  expect(keys).toEqual([mergeTicketKey(TICKET)]);
  expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
  expect(queries).toEqual([]);
  expect(evals).toBe(0);
});

it('[B1-20c] ticket 存储不可用 → 50001，不读库', async () => {
  const { result, queries, evals } = await run({ stored: 'down' });
  expect(result).toEqual({ code: 50001 });
  expect(queries).toEqual([]);
  expect(evals).toBe(0);
});

for (const [label, stored] of [
  ['别人的票（uid 不符）', ticketOf({ app_id: APP, uid: TARGET, phone_hmac: NUMBER_HMAC })],
  ['别的 App 的票', ticketOf({ app_id: `${APP}_other`, uid: SOURCE, phone_hmac: NUMBER_HMAC })],
  ['值不是 JSON', 'not-json'],
  ['值缺字段', ticketOf({ app_id: APP, uid: SOURCE })],
] as const) {
  it(`[B1-20c] ${label} → 30411，不读库、不删票`, async () => {
    const { result, queries, evals } = await run({ stored });
    expect(result).toEqual({ code: 30411 });
    expect(queries).toEqual([]);
    expect(evals).toBe(0);
  });
}

it('[B1-20c] 号码已无账号持有 → 30411，只读一次、不加锁', async () => {
  const { result, queries, evals, locks } = await run({ stored: own, found: false });
  expect(result).toEqual({ code: 30411 });
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toMatch(/^select /);
  expect(locks).toBe(0);
  expect(evals).toBe(0);
});

it('[B1-20c] 锁后目标已不持有票里的号码 → 30411；锁序为 users 行 → 同意锁 → 关系锁，之后只读、不写、不核销', async () => {
  const { result, queries, evals, locks } = await run({ stored: own, lockedHmac: 'moved' });
  expect(result).toEqual({ code: 30411 });
  expect(locks).toBe(1);
  expect(evals).toBe(0);
  const userLock = queries.findIndex((query) => query.sql.includes('for no key update'));
  const consentLock = queries.findIndex((query) => query.sql.includes('pg_advisory_xact_lock'));
  expect(userLock).toBeGreaterThan(0);
  expect(consentLock).toBeGreaterThan(userLock);
  expect(queries[userLock]!.parameters).toContainEqual([SOURCE, TARGET]);
  for (const query of queries) expect(query.sql).toMatch(/^select /i);
});

it('[B1-20c] review r1 S0 锁后源账号已被封禁（封禁事务先拿到源行锁并提交）→ 30411，不写、不核销；源与目标都按同一读法判风控', async () => {
  const { result, queries, evals, banChecks } = await run({ stored: own, banned: [SOURCE] });
  expect(result).toEqual({ code: 30411 });
  expect(banChecks).toContain(SOURCE);
  expect(writes(queries)).toEqual([]);
  expect(evals).toBe(0);
});

it('[B1-20c] review r1 S0 源未封禁、目标封禁 → 30411；先判源、再判目标（同一 AccountRiskPort 读法）', async () => {
  const { result, queries, evals, banChecks } = await run({ stored: own, banned: [TARGET] });
  expect(result).toEqual({ code: 30411 });
  expect(banChecks).toEqual([SOURCE, TARGET]);
  expect(writes(queries)).toEqual([]);
  expect(evals).toBe(0);
});

for (const session of ['revoked', 'missing'] as const) {
  it(`[B1-20c] review r1 S0 锁后本请求的会话已${session === 'revoked' ? '吊销' : '不存在'} → 10002，不写、不核销`, async () => {
    const { result, queries, evals, banChecks } = await run({ stored: own, session });
    expect(result).toEqual({ code: 10002 });
    const sessionRead = queries.findIndex((query) => query.sql.includes('"sessions"'));
    const userLock = queries.findIndex((query) => query.sql.includes('= ANY('));
    expect(sessionRead).toBeGreaterThan(userLock);
    expect(userLock).toBeGreaterThanOrEqual(0);
    expect(banChecks).toEqual([]);
    expect(writes(queries)).toEqual([]);
    expect(evals).toBe(0);
  });
}

it('[B1-20c] review r1 S1 judgeTarget：开关开、目标满足待加验 → 在自己的短事务里锁目标行、只写标记并提交（不写活跃值）', async () => {
  const h = harness({ stored: own, days: 90, dormant: true });
  await h.service.judgeTarget(h.command);
  const updates = writes(h.queries);
  expect(updates).toHaveLength(1);
  expect(updates[0]!.sql).toContain('"reverify_flagged_at" =');
  expect(updates[0]!.sql).toContain('"reverify_trusted" =');
  expect(updates[0]!.sql).not.toContain('"last_active_at" =');
  expect(updates[0]!.sql).toContain('"reverify_flagged_at" is null');
  // r2 S1: the UPDATE repeats the locked checks on the row itself.
  expect(updates[0]!.sql).toContain('"phone_hmac" =');
  expect(updates[0]!.parameters).toContain(NUMBER_HMAC);
  const lock = h.queries.find(
    (query) => query.sql.includes('"last_active_at"') && query.sql.includes('for no key update'),
  );
  expect(lock?.sql).toContain('"phone_hmac"');
  expect(lock?.sql).toContain('"status"');
  const begin = h.events.indexOf('begin');
  const update = h.events.indexOf(updates[0]!.sql);
  const commit = h.events.indexOf('commit');
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(update).toBeGreaterThan(begin);
  expect(commit).toBeGreaterThan(update);
  expect(h.events).not.toContain('rollback');
  expect(h.counters.evals).toBe(0);
});

for (const [label, scenario] of [
  ['开关关', { stored: own, dormant: true }],
  [
    '票属于别人',
    {
      stored: ticketOf({ app_id: APP, uid: TARGET, phone_hmac: NUMBER_HMAC }),
      days: 90,
      dormant: true,
    },
  ],
  ['票不存在', { stored: null, days: 90, dormant: true }],
  ['存储不可用（不抛出，交给并号事务）', { stored: 'down', days: 90, dormant: true }],
  ['目标不满足待加验', { stored: own, days: 90 }],
] as const satisfies readonly (readonly [string, Scenario])[]) {
  it(`[B1-20c] review r1 S1 judgeTarget：${label} → 不打标`, async () => {
    const h = harness(scenario);
    await h.service.judgeTarget(h.command);
    expect(writes(h.queries)).toEqual([]);
  });
}

it('[B1-20c] review r1 S1 并号事务里目标仍「该打标而未打标」（judgeTarget 没跑成）→ 50001，回滚到 savepoint，不迁移、不核销', async () => {
  const { result, queries, events, evals } = await run({ stored: own, days: 90, dormant: true });
  expect(result).toEqual({ code: 50001 });
  expect(writes(queries)).toEqual([]);
  expect(events.some((text) => /^rollback to savepoint/i.test(text))).toBe(true);
  expect(evals).toBe(0);
});

it('[B1-20c] review r1 S2 retryOnDeadlock：40P01 只重试一次；别的错误不重试', async () => {
  const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
  let calls = 0;
  await expect(
    retryOnDeadlock(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(deadlock) : Promise.resolve('ok');
    }),
  ).resolves.toBe('ok');
  expect(calls).toBe(2);

  calls = 0;
  await expect(
    retryOnDeadlock(() => {
      calls += 1;
      return Promise.reject(deadlock);
    }),
  ).rejects.toBe(deadlock);
  expect(calls).toBe(2);

  calls = 0;
  const other = Object.assign(new Error('unique'), { code: '23505' });
  await expect(
    retryOnDeadlock(() => {
      calls += 1;
      return Promise.reject(other);
    }),
  ).rejects.toBe(other);
  expect(calls).toBe(1);
});

for (const [label, scenario] of [
  ['号码在等锁期间被改走（锁后 phone_hmac 不再是票里的号码）', { lockedHmac: 'moved-number' }],
  ['账号在等锁期间进入注销（锁后 status=deleting）', { lockedStatus: 'deleting' }],
  ['账号在等锁期间已注销（锁后 status=deleted）', { lockedStatus: 'deleted' }],
] as const) {
  it(`[B1-20c] review r2 S1 judgeTarget：锁前按号码找到目标，${label} → 不打标、不写任何行，短事务照常结束`, async () => {
    const h = harness({ stored: own, days: 90, dormant: true, ...scenario });
    await h.service.judgeTarget(h.command);
    expect(writes(h.queries)).toEqual([]);
    expect(h.events).toContain('commit');
    expect(h.events).not.toContain('rollback');
    expect(h.counters.evals).toBe(0);
  });
}
