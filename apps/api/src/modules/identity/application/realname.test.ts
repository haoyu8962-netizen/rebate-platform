// Unit tests of the daily attempt count per Idempotency-Key (B1-13d money review r1 S1). The
// database is a scripted Kysely driver and Redis a stand-in that applies the two scripts' rules;
// the scripts themselves run against real Redis in test/spec/identity/realname/**.
import { createHash } from 'node:crypto';
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
import { expect, it, vi } from 'vitest';
import {
  FixedClock,
  type FieldCrypto,
  type RedisHandle,
  type RedisScriptOptions,
} from '../../platform/index.ts';
import type { RealnameVerificationResult } from '../ports/realname-verifier.ts';
import {
  MARK_LIFETIME_MS,
  REALNAME_PENDING_LEASE_MS,
  RECORD_SCRIPT,
  RELEASE_SCRIPT,
  RESERVE_SCRIPT,
  attemptTtlSeconds,
  createRealnameAttempts,
} from './realname-attempts.ts';
import { createRealnameService } from './realname.ts';
import type { ReverifyGate } from './reverify-gate.ts';
import type { SmsConfigReader } from './sms-codes.ts';

const NOW = '2026-09-29T10:00:00.000Z';
const APP = 'couli';
const USER = '019a0000-0000-7000-8000-000000000042';
const DEVICE = '019a0000-0000-7000-8000-000000000043';
const COUNT_KEY = `${APP}:2026-09-29:${USER}`;
// A syntactically valid resident ID (check digit X) and a name; synthetic.
const BODY = { name: '测试姓名', idNo: '11010519491231002X' };

interface Row {
  status: string;
  name_cipher: Buffer | null;
}

/** Answers the service's statements from `state`; `failWrites` makes the next realname writes throw. */
function scriptedDb(state: { row: Row | undefined; failWrites: number }): Kysely<DB> {
  const answer = (query: CompiledQuery): QueryResult<unknown> => {
    const { sql, parameters } = query;
    if (sql.includes('from "app"."consent_records"')) return { rows: [{ accepted: true }] };
    if (sql.startsWith('select "status", "name_cipher" from "app"."realname"')) {
      return { rows: state.row === undefined ? [] : [state.row] };
    }
    if (sql.startsWith('select "id" from "app"."realname"')) return { rows: [] };
    if (sql.startsWith('insert into "app"."realname"')) {
      if (state.failWrites > 0) {
        state.failWrites -= 1;
        throw new Error('connection terminated');
      }
      if (parameters.includes('verified')) {
        const name = parameters.find(
          (p) => Buffer.isBuffer(p) && p.toString('utf8').startsWith('enc:realname.name:'),
        ) as Buffer;
        state.row = { status: 'verified', name_cipher: name };
        return { rows: [{ id: 'row' }] };
      }
      state.row = { status: 'failed', name_cipher: null };
      return { rows: [] };
    }
    throw new Error(`unexpected statement ${sql}`);
  };
  const connection: DatabaseConnection = {
    executeQuery: <R>(query: CompiledQuery) =>
      Promise.resolve().then(() => answer(query) as QueryResult<R>),
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

/** Applies the three scripts' rules to an in-memory map; records each call. */
function scriptedRedis() {
  const store = new Map<string, string>();
  const faults = { record: false };
  const markExpiries: number[] = [];
  const calls: { script: string; options: RedisScriptOptions }[] = [];
  const handle: RedisHandle = {
    namespace: () => ({
      get: (key) => Promise.resolve(store.get(key) ?? null),
      set: (key, value) => {
        store.set(key, value);
        return Promise.resolve();
      },
      eval: (script, options) => {
        calls.push({ script, options });
        const [count, mark] = options.keys as [string, string];
        const n = Number(store.get(count) ?? '0');
        const [now, lifetime] = options.args.map(Number) as [number, number];
        const setMark = (day: string, at: string, state: string) => {
          store.set(mark, `${day}|${at}|${state}`);
          // Absolute expiry instant of this write (the scripts' markTtl, whole seconds).
          markExpiries.push(
            now + Math.max(1, Math.ceil((Number(at) + lifetime - now) / 1000)) * 1000,
          );
        };
        const parsed = /^([^|]*)\|(\d+)\|(.+)$/.exec(store.get(mark) ?? '');
        if (script === RESERVE_SCRIPT) {
          const [limit, lease] = options.args.slice(2).map(Number) as [number, number];
          if (store.has(mark)) {
            if (parsed === null) return Promise.resolve('expired');
            const [, day, at, state] = parsed as unknown as [string, string, string, string];
            if (state === 'pending' && now - Number(at) >= lease) {
              setMark(day, at, 'expired');
              return Promise.resolve('expired');
            }
            return Promise.resolve(state);
          }
          if (n >= limit) return Promise.resolve(0);
          store.set(count, String(n + 1));
          setMark(options.args[4]!, String(now), 'pending');
          return Promise.resolve(1);
        }
        if (script === RECORD_SCRIPT) {
          if (faults.record) return Promise.reject(new Error('redis down'));
          if (parsed === null || parsed[3] !== 'pending') return Promise.resolve(0);
          setMark(parsed[1]!, parsed[2]!, options.args[2]!);
          return Promise.resolve(1);
        }
        if (script === RELEASE_SCRIPT) {
          if (!store.delete(mark)) return Promise.resolve(0);
          if (n <= 0) return Promise.resolve(0);
          store.set(count, String(n - 1));
          return Promise.resolve(1);
        }
        return Promise.reject(new Error('unknown script'));
      },
    }),
    close: () => Promise.resolve(),
    onApplicationShutdown: () => Promise.resolve(),
  };
  return { handle, store, calls, faults, markExpiries };
}

const crypto: FieldCrypto = {
  currentKeyVersion: 1,
  encrypt: (plain, context) => `enc:${context}:${plain}`,
  decrypt: (cipher, context) => cipher.slice(`enc:${context}:`.length),
  keyVersionOf: () => 1,
  needsReencrypt: () => false,
  reencrypt: (cipher) => cipher,
  blindIndex: (value, context) => createHash('sha256').update(`${context}|${value}`).digest('hex'),
};

function setup(config?: SmsConfigReader | null) {
  const state: { row: Row | undefined; failWrites: number } = { row: undefined, failWrites: 0 };
  const redis = scriptedRedis();
  const verify = vi.fn<() => Promise<RealnameVerificationResult>>();
  const clock = new FixedClock(NOW);
  const gate = vi.fn<ReverifyGate['check']>(() => Promise.resolve(null));
  const logs: { level: string; fields: unknown; msg: unknown }[] = [];
  const service = createRealnameService({
    db: scriptedDb(state),
    clock,
    crypto,
    redis: redis.handle,
    verifier: { verify },
    logger: {
      info: (fields: unknown, msg?: unknown) => void logs.push({ level: 'info', fields, msg }),
      warn: (fields: unknown, msg?: unknown) => void logs.push({ level: 'warn', fields, msg }),
    } as Parameters<typeof createRealnameService>[0]['logger'],
    reverify: { check: gate },
    ...(config === undefined ? {} : { config }),
  });
  const submit = (idempotencyKey: string, name: string = BODY.name, idNo: string = BODY.idNo) =>
    service.submit({
      appId: APP,
      userId: USER,
      deviceId: DEVICE,
      name,
      idNo,
      idempotencyKey,
    });
  return { state, redis, verify, clock, submit, gate, logs };
}

/** Redis keys and values must carry neither the raw key nor the submitted values. */
function expectNoPlainData(store: Map<string, string>, ...keys: string[]) {
  const text = [...store.keys(), ...store.values()].join('\n');
  for (const secret of [BODY.name, BODY.idNo, ...keys]) expect(text).not.toContain(secret);
}

it('[AC-B1-13d][BR-ID-25] a retry after a failed verified write replays the match: no vendor call, no count', async () => {
  const t = setup();
  t.verify.mockResolvedValue({ outcome: 'match', provider: 'unit' });
  t.state.failWrites = 1;
  await expect(t.submit('key-aaaaaaaa')).rejects.toThrow('connection terminated');
  expect(t.redis.store.get(COUNT_KEY)).toBe('1');
  await expect(t.submit('key-aaaaaaaa')).resolves.toEqual({
    code: 0,
    data: { realname_status: 'verified', masked_name: '***名' },
  });
  expect(t.redis.store.get(COUNT_KEY)).toBe('1');
  expect(t.verify).toHaveBeenCalledTimes(1);
  expectNoPlainData(t.redis.store, 'key-aaaaaaaa');
});

it('[AC-B1-13d][BR-ID-25] a retry after a failed failed-row write replays the mismatch within the limit', async () => {
  const t = setup();
  t.verify.mockResolvedValue({ outcome: 'mismatch', provider: 'unit' });
  await expect(t.submit('key-1111111a')).resolves.toEqual({ code: 30406 });
  await expect(t.submit('key-2222222b')).resolves.toEqual({ code: 30406 });
  t.state.failWrites = 1;
  await expect(t.submit('key-3333333c')).rejects.toThrow('connection terminated');
  expect(t.redis.store.get(COUNT_KEY)).toBe('3');
  await expect(t.submit('key-3333333c')).resolves.toEqual({ code: 30406 });
  expect(t.state.row?.status).toBe('failed');
  expect(t.redis.store.get(COUNT_KEY)).toBe('3');
  expect(t.verify).toHaveBeenCalledTimes(3);
});

it('[AC-B1-13d][BR-ID-25] once the day is full neither the same nor a new key calls the vendor', async () => {
  const t = setup();
  t.verify.mockResolvedValue({ outcome: 'mismatch', provider: 'unit' });
  for (const key of ['key-1111111a', 'key-2222222b', 'key-3333333c']) {
    await expect(t.submit(key)).resolves.toEqual({ code: 30406 });
  }
  await expect(t.submit('key-3333333c')).resolves.toEqual({ code: 30406 });
  await expect(t.submit('key-4444444d')).resolves.toEqual({ code: 30410 });
  expect(t.redis.store.get(COUNT_KEY)).toBe('3');
  expect(t.verify).toHaveBeenCalledTimes(3);
});

it('[AC-B1-13d][BR-ID-25] the same key with other values is another request (counted, verified anew)', async () => {
  const t = setup();
  t.verify.mockResolvedValue({ outcome: 'mismatch', provider: 'unit' });
  await expect(t.submit('key-eeeeeeee')).resolves.toEqual({ code: 30406 });
  t.verify.mockResolvedValue({ outcome: 'match', provider: 'unit' });
  await expect(t.submit('key-eeeeeeee', '另一姓名')).resolves.toMatchObject({ code: 0 });
  expect(t.redis.store.get(COUNT_KEY)).toBe('2');
  expect(t.verify).toHaveBeenCalledTimes(2);
});

it('[AC-B1-13d][BR-ID-25] after 50401 the same key reserves again and finally counts once', async () => {
  const t = setup();
  t.verify.mockResolvedValueOnce({ outcome: 'timeout' });
  await expect(t.submit('key-bbbbbbbb')).resolves.toEqual({ code: 50401 });
  expect(t.redis.store.get(COUNT_KEY)).toBe('0');
  expect([...t.redis.store.keys()]).toEqual([COUNT_KEY]);
  t.verify.mockResolvedValueOnce({ outcome: 'mismatch', provider: 'unit' });
  await expect(t.submit('key-bbbbbbbb')).resolves.toEqual({ code: 30406 });
  expect(t.redis.store.get(COUNT_KEY)).toBe('1');
  expect(t.redis.calls.map((c) => c.script)).toEqual([
    RESERVE_SCRIPT,
    RELEASE_SCRIPT,
    RESERVE_SCRIPT,
    RECORD_SCRIPT,
  ]);
});

it('[AC-B1-13d][BR-ID-25] a pending mark: 50401 within its lease, then terminal expired; never a call or a give-back', async () => {
  const t = setup();
  // The first attempt never returns from the vendor (as if the process died): its mark stays pending.
  t.verify.mockImplementationOnce(() => new Promise<never>(() => undefined));
  void t.submit('key-cccccccc');
  await vi.waitFor(() => expect(t.verify).toHaveBeenCalledTimes(1));
  const marks = () => [...t.redis.store.entries()].filter(([key]) => key.startsWith('seen:'));
  const pending = `2026-09-29|${String(Date.parse(NOW))}|pending`;
  expect(marks().map(([, value]) => value)).toEqual([pending]);
  // Within the lease: 50401, nothing changes.
  t.clock.set(new Date(Date.parse(NOW) + REALNAME_PENDING_LEASE_MS - 1).toISOString());
  for (let i = 0; i < 2; i++) {
    await expect(t.submit('key-cccccccc')).resolves.toEqual({ code: 50401 });
    expect(t.verify).toHaveBeenCalledTimes(1);
    expect(t.redis.store.get(COUNT_KEY)).toBe('1');
    expect(marks().map(([, value]) => value)).toEqual([pending]);
  }
  // At the end of the lease the mark turns terminal: still 50401, no call, nothing given back.
  t.clock.set(new Date(Date.parse(NOW) + REALNAME_PENDING_LEASE_MS).toISOString());
  for (let i = 0; i < 2; i++) {
    await expect(t.submit('key-cccccccc')).resolves.toEqual({ code: 50401 });
    expect(t.verify).toHaveBeenCalledTimes(1);
    expect(t.redis.store.get(COUNT_KEY)).toBe('1');
    expect(marks().map(([, value]) => value)).toEqual([
      `2026-09-29|${String(Date.parse(NOW))}|expired`,
    ]);
  }
  expect(t.redis.calls.map((c) => c.script)).not.toContain(RELEASE_SCRIPT);
  // A new key is a new request under the normal count.
  t.verify.mockResolvedValueOnce({ outcome: 'mismatch', provider: 'unit' });
  await expect(t.submit('key-ffffffff')).resolves.toEqual({ code: 30406 });
  expect(t.redis.store.get(COUNT_KEY)).toBe('2');
  expect(t.verify).toHaveBeenCalledTimes(2);
});

it('[AC-B1-13d][BR-ID-25] outcome not kept and write failed: the retry is pending (50401), never a second call', async () => {
  const t = setup();
  t.verify.mockResolvedValue({ outcome: 'match', provider: 'unit' });
  t.redis.faults.record = true;
  t.state.failWrites = 1;
  await expect(t.submit('key-gggggggg')).rejects.toThrow('connection terminated');
  t.redis.faults.record = false;
  await expect(t.submit('key-gggggggg')).resolves.toEqual({ code: 50401 });
  expect(t.verify).toHaveBeenCalledTimes(1);
  expect(t.redis.store.get(COUNT_KEY)).toBe('1');
});

it('[AC-B1-13d][BR-ID-25] record() never recreates a missing mark nor touches the count', async () => {
  const redis = scriptedRedis();
  const attempts = createRealnameAttempts(redis.handle);
  const slot = {
    appId: APP,
    userId: USER,
    day: '2026-09-29',
    idempotencyKey: 'key-hhhhhhhh',
    requestDigest: 'digest',
  };
  const now = new FixedClock(NOW).now();
  await attempts.record(slot, { kind: 'match', provider: 'unit' }, now);
  expect([...redis.store.keys()]).toEqual([]);
});

it("[AC-B1-13d][BR-ID-25] 23:59 outcome kept, write failed; the 00:01 same-key retry replays it on no day's count", async () => {
  const t = setup();
  const nextDay = `${APP}:2026-09-30:${USER}`;
  t.clock.set('2026-09-29T15:59:00.000Z');
  t.verify.mockResolvedValue({ outcome: 'match', provider: 'unit' });
  t.state.failWrites = 1;
  await expect(t.submit('key-iiiiiiii')).rejects.toThrow('connection terminated');
  t.clock.set('2026-09-29T16:01:00.000Z');
  await expect(t.submit('key-iiiiiiii')).resolves.toMatchObject({ code: 0 });
  expect(t.verify).toHaveBeenCalledTimes(1);
  expect(t.redis.store.get(COUNT_KEY)).toBe('1');
  expect(t.redis.store.has(nextDay)).toBe(false);
  // The mark keeps the expiry of its first write (48 h), whatever later writes did.
  expect(new Set(t.redis.markExpiries)).toEqual(
    new Set([Date.parse('2026-09-29T15:59:00.000Z') + MARK_LIFETIME_MS]),
  );
});

it('[AC-B1-13d][BR-ID-25] 23:59 attempt died pending; the 00:01 same-key retry is 50401, a new key counts on the new day', async () => {
  const t = setup();
  const nextDay = `${APP}:2026-09-30:${USER}`;
  t.clock.set('2026-09-29T15:59:00.000Z');
  t.verify.mockImplementationOnce(() => new Promise<never>(() => undefined));
  void t.submit('key-jjjjjjjj');
  await vi.waitFor(() => expect(t.verify).toHaveBeenCalledTimes(1));
  t.clock.set('2026-09-29T16:01:00.000Z');
  for (let i = 0; i < 2; i++) {
    await expect(t.submit('key-jjjjjjjj')).resolves.toEqual({ code: 50401 });
  }
  expect(t.verify).toHaveBeenCalledTimes(1);
  expect(t.redis.store.get(COUNT_KEY)).toBe('1');
  expect(t.redis.store.has(nextDay)).toBe(false);
  t.verify.mockResolvedValueOnce({ outcome: 'mismatch', provider: 'unit' });
  await expect(t.submit('key-kkkkkkkk')).resolves.toEqual({ code: 30406 });
  expect(t.redis.store.get(nextDay)).toBe('1');
  expect(t.redis.store.get(COUNT_KEY)).toBe('1');
  expect(t.verify).toHaveBeenCalledTimes(2);
});

it('[AC-B1-13d][BR-ID-25] writes of one day key expire at one instant: the window never extends', async () => {
  const at = (iso: string) => new FixedClock(iso).now();
  const instants = [
    '2026-09-28T16:00:00.000Z',
    '2026-09-29T10:00:00.000Z',
    '2026-09-29T15:59:59.000Z',
  ].map((iso) => at(iso).getTime() + attemptTtlSeconds('2026-09-29', at(iso)) * 1000);
  expect(new Set(instants).size).toBe(1);
  // End of the +08:00 day 2026-09-29 plus one day of grace.
  expect(instants[0]).toBe(at('2026-09-30T16:00:00.000Z').getTime());
  expect(attemptTtlSeconds('2026-09-29', at('2026-10-05T00:00:00.000Z'))).toBe(1);

  const redis = scriptedRedis();
  const attempts = createRealnameAttempts(redis.handle);
  const slot = {
    appId: APP,
    userId: USER,
    day: '2026-09-29',
    idempotencyKey: 'key-dddddddd',
    requestDigest: 'digest',
  };
  await attempts.reserve(slot, at('2026-09-29T10:00:00.000Z'));
  await attempts.release(slot, at('2026-09-29T12:00:00.000Z'));
  const [reserve, release] = redis.calls;
  expect(at('2026-09-29T10:00:00.000Z').getTime() + reserve!.options.ttlSeconds * 1000).toBe(
    at('2026-09-29T12:00:00.000Z').getTime() + release!.options.ttlSeconds * 1000,
  );
});

it('[AC-B1-02zq#21] 首次实名待加验：回 10010，不占次数、不调供应商、不写实名', async () => {
  const t = setup();
  const refusal = { code: 10010, data: { method: 'id_number', fail_limit: 5 } } as const;
  t.gate.mockResolvedValue(refusal);
  await expect(t.submit('key-eeeeeeee')).resolves.toEqual(refusal);
  expect(t.gate.mock.calls[0]?.[1]).toMatchObject({ appId: APP, userId: USER, deviceId: DEVICE });
  expect(t.verify).not.toHaveBeenCalled();
  expect(t.redis.store.size).toBe(0);
  expect(t.state.row).toBeUndefined();
});

it('[AC-B1-02zq#24] 已实名：不判加验，回存好的掩码姓名', async () => {
  const t = setup();
  t.state.row = {
    status: 'verified',
    name_cipher: Buffer.from(crypto.encrypt(BODY.name, 'realname.name')),
  };
  await expect(t.submit('key-ffffffff')).resolves.toMatchObject({ code: 0 });
  expect(t.gate).not.toHaveBeenCalled();
});

// ---- BR-ID-26 细则「配置」: the age line read from minor.min_realname_age (B1-02zzg) ----------

const AGE_KEY = 'minor.min_realname_age';

/** A synthetic resident ID (Beijing area code, serial 001) born on `birth` (YYYY-MM-DD). */
function residentIdBorn(birth: string): string {
  const body = `110105${birth.replaceAll('-', '')}001`;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = [...body].reduce((acc, digit, i) => acc + Number(digit) * weights[i]!, 0);
  return body + '10X98765432'[sum % 11]!;
}

/** A reader answering `value` for the key (NO_ROW: null), recording each call. */
function ageConfig(value: unknown): SmsConfigReader & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    configValue: (appId: string, key: string) => {
      calls.push([appId, key]);
      if (key !== AGE_KEY || value === NO_ROW) return Promise.resolve(null);
      return Promise.resolve({ value, version: 1 });
    },
  };
}
const NO_ROW = Symbol('no row');

/** One submission at NOW (2026-09-29 18:00 +08:00) of an ID born on `birth`; vendor answers match. */
async function submitBorn(config: SmsConfigReader | null | undefined, birth: string) {
  const t = setup(config);
  t.verify.mockResolvedValue({ outcome: 'match', provider: 'unit' });
  const idNo = residentIdBorn(birth);
  const result = await t.submit('key-age00001', BODY.name, idNo);
  return { ...t, result, idNo };
}

/** The log lines carry neither the ID number (nor any 6+ digit piece of it) nor the name. */
function expectLogsWithoutIdentity(logs: readonly unknown[], idNo: string) {
  const text = JSON.stringify(logs);
  expect(text).not.toContain(BODY.name);
  expect(text).not.toContain(idNo);
  for (let i = 0; i + 6 <= idNo.length; i++) expect(text).not.toContain(idNo.slice(i, i + 6));
}

it('[AC-B1-02zzg#1][BR-ID-26] 配置 16：16 周岁生日当天 30407、不调供应商；满 16（生日次日 00:00）通过；按 app 读该键', async () => {
  // Born 2010-09-29: the 16th birthday is today, reached 2026-09-30 00:00 +08:00.
  const under = await submitBorn(ageConfig(16), '2010-09-29');
  expect(under.result).toEqual({ code: 30407 });
  expect(under.verify).not.toHaveBeenCalled();
  expect(under.state.row).toBeUndefined();
  expect(under.redis.store.size).toBe(0);
  // Born 2010-09-28: 16 since 2026-09-29 00:00 +08:00.
  const config = ageConfig(16);
  const reached = await submitBorn(config, '2010-09-28');
  expect(reached.result).toMatchObject({ code: 0 });
  expect(config.calls).toEqual([[APP, AGE_KEY]]);
  // A 15-year-old that 14 would let through is refused under 16.
  await expect(submitBorn(ageConfig(16), '2011-01-01')).resolves.toMatchObject({
    result: { code: 30407 },
  });
});

it.each([
  ['无配置行（null）', ageConfig(NO_ROW)],
  ['没有读取口（null）', null],
  ['未装配读取口（undefined）', undefined],
] as const)(
  '[AC-B1-02zzg#2][BR-ID-26] 配置缺省（%s）按 14：13 岁末 30407，满 14 通过',
  async (_label, config) => {
    const under = await submitBorn(config, '2012-09-29');
    expect(under.result).toEqual({ code: 30407 });
    expect(under.verify).not.toHaveBeenCalled();
    const reached = await submitBorn(config, '2012-09-28');
    expect(reached.result).toMatchObject({ code: 0 });
    // A missing row is not a fault: no fallback line.
    expect(reached.logs.filter((l) => l.msg === 'identity_realname_age_config_fallback')).toEqual(
      [],
    );
  },
);

it('[AC-B1-02zzg#6][BR-ID-26] 读配置失败按 14、不回 50001；兜底日志只带 app_id 与键名，不含身份证号与姓名', async () => {
  const failing: SmsConfigReader = {
    configValue: () => Promise.reject(new Error(`read failed for ${BODY.name}`)),
  };
  const twelve = await submitBorn(failing, '2014-01-01');
  expect(twelve.result).toEqual({ code: 30407 });
  const under = await submitBorn(failing, '2012-09-29');
  expect(under.result).toEqual({ code: 30407 });
  expect(under.verify).not.toHaveBeenCalled();
  expect(under.logs).toEqual([
    {
      level: 'warn',
      fields: { app_id: APP, key: AGE_KEY, reason: 'read_failed' },
      msg: 'identity_realname_age_config_fallback',
    },
  ]);
  expectLogsWithoutIdentity(under.logs, under.idNo);
  const reached = await submitBorn(failing, '2012-09-28');
  expect(reached.result).toMatchObject({ code: 0 });
  expectLogsWithoutIdentity(reached.logs, reached.idNo);
});

it.each([
  ['低于下限 10', 10],
  ['低于下限 13', 13],
  ['零', 0],
  ['负数 -16', -16],
  ['高于上限 19', 19],
  ['高于上限 100', 100],
] as const)(
  '[AC-B1-02zzg#3][BR-ID-26] 配置越界（%s）按 14、不放宽：12 岁与 13 岁末 30407，满 14 与 15 岁通过',
  async (_label, value) => {
    for (const birth of ['2014-01-01', '2012-09-29']) {
      const under = await submitBorn(ageConfig(value), birth);
      expect(under.result, `born ${birth}`).toEqual({ code: 30407 });
      expect(under.logs).toEqual([
        {
          level: 'warn',
          fields: { app_id: APP, key: AGE_KEY, reason: 'invalid' },
          msg: 'identity_realname_age_config_fallback',
        },
      ]);
      expectLogsWithoutIdentity(under.logs, under.idNo);
    }
    for (const birth of ['2012-09-28', '2011-01-01']) {
      const reached = await submitBorn(ageConfig(value), birth);
      expect(reached.result, `born ${birth}`).toMatchObject({ code: 0 });
      expectLogsWithoutIdentity(reached.logs, reached.idNo);
    }
  },
);

it.each([
  ['非整数 16.5', 16.5],
  ['非整数 13.5', 13.5],
  ['字符串 "16"', '16'],
  ['字符串 "10"', '10'],
  ['JSON null', null],
  ['布尔 true', true],
  ['数组 [16]', [16]],
  ['对象 {"value":16}', { value: 16 }],
] as const)(
  '[AC-B1-02zzg#3][BR-ID-26] 配置非整数（%s）按 14：13 岁末 30407，15 岁通过（不当 16 用）',
  async (_label, value) => {
    const under = await submitBorn(ageConfig(value), '2012-09-29');
    expect(under.result).toEqual({ code: 30407 });
    expect(under.logs.map((l) => l.fields)).toEqual([
      { app_id: APP, key: AGE_KEY, reason: 'invalid' },
    ]);
    expectLogsWithoutIdentity(under.logs, under.idNo);
    const fifteen = await submitBorn(ageConfig(value), '2011-01-01');
    expect(fifteen.result).toMatchObject({ code: 0 });
    expectLogsWithoutIdentity(fifteen.logs, fifteen.idNo);
  },
);
