import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type QueryResult,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import type { Ledger } from '../../ledger/index.ts';
import { FixedClock } from '../../platform/index.ts';
import { reviewDeadline } from '../domain/review-deadline.ts';
import {
  CALENDAR_KEYS,
  createWithdrawApply,
  readReviewCalendars,
  type WithdrawApplyResult,
  type WithdrawPayeeSnapshot,
} from './withdraw-apply.ts';
import type { OpenPayoutMethodsPort, WithdrawRulesOptions } from './withdraw-rules.ts';

const APP_ID = 'calendar_unit';
// Only passed through to the port.
const HANDLE = {} as Kysely<DB>;
const FROM = new Date('2026-10-01T12:00:00+08:00');
const CALENDAR = {
  holidays: ['2026-10-02', '2026-10-06'],
  makeupWorkdays: ['2026-10-03', '2026-10-04'],
};

/** Per-key reads that pair an old holiday list with the new make-up list (a save in between). */
type Read = (
  appId: string,
  key: string,
  handle: Kysely<DB>,
) => Promise<{ value: unknown; version: number }>;
type BatchRead = (
  appId: string,
  keys: readonly string[],
  handle: Kysely<DB>,
) => Promise<Map<string, { value: unknown; version: number }>>;

const mixedRead: Read = (_appId, key) => {
  return Promise.resolve(
    key === CALENDAR_KEYS.holidays(2026)
      ? { value: ['2026-10-05'], version: 1 }
      : { value: CALENDAR.makeupWorkdays, version: 2 },
  );
};

function batch(values: Readonly<Record<string, unknown>>) {
  return vi.fn<BatchRead>((_appId, keys) =>
    Promise.resolve(
      new Map(
        keys.filter((key) => key in values).map((key) => [key, { value: values[key], version: 2 }]),
      ),
    ),
  );
}

it('[AC-B1-34s#7] with a batch read the year two keys come from one call on the handle, taken whole', async () => {
  const config = {
    configValue: vi.fn<Read>(mixedRead),
    configValues: batch({
      [CALENDAR_KEYS.holidays(2026)]: CALENDAR.holidays,
      [CALENDAR_KEYS.makeupWorkdays(2026)]: CALENDAR.makeupWorkdays,
    }),
  };
  const logger = { warn: vi.fn() };
  expect(await readReviewCalendars({ config, logger }, HANDLE, APP_ID, FROM)).toStrictEqual({
    2026: CALENDAR,
  });
  expect(config.configValues).toHaveBeenCalledExactlyOnceWith(
    APP_ID,
    [CALENDAR_KEYS.holidays(2026), CALENDAR_KEYS.makeupWorkdays(2026)],
    HANDLE,
  );
  expect(config.configValue).not.toHaveBeenCalled();
  expect(logger.warn).not.toHaveBeenCalled();
});

it('[AC-B1-34s#7] a key the batch read does not return leaves the year unconfigured, never read on its own', async () => {
  const config = {
    configValue: vi.fn<Read>(mixedRead),
    configValues: batch({ [CALENDAR_KEYS.holidays(2026)]: CALENDAR.holidays }),
  };
  const logger = { warn: vi.fn() };
  expect(await readReviewCalendars({ config, logger }, HANDLE, APP_ID, FROM)).toStrictEqual({});
  expect(config.configValue).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
    { app_id: APP_ID, year: 2026 },
    'workday_calendar_unconfigured',
  );
});

it('[AC-B1-34s#7] a deadline reaching into January reads both years in one call', async () => {
  const config = { configValue: vi.fn<Read>(mixedRead), configValues: batch({}) };
  const logger = { warn: vi.fn() };
  const result = await readReviewCalendars(
    { config, logger },
    HANDLE,
    APP_ID,
    new Date('2026-12-31T20:00:00+08:00'),
  );
  expect(result).toStrictEqual({});
  expect(config.configValues.mock.calls.map(([, keys]) => keys)).toEqual([
    [
      CALENDAR_KEYS.holidays(2026),
      CALENDAR_KEYS.makeupWorkdays(2026),
      CALENDAR_KEYS.holidays(2027),
      CALENDAR_KEYS.makeupWorkdays(2027),
    ],
  ]);
  expect(config.configValue).not.toHaveBeenCalled();
  expect(logger.warn.mock.calls).toEqual([
    [{ app_id: APP_ID, year: 2026 }, 'workday_calendar_unconfigured'],
    [{ app_id: APP_ID, year: 2027 }, 'workday_calendar_unconfigured'],
  ]);
});

it('[AC-B1-34s#7] a batch save between the reads of two years is seen whole: the deadline is the old or the new one', async () => {
  // B1-34s (D10-3115). OLD wrongly lists 2026-12-31 as a holiday and misses 2027-01-01; one save
  // corrects both. From Thu 2026-12-31 20:00: whole OLD gives 2027-01-02 00:00, whole NEW
  // 2027-01-04 20:00; OLD 2026 with NEW 2027 (one call per year) drops both days: 2027-01-05 00:00.
  const OLD: Readonly<Record<string, readonly string[]>> = {
    [CALENDAR_KEYS.holidays(2026)]: ['2026-12-31'],
    [CALENDAR_KEYS.makeupWorkdays(2026)]: [],
    [CALENDAR_KEYS.holidays(2027)]: [],
    [CALENDAR_KEYS.makeupWorkdays(2027)]: [],
  };
  const NEW: Readonly<Record<string, readonly string[]>> = {
    [CALENDAR_KEYS.holidays(2026)]: [],
    [CALENDAR_KEYS.makeupWorkdays(2026)]: [],
    [CALENDAR_KEYS.holidays(2027)]: ['2027-01-01'],
    [CALENDAR_KEYS.makeupWorkdays(2027)]: [],
  };
  let calls = 0;
  const configValues = vi.fn<BatchRead>((_appId, keys) => {
    const saved = calls === 0 ? OLD : NEW;
    calls += 1;
    return Promise.resolve(
      new Map(
        keys.filter((key) => key in saved).map((key) => [key, { value: saved[key], version: 2 }]),
      ),
    );
  });
  const config = { configValue: vi.fn<Read>(mixedRead), configValues };
  const logger = { warn: vi.fn() };
  const from = new Date('2026-12-31T20:00:00+08:00');
  const calendars = await readReviewCalendars({ config, logger }, HANDLE, APP_ID, from);
  expect(reviewDeadline(from, calendars).toISOString()).toBe('2027-01-01T16:00:00.000Z');
  expect(calendars).toStrictEqual({
    2026: { holidays: ['2026-12-31'], makeupWorkdays: [] },
    2027: { holidays: [], makeupWorkdays: [] },
  });
  expect(configValues).toHaveBeenCalledTimes(1);
  expect([...configValues.mock.calls[0]![1]].sort()).toEqual(Object.keys(OLD).sort());
  expect(configValues.mock.calls[0]![2]).toBe(HANDLE);
  expect(config.configValue).not.toHaveBeenCalled();
  expect(logger.warn).not.toHaveBeenCalled();
});

it('[AC-B1-34s#7] without a batch read each key of the year is read once on the handle', async () => {
  const configValue = vi.fn<Read>((_appId, key) =>
    Promise.resolve({
      value: key === CALENDAR_KEYS.holidays(2026) ? CALENDAR.holidays : CALENDAR.makeupWorkdays,
      version: 2,
    }),
  );
  const logger = { warn: vi.fn() };
  expect(
    await readReviewCalendars({ config: { configValue }, logger }, HANDLE, APP_ID, FROM),
  ).toStrictEqual({ 2026: CALENDAR });
  expect(configValue.mock.calls).toEqual([
    [APP_ID, CALENDAR_KEYS.holidays(2026), HANDLE],
    [APP_ID, CALENDAR_KEYS.makeupWorkdays(2026), HANDLE],
  ]);
});

// B2-05u (Codex money review r1 S1; BR-WDR-07 ④ re-runs BR-WDR-03 ⑤ under the locks): the
// open-method set is read again under the member's locks. A scripted database records every
// statement; the ports are fakes (nothing of identity).
const METHODS_KEY = 'withdraw.payout_methods';
const APPLY_ACTOR = {
  appId: 'b2_05u_apply_unit',
  userId: '00000000-0000-7000-8000-000000000001',
  deviceId: 'device-1',
};
const PAYEE_HMAC = 'a'.repeat(64);
const applyHandles: Kysely<DB>[] = [];
afterEach(async (): Promise<void> => {
  await Promise.all(applyHandles.splice(0).map((db) => db.destroy()));
});

type ConfigRead = (
  appId: string,
  key: string,
  handle: Kysely<DB>,
) => Promise<{ value: unknown; version: number } | null>;

/** A bound payee account of the scripted member (B2-05v). */
interface BoundAccount {
  method: 'alipay' | 'bank_card';
  hmac: string;
}

/**
 * `methods[i]` is the open set the i-th read of withdraw.payout_methods returns (the last one
 * repeats): the first pass reads it once, the locked re-read once more.
 * B2-05v: `rebinds[k]` becomes the member's current account just before the k-th users lock
 * (0-based) is taken — a rebind committed between the first pass and the locks; identity's
 * subject reader and the snapshot both read the current account. `config` adds values by key.
 */
async function applyHarness(
  methods: readonly (readonly string[])[],
  script: {
    rebinds?: readonly (BoundAccount | undefined)[];
    config?: Readonly<Record<string, unknown>>;
  } = {},
) {
  const statements: string[] = [];
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  connection.executeQuery = async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
    statements.push(query.sql);
    return {
      rows: [],
      numAffectedRows: query.sql.startsWith('insert') ? 1n : undefined,
    } as QueryResult<R>;
  };
  driver.acquireConnection = async (): Promise<typeof connection> => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  applyHandles.push(db);
  const clock = new FixedClock('2026-10-01T04:00:00.000Z');
  let methodReads = 0;
  const configValue = vi.fn<ConfigRead>(
    (_appId, key): Promise<{ value: unknown; version: number } | null> => {
      if (key !== METHODS_KEY) {
        const extra = script.config ?? {};
        return Promise.resolve(key in extra ? { value: extra[key], version: 1 } : null);
      }
      const value = methods[Math.min(methodReads, methods.length - 1)];
      methodReads += 1;
      return Promise.resolve({ value, version: 1 });
    },
  );
  const port: OpenPayoutMethodsPort = {
    key: METHODS_KEY,
    defaults: new Set(['alipay', 'bank_card']),
    parse: (value: unknown): ReadonlySet<string> | null =>
      Array.isArray(value) ? new Set<string>(value as string[]) : null,
  };
  let bound: BoundAccount = { method: 'alipay', hmac: PAYEE_HMAC };
  // Untyped: pino's overloaded warn is what the port declares.
  const warn = vi.fn();
  const rules: WithdrawRulesOptions = {
    clock,
    logger: { warn },
    config: { configValue },
    risk: {
      read: vi.fn(
        async (): Promise<Map<string, { state: 'normal'; frozen_until: null }>> =>
          new Map([[APPLY_ACTOR.userId, { state: 'normal' as const, frozen_until: null }]]),
      ),
    },
    appeal: { read: vi.fn(async (): Promise<null> => null) },
    blocklist: { read: vi.fn(async (): Promise<null> => null) },
    reverify: { check: vi.fn(async (): Promise<null> => null) },
    realname: {
      read: vi.fn(async (): Promise<'verified'> => 'verified' as const),
      verified: vi.fn(
        async (): Promise<{
          name: string;
          birth_date: string;
          provider: string;
          verified_at: Date;
        }> => ({
          name: '阿·甲',
          birth_date: '1990-01-01',
          provider: 'synthetic',
          verified_at: clock.now(),
        }),
      ),
    },
    subject: {
      read: vi.fn(
        async (): Promise<{
          payout_method: 'alipay' | 'bank_card';
          payee_name: string;
          payee_hmac: string;
        }> => ({
          payout_method: bound.method,
          payee_name: '阿·甲',
          payee_hmac: bound.hmac,
        }),
      ),
    },
    laborAgreementSigned: vi.fn(async (): Promise<boolean> => true),
    ledger: {
      getBalances: vi.fn(async (): ReturnType<Ledger['getBalances']> => [
        {
          app_id: APPLY_ACTOR.appId,
          user_id: APPLY_ACTOR.userId,
          account_id: 'account-1',
          available_fen: 10000n,
          frozen_fen: 0n,
          version: 1n,
          negative_since: null,
        },
      ]),
    },
    holds: { read: vi.fn(async (): Promise<[]> => []) },
    usage: {
      read: vi.fn(
        async (): Promise<{
          daily_count: number;
          monthly_count: number;
          payee_daily_count: number;
          payee_daily_other_users: number;
          monthly_amount_fen: bigint;
        }> => ({
          daily_count: 0,
          monthly_count: 0,
          payee_daily_count: 0,
          payee_daily_other_users: 0,
          monthly_amount_fen: 0n,
        }),
      ),
    },
    selfPurchase: {
      read: vi.fn(async (): Promise<{ count: number; amount_fen: bigint }> => ({
        count: 0,
        amount_fen: 0n,
      })),
    },
    feeTax: {
      calculate: vi.fn(
        async (
          _handle: Kysely<DB>,
          input: { amountFen: bigint },
        ): Promise<{ fee_fen: bigint; tax_fen: bigint; net_fen: bigint }> => ({
          fee_fen: 0n,
          tax_fen: 0n,
          net_fen: input.amountFen,
        }),
      ),
    },
    openPayoutMethods: port,
  };
  const lockBalances = vi.fn(
    async (): Promise<{ user_id: string; account_id: string; available_fen: bigint }[]> => [
      { user_id: APPLY_ACTOR.userId, account_id: 'account-1', available_fen: 10000n },
    ],
  );
  const post = vi.fn(async (): Promise<void> => undefined);
  const ledger = { lockBalances, post } as unknown as Ledger;
  let locks = 0;
  const lockUsersForUpdate = vi.fn(async (): Promise<ReadonlySet<string>> => {
    const rebind = script.rebinds?.[locks];
    locks += 1;
    if (rebind !== undefined) bound = rebind;
    return new Set([APPLY_ACTOR.userId]);
  });
  const snapshot = (): WithdrawPayeeSnapshot => ({
    payout_method: bound.method,
    payee_name: '阿·甲',
    payee_account_cipher: Buffer.from('cipher'),
    payee_hmac: bound.hmac,
    bank_name: bound.method === 'bank_card' ? '合成银行' : null,
    account: bound.method === 'bank_card' ? '6222020000000001' : '13800138000',
  });
  const service = createWithdrawApply({
    rules,
    ledger,
    lockUsersForUpdate,
    snapshot: { read: vi.fn(async (): Promise<WithdrawPayeeSnapshot> => snapshot()) },
    outBizNo: (): string => `W${'A'.repeat(20)}`,
  });
  const apply = (): Promise<WithdrawApplyResult> =>
    db
      .transaction()
      .execute((trx): Promise<WithdrawApplyResult> =>
        service.apply(trx, { ...APPLY_ACTOR, amountFen: 1000n, stepUpValid: true }),
      );
  const methodReadCount = (): number =>
    configValue.mock.calls.filter(([, key]) => key === METHODS_KEY).length;
  return { apply, statements, post, lockUsersForUpdate, methodReadCount, warn };
}

const insertsWithdrawal = (statements: readonly string[]): boolean =>
  statements.some((text) => text.startsWith('insert into "app"."withdrawals"'));

it('[AC-B2-05u#2] 初判时支付宝开放、锁内重读时已只开放银行卡：返回 30305，不建提现单、不写冻结凭证', async () => {
  const h = await applyHarness([['alipay', 'bank_card'], ['bank_card']]);
  expect(await h.apply()).toStrictEqual({ code: 30305, data: {} });
  // Refused under the locks (the first pass passed): the open set was read twice.
  expect(h.lockUsersForUpdate).toHaveBeenCalledTimes(1);
  expect(h.methodReadCount()).toBe(2);
  expect(insertsWithdrawal(h.statements)).toBe(false);
  expect(h.post).not.toHaveBeenCalled();
});

it('[AC-B2-05u#2] 初判与锁内重读时支付宝都开放：照常建 PENDING_REVIEW 提现单并写冻结凭证', async () => {
  const h = await applyHarness([['alipay', 'bank_card']]);
  const result = await h.apply();
  expect(result).toMatchObject({
    code: 0,
    data: { status: 'PENDING_REVIEW', amount_fen: 1000, payout_channel: 'alipay' },
  });
  expect(h.methodReadCount()).toBe(2);
  expect(insertsWithdrawal(h.statements)).toBe(true);
  expect(h.post).toHaveBeenCalledTimes(1);
  expect(h.post).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ appId: APPLY_ACTOR.appId, bizType: 'withdrawal' }),
  );
});

// B2-05v (D10-3590; rule-test review r1 S2): the account compared with the snapshot is HMAC and
// method together. Same HMAC, method rebound from alipay to bank_card before the users lock: the
// pass is rolled back and run again, and the second first pass judges ⑨ with bank_card's cap.
const PASS_ROLLBACK = 'ROLLBACK TO SAVEPOINT payout_withdrawal_pass';
const BANK_SAME_HMAC: BoundAccount = { method: 'bank_card', hmac: PAYEE_HMAC };
const rollbacks = (statements: readonly string[]): number =>
  statements.filter((text): boolean => text === PASS_ROLLBACK).length;

it('[AC-B2-05v#5] 同一 HMAC 换成银行卡且银行卡上限足够：整遍回滚重跑，users 锁拿两次，按银行卡建单', async (): Promise<void> => {
  const h = await applyHarness([['alipay', 'bank_card']], {
    rebinds: [BANK_SAME_HMAC],
    config: {
      'withdraw.method_max_amount_fen.alipay': 2000,
      'withdraw.method_max_amount_fen.bank_card': 2000,
    },
  });
  const result = await h.apply();
  expect(result).toMatchObject({
    code: 0,
    data: { status: 'PENDING_REVIEW', amount_fen: 1000, payout_channel: 'bank_card' },
  });
  expect(h.lockUsersForUpdate).toHaveBeenCalledTimes(2);
  expect(rollbacks(h.statements)).toBe(1);
  expect(
    h.statements.filter((text): boolean => text.startsWith('insert into "app"."withdrawals"')),
  ).toHaveLength(1);
  expect(h.post).toHaveBeenCalledTimes(1);
});

it('[AC-B2-05v#5] 同一 HMAC 换成银行卡且银行卡上限低于申请额：第二遍初判按银行卡上限返回 30303，不建单不冻结', async (): Promise<void> => {
  const h = await applyHarness([['alipay', 'bank_card']], {
    rebinds: [BANK_SAME_HMAC],
    config: {
      'withdraw.method_max_amount_fen.alipay': 2000,
      'withdraw.method_max_amount_fen.bank_card': 500,
    },
  });
  expect(await h.apply()).toStrictEqual({ code: 30303, data: { reason: 'above_method_max' } });
  // Pass 1 took the users lock and was rolled back; pass 2 refused before any lock.
  expect(h.lockUsersForUpdate).toHaveBeenCalledTimes(1);
  expect(rollbacks(h.statements)).toBe(1);
  expect(insertsWithdrawal(h.statements)).toBe(false);
  expect(h.post).not.toHaveBeenCalled();
});

it('[AC-B2-05v#6] 三遍账号都变（只换方式）：返回 50001，不建单不冻结，只打一条不带账号的 warn', async (): Promise<void> => {
  const h = await applyHarness([['alipay', 'bank_card']], {
    rebinds: [BANK_SAME_HMAC, { method: 'alipay', hmac: PAYEE_HMAC }, BANK_SAME_HMAC],
  });
  expect(await h.apply()).toStrictEqual({ code: 50001, data: {} });
  expect(h.lockUsersForUpdate).toHaveBeenCalledTimes(3);
  expect(rollbacks(h.statements)).toBe(3);
  expect(insertsWithdrawal(h.statements)).toBe(false);
  expect(h.post).not.toHaveBeenCalled();
  expect(
    h.warn.mock.calls.filter(
      ([, message]): boolean => message === 'withdraw_payee_changed_retry_exhausted',
    ),
  ).toEqual([
    [{ user_id: APPLY_ACTOR.userId, passes: 3 }, 'withdraw_payee_changed_retry_exhausted'],
  ]);
  expect(JSON.stringify(h.warn.mock.calls)).not.toContain(PAYEE_HMAC);
});

it('[AC-B2-05v#4] 账号未变：只走一遍，users 锁拿一次，不回滚', async (): Promise<void> => {
  const h = await applyHarness([['alipay', 'bank_card']]);
  expect((await h.apply()).code).toBe(0);
  expect(h.lockUsersForUpdate).toHaveBeenCalledTimes(1);
  expect(rollbacks(h.statements)).toBe(0);
});
