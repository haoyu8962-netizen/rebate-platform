// Unit tests of the console's real-name correction (B1-27a §11: the two counting rules the rule tests
// do not cover). The database is a scripted Kysely driver, Redis an in-memory stand-in of the daily
// attempt scripts; the real database runs in test/spec/identity/admin-realname/**.
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
  type AuditInput,
  type FieldCrypto,
  type RedisHandle,
} from '../../platform/index.ts';
import type { RealnameVerificationResult } from '../ports/realname-verifier.ts';
import {
  AdminRealnameCorrection,
  type AdminRealnameCorrectionCommand,
  type AdminRealnameCorrectionOptions,
} from './admin-realname-correction.ts';
import { payoutAccountChecks } from './payout-account.ts';
import {
  REALNAME_ATTEMPTS_NAMESPACE,
  RESERVE_SCRIPT,
  createRealnameAttempts,
  type AttemptSlot,
} from './realname-attempts.ts';

const NOW = '2026-10-09T02:00:00.000Z';
const APP = 'couli';
const USER = '019a0000-0000-7000-8000-000000000042';
const ADMIN = '019a0000-0000-7000-8000-0000000000ad';

const crypto: FieldCrypto = {
  currentKeyVersion: 1,
  encrypt: (plain, context) => `enc:${context}:${plain}`,
  decrypt: (cipher, context) => cipher.slice(`enc:${context}:`.length),
  keyVersionOf: () => 1,
  needsReencrypt: () => false,
  reencrypt: (cipher) => cipher,
  blindIndex: (value, context) => createHash('sha256').update(`${context}|${value}`).digest('hex'),
};

function checkDigit(prefix: string): string {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = [...prefix].reduce((n, char, i) => n + Number(char) * weights[i]!, 0);
  return prefix + '10X98765432'[sum % 11]!;
}

// Synthetic resident ID numbers with valid check digits, and names.
const OLD = { name: '测试旧名', idNo: checkDigit('11010519491231002') };
const NEW = { name: '测试新名', idNo: checkDigit('44030519960721028') };

/** Answers the statements of the correction; every statement is kept in `seen`. */
function scriptedDb(
  seen: CompiledQuery[],
  flag: { at: Date | null },
  tx: { open: number } = { open: 0 },
): Kysely<DB> {
  const answer = (query: CompiledQuery): QueryResult<unknown> => {
    seen.push(query);
    const { sql } = query;
    if (sql.startsWith('select "app"."users"."id"')) {
      return { rows: [{ id: USER, status: 'normal', request_status: null }] };
    }
    if (sql.startsWith('select "id" from "app"."users"')) return { rows: [{ id: USER }] };
    if (sql.startsWith('select "reverify_flagged_at"')) {
      return { rows: [{ flagged_at: flag.at, trusted: null, fail_count: 0, fail_day: null }] };
    }
    if (sql.startsWith('select "id", "status", "name_cipher"')) {
      return {
        rows: [
          {
            id: 'rn-1',
            status: 'verified',
            name_cipher: Buffer.from(crypto.encrypt(OLD.name, 'realname.name')),
            id_no_cipher: Buffer.from(crypto.encrypt(OLD.idNo, 'realname.id_no')),
            id_no_hmac: crypto.blindIndex(OLD.idNo, 'realname.id_no'),
            verified_at: new Date('2026-03-01T00:00:00Z'),
            row_version: 0,
          },
        ],
      };
    }
    if (sql.startsWith('select "id" from "app"."realname"')) return { rows: [] };
    if (sql.startsWith('select "id", "payout_method", "alipay_hmac"')) {
      return {
        rows: [
          {
            id: 'pa-1',
            payout_method: 'alipay',
            alipay_hmac: 'b'.repeat(64),
            bank_card_hmac: null,
            row_version: 3,
          },
        ],
      };
    }
    if (sql.startsWith('update')) return { rows: [], numAffectedRows: 1n };
    if (sql.startsWith('INSERT INTO app.payout_account_changes')) {
      return { rows: [], numAffectedRows: 1n };
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
    beginTransaction: () => {
      tx.open += 1;
      return Promise.resolve();
    },
    commitTransaction: () => {
      tx.open -= 1;
      return Promise.resolve();
    },
    rollbackTransaction: () => {
      tx.open -= 1;
      return Promise.resolve();
    },
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

/** The reserve script's rule (count per day key, a mark per request) in memory; every call kept. */
function scriptedRedis() {
  const store = new Map<string, string>();
  const calls: string[] = [];
  const handle: RedisHandle = {
    namespace: (name) => ({
      get: (key) => {
        calls.push(`${name}:get`);
        return Promise.resolve(store.get(key) ?? null);
      },
      set: (key, value) => {
        calls.push(`${name}:set`);
        store.set(key, value);
        return Promise.resolve();
      },
      eval: (script, options) => {
        calls.push(`${name}:eval`);
        if (script !== RESERVE_SCRIPT) return Promise.reject(new Error('not used'));
        const [count, mark] = options.keys as [string, string];
        const limit = Number(options.args[2]);
        if (store.has(mark)) return Promise.resolve('pending');
        const n = Number(store.get(count) ?? '0');
        if (n >= limit) return Promise.resolve(0);
        store.set(count, String(n + 1));
        store.set(mark, 'pending');
        return Promise.resolve(1);
      },
    }),
    close: () => Promise.resolve(),
    onApplicationShutdown: () => Promise.resolve(),
  };
  return { handle, store, calls };
}

function setup(extra: Pick<AdminRealnameCorrectionOptions, 'config'> = {}) {
  const seen: CompiledQuery[] = [];
  const verify = vi.fn<() => Promise<RealnameVerificationResult>>();
  const audits: AuditInput[] = [];
  const publish = vi.fn(async () => ({ eventId: 'event-1', duplicate: false }));
  const flag: { at: Date | null } = { at: null };
  const tx = { open: 0 };
  const logs: unknown[][] = [];
  const service = new AdminRealnameCorrection({
    db: scriptedDb(seen, flag, tx),
    clock: new FixedClock(NOW),
    logger: {
      info: (...args: unknown[]) => {
        logs.push(['info', ...args]);
      },
      warn: (...args: unknown[]) => {
        logs.push(['warn', ...args]);
      },
    },
    crypto,
    priorCrypto: crypto,
    verifier: { verify },
    withdrawals: {
      hasNonTerminal: () => Promise.resolve(false),
      hasSucceeded: () => Promise.resolve(false),
    },
    blocklist: { listed: () => Promise.resolve(false) },
    auditOn: () => ({
      append: (input) => {
        audits.push(input);
        return Promise.resolve();
      },
    }),
    events: { publish },
    ...extra,
  });
  const command: AdminRealnameCorrectionCommand = {
    appId: APP,
    adminId: ADMIN,
    ip: null,
    userId: USER,
    name: NEW.name,
    idNo: NEW.idNo,
    reason: '企业微信核对后更正',
  };
  return { seen, verify, audits, publish, service, command, flag, tx, logs };
}

it('[AC-B1-27a] 后台实名更正（含二要素不一致）不占用户自助实名的每日次数：REALNAME_ATTEMPTS 计数不变，用户当天仍可提交 3 次', async () => {
  const t = setup();
  const redis = scriptedRedis();
  t.verify.mockResolvedValue({ outcome: 'mismatch', provider: 'unit' });
  for (let i = 0; i < 4; i += 1) {
    expect((await t.service.correct(t.command)).code).toBe(30406);
  }
  t.verify.mockResolvedValue({ outcome: 'match', provider: 'unit' });
  expect((await t.service.correct(t.command)).code).toBe(0);
  expect(t.verify).toHaveBeenCalledTimes(5);
  // The correction never reaches the daily attempt counter.
  expect(redis.calls).toEqual([]);
  expect(redis.store.size).toBe(0);
  // The user's own attempts of the same +08:00 day: 3 reservations, then full.
  const attempts = createRealnameAttempts(redis.handle);
  const slot = (key: string): AttemptSlot => ({
    appId: APP,
    userId: USER,
    day: '2026-10-09',
    idempotencyKey: key,
    requestDigest: crypto.blindIndex(key, 'realname.attempt'),
  });
  const now = new Date(NOW);
  const answers = [];
  for (const key of ['key-1', 'key-2', 'key-3', 'key-4']) {
    answers.push((await attempts.reserve(slot(key), now)).kind);
  }
  expect(answers).toEqual(['reserved', 'reserved', 'reserved', 'full']);
  expect(redis.calls.every((call) => call.startsWith(`${REALNAME_ATTEMPTS_NAMESPACE}:`))).toBe(
    true,
  );
});

it('[AC-B1-27a] 更正使收款账号失效：is_current 置 false（row_version CAS），每行写一条 realname_correction 豁免变更行，不计月度变更次数', async () => {
  const t = setup();
  t.verify.mockResolvedValue({ outcome: 'match', provider: 'unit' });
  expect((await t.service.correct(t.command)).code).toBe(0);
  const retire = t.seen.find((query) => query.sql.startsWith('update "app"."payout_accounts"'));
  expect(retire?.sql).toContain('"is_current" = $1');
  expect(retire?.sql).toContain('"row_version" = $');
  expect(retire?.parameters).toEqual(expect.arrayContaining([false, 4, 'pa-1', true, 3]));
  const changes = t.seen.filter((query) => query.sql.includes('payout_account_changes'));
  expect(changes).toHaveLength(1);
  // old/new method, old HMAC, new_hmac '' (a literal in the statement), operator, changed_at and
  // created_at = the Clock instant, the exempt reason.
  expect(changes[0]!.sql).toContain(`''`);
  expect(changes[0]!.parameters).toEqual([
    APP,
    USER,
    'alipay',
    'alipay',
    'b'.repeat(64),
    `admin:${ADMIN}`,
    new Date(NOW),
    new Date(NOW),
    'realname_correction',
  ]);
  expect(t.publish).toHaveBeenCalledTimes(1);
  expect(t.audits).toHaveLength(1);
  expect(t.audits[0]!.after).toMatchObject({ result_code: 0, payout_accounts_invalidated: 1 });
});

/** A handle answering payoutAccountChecks' reads: no blocklist hit, `used` changes this month. */
function checksDb(current: Record<string, unknown> | undefined, used: number): Kysely<DB> {
  const answer = (query: CompiledQuery): QueryResult<unknown> => {
    const { sql } = query;
    if (sql.includes('from "app"."payout_account_changes"')) return { rows: [{ n: String(used) }] };
    if (sql.startsWith('select "id" from "app"."payout_accounts"')) return { rows: [] };
    if (sql.includes('from "app"."payout_accounts"')) {
      return { rows: current === undefined ? [] : [current] };
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

it('[AC-B1-27a] 更正后第一次重新绑定不计入月度变更次数：本月次数已满时仍可绑定、不回 30303', async () => {
  const deps = {
    clock: new FixedClock(NOW),
    crypto,
    blocklist: { check: () => Promise.resolve(null) },
  };
  const subject = { appId: APP, userId: USER };
  const target = { method: 'alipay' as const, hmac: 'a'.repeat(64), payeeName: NEW.name };
  const realname = () => Promise.resolve({ name: NEW.name });
  // After the correction no account is current: a first binding, whatever this month's count.
  const after = await payoutAccountChecks(
    checksDb(undefined, 2),
    deps,
    subject,
    { phone_cipher: null },
    target,
    2,
    realname,
  );
  expect(after.kind).toBe('open');
  // Control: with a current account the same count is the limit (30303).
  const before = await payoutAccountChecks(
    checksDb(
      {
        id: 'pa-1',
        payout_method: 'alipay',
        alipay_hmac: 'b'.repeat(64),
        alipay_logon_id_cipher: null,
        bank_card_hmac: null,
        bank_card_no_cipher: null,
        bank_name: null,
        payee_name: NEW.name,
        row_version: 0,
      },
      2,
    ),
    deps,
    subject,
    { phone_cipher: null },
    target,
    2,
    realname,
  );
  expect(before).toEqual({
    kind: 'refused',
    result: { code: 30303, data: { reason: 'payout_account_change_limit' } },
  });
});

it('[AC-B1-27a] 拒绝也写审计：结果码与新值脱敏串，不含姓名与身份证号明文', async () => {
  const t = setup();
  const minor = checkDigit('44030520130504046');
  const result = await t.service.correct({ ...t.command, idNo: minor });
  expect(result.code).toBe(30407);
  expect(t.verify).not.toHaveBeenCalled();
  expect(t.audits).toHaveLength(1);
  const text = JSON.stringify(t.audits[0]);
  expect(text).toContain('30407');
  expect(text).toContain(`4${'*'.repeat(16)}${minor.slice(-1)}`);
  for (const secret of [minor, NEW.name, OLD.name, OLD.idNo]) expect(text).not.toContain(secret);
});

it('[AC-B1-02zq#34] 带待加验标记：30419 reverify_pending，不调供应商，留一条审计', async () => {
  const t = setup();
  t.flag.at = new Date(NOW);
  await expect(t.service.correct(t.command)).resolves.toEqual({
    code: 30419,
    data: { reason: 'reverify_pending' },
  });
  expect(t.verify).not.toHaveBeenCalled();
  expect(t.audits).toHaveLength(1);
});

// B1-02zzk (BR-ID-26 细则「配置」): the line of step 5 is the app's minor.min_realname_age, read
// as the App-side submission reads it. At NOW (2026-10-09 10:00 +08:00) someone born 2010-10-08
// is 16 (since 2026-10-09 00:00), born 2010-10-09 is 15 (16 at 2026-10-10 00:00), born
// 2013-05-04 is 13.
const AGE_16 = checkDigit('44030520101008002');
const AGE_15 = checkDigit('44030520101009002');
const AGE_13 = checkDigit('44030520130504046');

type ConfigAnswer = { readonly value: unknown } | null | Error;

/** A reader of the configuration: every call kept with the open transactions at that moment. */
function ageConfig(answer: ConfigAnswer, tx: { open: number } | null = null) {
  const calls: { appId: string; key: string; openTx: number }[] = [];
  const holder = { tx };
  const reader = {
    configValue: (appId: string, key: string) => {
      calls.push({ appId, key, openTx: holder.tx?.open ?? 0 });
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  return { reader, calls, holder };
}

/** The correction of the user to `idNo` under the reader's answer; the line it decided on. */
async function judgedUnder(answer: ConfigAnswer, idNo: string) {
  const config = ageConfig(answer);
  const t = setup({ config: config.reader });
  config.holder.tx = t.tx;
  t.verify.mockResolvedValue({ outcome: 'match', provider: 'unit' });
  const result = await t.service.correct({ ...t.command, idNo });
  return { result, t, config };
}

it('[AC-B1-02zzk#1] 配置 16：15 岁的新身份 30407（不调供应商、不覆盖），满 16 周岁的新身份通过；按本 app 读 minor.min_realname_age，读时不持有事务', async () => {
  const young = await judgedUnder({ value: 16 }, AGE_15);
  expect(young.result.code).toBe(30407);
  expect(young.t.verify).not.toHaveBeenCalled();
  expect(young.t.seen.some((query) => query.sql.startsWith('update'))).toBe(false);
  expect(young.t.publish).not.toHaveBeenCalled();
  expect(young.config.calls).toEqual([{ appId: APP, key: 'minor.min_realname_age', openTx: 0 }]);

  const of16 = await judgedUnder({ value: 16 }, AGE_16);
  expect(of16.result.code).toBe(0);
  expect(of16.t.verify).toHaveBeenCalledTimes(1);
  expect(of16.config.calls).toEqual([{ appId: APP, key: 'minor.min_realname_age', openTx: 0 }]);
  // The configured line is not a fallback: nothing logged about it.
  expect(JSON.stringify(of16.t.logs)).not.toContain('identity_realname_age_config_fallback');
});

it('[AC-B1-02zzk#2] 配置缺省（无此行或未接配置读取口）：按 14，15 岁通过、13 岁 30407，不记兜底日志', async () => {
  const missing = await judgedUnder(null, AGE_15);
  expect(missing.result.code).toBe(0);
  expect(missing.config.calls).toHaveLength(1);
  expect(JSON.stringify(missing.t.logs)).not.toContain('identity_realname_age_config_fallback');
  expect((await judgedUnder(null, AGE_13)).result.code).toBe(30407);

  for (const config of [undefined, null]) {
    const t = setup(config === undefined ? {} : { config });
    t.verify.mockResolvedValue({ outcome: 'match', provider: 'unit' });
    expect((await t.service.correct({ ...t.command, idNo: AGE_15 })).code).toBe(0);
    const u = setup(config === undefined ? {} : { config });
    expect((await u.service.correct({ ...u.command, idNo: AGE_13 })).code).toBe(30407);
    expect(u.verify).not.toHaveBeenCalled();
  }
});

it('[AC-B1-02zzk#3] 读配置失败：按 14 照常判定，不报 50001；兜底日志只带 app_id 与键名，不含身份证号与姓名', async () => {
  const failing = new Error(`config read failed for ${NEW.name} ${AGE_15}`);
  const passed = await judgedUnder(failing, AGE_15);
  expect(passed.result.code).toBe(0);
  const refused = await judgedUnder(failing, AGE_13);
  expect(refused.result.code).toBe(30407);
  expect(refused.t.verify).not.toHaveBeenCalled();

  for (const { t } of [passed, refused]) {
    const fallbacks = t.logs.filter((log) => log.includes('identity_realname_age_config_fallback'));
    expect(fallbacks).toEqual([
      [
        'warn',
        { app_id: APP, key: 'minor.min_realname_age', reason: 'read_failed' },
        'identity_realname_age_config_fallback',
      ],
    ]);
    const text = JSON.stringify(t.logs);
    for (const secret of [AGE_15, AGE_13, NEW.name, OLD.name, OLD.idNo]) {
      expect(text).not.toContain(secret);
    }
  }
});

it('[AC-B1-02zzk#4] 配置越界（低于 14、高于 18）：按 14，绝不放宽到 14 以下，也不收紧到 19 以上', async () => {
  for (const value of [10, 13, 0, -16, 19, 100]) {
    const loose = await judgedUnder({ value }, AGE_13);
    expect(loose.result.code, `value ${value}: 13 岁仍拒`).toBe(30407);
    expect(loose.t.verify).not.toHaveBeenCalled();
    const line14 = await judgedUnder({ value }, AGE_15);
    expect(line14.result.code, `value ${value}: 按 14，15 岁通过`).toBe(0);
    const fallbacks = line14.t.logs.filter((log) =>
      log.includes('identity_realname_age_config_fallback'),
    );
    expect(fallbacks).toEqual([
      [
        'warn',
        { app_id: APP, key: 'minor.min_realname_age', reason: 'invalid' },
        'identity_realname_age_config_fallback',
      ],
    ]);
    expect(JSON.stringify(line14.t.logs)).not.toContain(AGE_15);
  }
  // The bounds themselves are lines: 14 lets 15 through, 18 refuses 16.
  expect((await judgedUnder({ value: 14 }, AGE_15)).result.code).toBe(0);
  expect((await judgedUnder({ value: 18 }, AGE_16)).result.code).toBe(30407);
});

it('[AC-B1-02zzk#5] 配置非整数（小数、字符串、null、布尔、数组、对象）：按 14，13 岁仍拒、15 岁通过', async () => {
  for (const value of [16.5, 13.5, '16', '10', 'abc', null, true, [16], { value: 16 }]) {
    const label = JSON.stringify(value);
    expect((await judgedUnder({ value }, AGE_13)).result.code, `${label}: 13 岁`).toBe(30407);
    const line14 = await judgedUnder({ value }, AGE_15);
    expect(line14.result.code, `${label}: 15 岁`).toBe(0);
    expect(JSON.stringify(line14.t.logs)).toContain('identity_realname_age_config_fallback');
  }
});
