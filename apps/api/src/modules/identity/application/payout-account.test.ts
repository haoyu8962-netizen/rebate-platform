import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type QueryResult,
  type Transaction,
} from 'kysely';
import { afterEach, expect, it } from 'vitest';
import { FixedClock, createRootLogger, type FieldCrypto } from '../../platform/index.ts';
import {
  ATTEMPT_PREDATES_CORRECTION,
  createPayoutAccountService,
  project,
  type CurrentAccount,
  type PayoutAccountConfigPort,
  type SaveAlipayCommand,
} from './payout-account.ts';

// A handle that fails any query: the pre-lock refusals must not touch the database themselves.
function untouchable(): { trx: Transaction<DB>; handle: Kysely<DB> } {
  const handle = new Proxy(
    {},
    {
      get(_target, name) {
        throw new Error(`database touched: ${String(name)}`);
      },
    },
  ) as Kysely<DB>;
  const trx = { withSchema: () => handle } as unknown as Transaction<DB>;
  return { trx, handle };
}

function harness(values: Readonly<Record<string, unknown>>) {
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const reads: { appId: string; key: string; handle: unknown }[] = [];
  const config: PayoutAccountConfigPort = {
    configValue(appId, key, handle) {
      reads.push({ appId, key, handle });
      return Promise.resolve(Object.hasOwn(values, key) ? { value: values[key] } : null);
    },
  };
  const service = createPayoutAccountService({
    db: untouchable().handle,
    clock: new FixedClock('2026-10-18T04:00:00.000Z'),
    crypto: {} as FieldCrypto,
    logger,
    blocklist: { check: () => Promise.reject(new Error('blocklist consulted')) },
    config,
  });
  return { service, lines, reads };
}

const command: SaveAlipayCommand = {
  appId: 'app_a',
  userId: '00000000-0000-7000-8000-000000000001',
  alipayLogonId: 'zhang.san@example.com',
  payeeName: '张三',
};

it('[AC-B1-13e] save: the injected port decides payout_methods before any query or lock', async () => {
  const { service, reads } = harness({ 'withdraw.payout_methods': ['bank_card'] });
  const { trx, handle } = untouchable();
  expect(await service.save(trx, { ...command, alipayLogonId: '@' })).toEqual({
    code: 20001,
    data: { fields: ['payout_method'] },
  });
  expect(reads.map((read) => [read.appId, read.key])).toEqual([
    ['app_a', 'withdraw.payout_methods'],
    ['app_a', 'withdraw.payout_account_change_per_month'],
  ]);
  // The port is handed the caller's handle (the transaction), never the pool.
  for (const read of reads) expect(read.handle).toBe(handle);
});

it('[AC-B1-13e] save: an invalid logon id is refused before the lock', async () => {
  const { service } = harness({ 'withdraw.payout_methods': ['alipay'] });
  expect(
    await service.save(untouchable().trx, { ...command, alipayLogonId: '+852 5123 4567' }),
  ).toEqual({ code: 20001, data: { fields: ['alipay_logon_id'], reason: 'phone_invalid' } });
  expect(await service.save(untouchable().trx, { ...command, alipayLogonId: 'a@b@c' })).toEqual({
    code: 20001,
    data: { fields: ['alipay_logon_id'] },
  });
});

it('[AC-B1-13e] save: missing or malformed configuration warns with config_key only', async () => {
  const { service, lines } = harness({
    'withdraw.payout_methods': ['bank_card', 'bank_card'],
    'withdraw.payout_account_change_per_month': 1.5,
  });
  // Malformed methods fall back to the default (alipay open), so the logon check answers.
  expect(await service.save(untouchable().trx, { ...command, alipayLogonId: '@' })).toEqual({
    code: 20001,
    data: { fields: ['alipay_logon_id'] },
  });
  const warnings = lines.filter((line) => line['level'] === 40);
  expect(warnings.map((line) => line['config_key'])).toEqual([
    'withdraw.payout_methods',
    'withdraw.payout_account_change_per_month',
  ]);
  for (const warning of warnings) {
    expect(Object.keys(warning).sort()).toEqual(
      ['config_key', 'entry', 'env', 'level', 'msg', 'pid', 'time'].sort(),
    );
  }
});

// A stand-in for the field cipher: the stored "cipher" is the plain text (masking is what matters).
const plainCrypto = { decrypt: (cipher: string) => cipher } as unknown as FieldCrypto;

const ROW_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a80';

function row(overrides: Partial<CurrentAccount>): CurrentAccount {
  return {
    id: ROW_ID,
    payout_method: 'alipay',
    alipay_hmac: 'hmac-alipay',
    alipay_logon_id_cipher: Buffer.from('13812345678', 'utf8'),
    bank_card_hmac: null,
    bank_card_no_cipher: null,
    bank_name: null,
    payee_name: '张三',
    row_version: 1,
    ...overrides,
  };
}

it('[AC-CT-26c] project: an alipay row carries payout_account_id = the current row id', () => {
  const projected = project(row({}), plainCrypto, 2);
  expect(projected.payout_account_id).toBe(ROW_ID);
  expect(Object.keys(projected).sort()).toEqual(
    [
      'change_remaining_this_month',
      'masked_account',
      'masked_payee_name',
      'payout_account_id',
      'payout_method',
    ].sort(),
  );
  expect(projected.payout_method).toBe('alipay');
  expect(projected.masked_account).not.toContain('12345678');
});

it('[AC-CT-26c] project: a bank-card row carries payout_account_id = the current row id', () => {
  const projected = project(
    row({
      id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a81',
      payout_method: 'bank_card',
      alipay_hmac: null,
      alipay_logon_id_cipher: null,
      bank_card_hmac: 'hmac-card',
      bank_card_no_cipher: Buffer.from('6222000000000009', 'utf8'),
      bank_name: '示例银行',
    }),
    plainCrypto,
    0,
  );
  expect(projected).toMatchObject({
    payout_account_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a81',
    payout_method: 'bank_card',
    bank_name: '示例银行',
    change_remaining_this_month: 0,
  });
  expect(projected.masked_account).not.toContain('6222000000000009');
});

// B1-27l: saveBankCard against a scripted database (every statement recorded, in order).
const CORRECTED_AT = new Date('2026-10-18T03:00:00.000Z');
const BEFORE_CORRECTED_AT = new Date('2026-10-18T02:59:59.999Z');
const scriptedHandles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(scriptedHandles.splice(0).map((db) => db.destroy()));
});

async function bankCardHarness(realname: { verified_at: Date; row_version: number }) {
  const statements: string[] = [];
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  connection.executeQuery = async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
    statements.push(query.sql);
    const text = query.sql;
    let rows: unknown[] = [];
    if (text.includes('from "app"."users"')) rows = [{ phone_cipher: null }];
    else if (text.includes('from "app"."realname"')) {
      rows = [
        {
          name_cipher: Buffer.from('张三'),
          birth_date_cipher: Buffer.from('1990-01-01'),
          provider: 'demo',
          ...realname,
        },
      ];
    } else if (text.includes('from "app"."payout_account_changes"')) rows = [{ n: '0' }];
    return { rows, numAffectedRows: text.startsWith('insert') ? 1n : undefined } as QueryResult<R>;
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  scriptedHandles.push(db);
  const service = createPayoutAccountService({
    db,
    clock: new FixedClock('2026-10-18T04:00:00.000Z'),
    crypto: {
      blindIndex: (value: string) => `hmac:${value}`,
      encrypt: (plain: string) => plain,
      decrypt: (cipher: string) => cipher,
    } as unknown as FieldCrypto,
    logger: createRootLogger(
      { level: 'silent', entry: 'api', appEnv: 'test' },
      { write: () => undefined },
    ),
    blocklist: { check: () => Promise.resolve(null) },
    config: { configValue: () => Promise.resolve(null) },
  });
  const save = (attemptReservedAt?: Date) =>
    db.transaction().execute((trx) =>
      service.saveBankCard(trx, {
        appId: 'app_a',
        userId: '00000000-0000-7000-8000-000000000001',
        cardNo: '9900010000000019',
        payeeName: '张三',
        bankName: '示例银行',
        cardBin: '990001',
        ...(attemptReservedAt === undefined ? {} : { attemptReservedAt }),
      }),
    );
  const accountWrites = () =>
    statements.filter((text) => /^(insert into|update) "app"\."payout_account/.test(text));
  return { save, statements, accountWrites };
}

it('[AC-B1-27l] saveBankCard: a record reserved before the correction writes nothing, and the comparison reads after the users lock', async () => {
  const f = await bankCardHarness({ verified_at: CORRECTED_AT, row_version: 1 });
  expect(await f.save(BEFORE_CORRECTED_AT)).toEqual(ATTEMPT_PREDATES_CORRECTION);
  expect(f.accountWrites()).toEqual([]);
  expect(f.statements.some((text) => text.startsWith('savepoint'))).toBe(false);
  const lock = f.statements.findIndex((text) => text.endsWith('for no key update'));
  const compare = f.statements.findIndex(
    (text) => text.includes('"row_version"') && text.includes('from "app"."realname"'),
  );
  expect(lock).toBeGreaterThan(-1);
  expect(compare).toBeGreaterThan(lock);
});

it.each([
  ['reserved at the very instant of the correction', CORRECTED_AT, 1],
  ['reserved after the correction', new Date('2026-10-18T03:00:00.001Z'), 1],
  ['on a realname row never rewritten (row_version 0)', BEFORE_CORRECTED_AT, 0],
] as const)('[AC-B1-27l] saveBankCard: %s binds', async (_name, reservedAt, rowVersion) => {
  const f = await bankCardHarness({ verified_at: CORRECTED_AT, row_version: rowVersion });
  expect(await f.save(reservedAt)).toMatchObject({ code: 0 });
  expect(f.accountWrites()).toHaveLength(1);
});

it('[AC-B1-27l] saveBankCard: without a record instant nothing is compared and the card binds', async () => {
  const f = await bankCardHarness({ verified_at: CORRECTED_AT, row_version: 1 });
  expect(await f.save()).toMatchObject({ code: 0 });
  expect(f.accountWrites()).toHaveLength(1);
  expect(
    f.statements.some(
      (text) => text.includes('"row_version"') && text.includes('from "app"."realname"'),
    ),
  ).toBe(false);
});
