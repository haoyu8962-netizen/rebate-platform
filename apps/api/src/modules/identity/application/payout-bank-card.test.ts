import { createHash } from 'node:crypto';
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
import { afterEach, expect, it, vi } from 'vitest';
import { FixedClock, createRootLogger, type FieldCrypto } from '../../platform/index.ts';
import type { BankCardVerifierPort, CardBinPort } from '../ports/bank-card-verifier.ts';
import {
  createBankCardBinding,
  type BankCardBindingOptions,
  type BankCardSubmitCommand,
} from './payout-bank-card.ts';
import {
  ATTEMPT_PREDATES_CORRECTION,
  type PayoutAccountConfigPort,
  type PayoutAccountService,
  type SaveBankCardResult,
} from './payout-account.ts';

const NOW = '2026-10-18T04:00:00.000Z';
const CARD = '9900010000000019';
const NAME = '阿依古丽·买买提';
const ID_NO = 'demo-id-0001';
const USER = '00000000-0000-7000-8000-000000000001';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

type Event =
  | { readonly on: 'claim' | 'pool'; readonly kind: 'begin' | 'commit' | 'rollback' }
  | { readonly on: 'claim' | 'pool'; readonly kind: 'query'; readonly query: CompiledQuery }
  | { readonly on: 'vendor' | 'service'; readonly kind: string };

type Responder = (query: CompiledQuery) => QueryResult<unknown> | undefined;

async function scripted(on: 'claim' | 'pool', events: Event[], respond: Responder) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  connection.executeQuery = async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
    events.push({ on, kind: 'query', query });
    return (respond(query) ?? { rows: [] }) as QueryResult<R>;
  };
  driver.acquireConnection = async () => connection;
  driver.beginTransaction = async () => void events.push({ on, kind: 'begin' });
  driver.commitTransaction = async () => void events.push({ on, kind: 'commit' });
  driver.rollbackTransaction = async () => void events.push({ on, kind: 'rollback' });
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  handles.push(db);
  return db;
}

/** What the pool database holds for the reservation reads. */
interface Store {
  own?: Record<string, unknown>;
  latest: Record<string, unknown>[];
  occupied: number;
  current?: Record<string, unknown>;
  updated: bigint;
  /** The verified realname row's verified_at and row_version (B1-27a: a corrected row). */
  realname?: { readonly verified_at: Date; readonly row_version: number };
}

function attemptRow(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b',
    app_id: 'app_a',
    user_id: USER,
    verify_date: '2026-10-18',
    status,
    vendor_request_id: '0199a3b4-0000-7000-8000-00000000abcd',
    request_fingerprint: fingerprintOf(CARD),
    reserved_at: new Date(NOW),
    unknown_at: status === 'unknown' ? new Date(NOW) : null,
    resolved_at: status === 'matched' ? new Date(NOW) : null,
    idempotency_key: 'other-key-1',
    row_version: 1,
    ...overrides,
  };
}

function responder(store: Store): Responder {
  return (query) => {
    const text = query.sql;
    if (text.startsWith('update')) return { rows: [], numAffectedRows: store.updated };
    if (text.startsWith('insert')) return { rows: [], numAffectedRows: 1n };
    if (text.includes('from "app"."users"')) return { rows: [{ phone_cipher: null }] };
    if (text.includes('from "app"."realname"')) {
      return {
        rows: [
          {
            id: 'rn-1',
            name_cipher: Buffer.from(NAME),
            id_no_cipher: Buffer.from(ID_NO),
            ...(store.realname ?? {
              verified_at: new Date('2026-03-01T00:00:00Z'),
              row_version: 0,
            }),
          },
        ],
      };
    }
    if (text.includes('from "app"."payout_account_changes"')) return { rows: [{ n: '0' }] };
    if (text.startsWith('select "id" from "app"."payout_accounts"')) return { rows: [] };
    if (text.includes('from "app"."payout_accounts"')) {
      return { rows: store.current === undefined ? [] : [store.current] };
    }
    if (text.includes('count(*)')) return { rows: [{ n: String(store.occupied) }] };
    if (text.includes('"idempotency_key" =')) {
      return { rows: store.own === undefined ? [] : [store.own] };
    }
    if (text.includes('"request_fingerprint" =')) {
      const next = store.latest.shift();
      return { rows: next === undefined ? [] : [next] };
    }
    if (text.includes('from "app"."payout_account_verify_attempts"')) return { rows: [] };
    return undefined;
  };
}

const crypto = {
  blindIndex: (value: string, context: string) =>
    createHash('sha256').update(`${context}\0${value}`).digest('hex'),
  decrypt: (cipher: string) => cipher,
  encrypt: (plain: string) => plain,
} as unknown as FieldCrypto;

/** The request fingerprint the flow builds: realname record id and the card's blind index. */
function fingerprintOf(cardNo: string, realnameId = 'rn-1'): string {
  return `${realnameId}:${crypto.blindIndex(cardNo, 'payout_accounts.bank_card')}`;
}

/** A Luhn-valid demo card number of the 990001 BIN (serial varies the account digits). */
function demoCard(serial: number): string {
  const prefix = `990001${String(serial).padStart(9, '0')}`;
  const sum = [...prefix].reverse().reduce((total, digit, i) => {
    const n = Number(digit) * (i % 2 === 0 ? 2 : 1);
    return total + (n > 9 ? n - 9 : n);
  }, 0);
  return prefix + String((10 - (sum % 10)) % 10);
}

const command: BankCardSubmitCommand = {
  appId: 'app_a',
  userId: USER,
  cardNo: `${CARD.slice(0, 4)} ${CARD.slice(4, 8)}-${CARD.slice(8)}`,
  payeeName: NAME,
  idempotencyKey: 'this-key-001',
};

const SAVED: SaveBankCardResult = {
  code: 0,
  data: {
    payout_account_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a81',
    payout_method: 'bank_card',
    masked_account: '尾号 0019',
    bank_name: '示例银行',
    masked_payee_name: '*******提',
    change_remaining_this_month: 2,
  },
};

async function harness(
  store: Partial<Store> = {},
  options: {
    config?: Readonly<Record<string, unknown>>;
    verify?: BankCardVerifierPort['verify'];
    query?: BankCardVerifierPort['query'];
    save?: SaveBankCardResult;
    bin?: CardBinPort | null;
    verifier?: null;
    blocked?: boolean;
  } = {},
) {
  const events: Event[] = [];
  const state: Store = { latest: [], occupied: 0, updated: 1n, ...store };
  const pool = await scripted('pool', events, responder(state));
  const claim = await scripted('claim', events, responder(state));
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const verify = vi.fn<BankCardVerifierPort['verify']>(async (input) => {
    events.push({ on: 'vendor', kind: 'verify' });
    return options.verify === undefined ? 'match' : options.verify(input);
  });
  const query = vi.fn<BankCardVerifierPort['query']>(async (id) => {
    events.push({ on: 'vendor', kind: 'query' });
    return options.query === undefined ? 'unknown' : options.query(id);
  });
  const saveBankCard = vi.fn<PayoutAccountService['saveBankCard']>(async () => {
    events.push({ on: 'service', kind: 'save' });
    return options.save ?? SAVED;
  });
  const lookup = vi.fn<CardBinPort['lookup']>(async () => ({
    card_type: 'debit' as const,
    bank_name: '示例银行',
    bin: '990001',
  }));
  const values = options.config ?? {};
  const config: PayoutAccountConfigPort = {
    configValue: (_appId, key) =>
      Promise.resolve(Object.hasOwn(values, key) ? { value: values[key] } : null),
  };
  const check = vi.fn(async () =>
    options.blocked === true
      ? { code: 44001 as const, data: { risk_msg_code: 'blocklist.other' }, ref_id: 'ref' }
      : null,
  );
  const bindingOptions: BankCardBindingOptions = {
    db: pool,
    clock: new FixedClock(NOW),
    crypto,
    logger,
    blocklist: { check },
    accounts: { saveBankCard },
    cardBin: options.bin === undefined ? { lookup } : options.bin,
    verifier: options.verifier === null ? null : { verify, query },
    config,
    vendorTimeoutMs: 20,
  };
  const binding = createBankCardBinding(bindingOptions);
  const submit = (input: Partial<BankCardSubmitCommand> = {}) =>
    claim
      .transaction()
      .execute((trx) => binding.submit(trx as Transaction<DB>, { ...command, ...input }));
  const writes = (on: 'claim' | 'pool') =>
    events.flatMap((event) =>
      event.on === on &&
      event.kind === 'query' &&
      'query' in event &&
      /^(update|insert into) "app"\."payout_account_verify_attempts"/.test(event.query.sql)
        ? [event.query]
        : [],
    );
  const index = (predicate: (event: Event) => boolean) => events.findIndex(predicate);
  return {
    events,
    state,
    submit,
    verify,
    query,
    saveBankCard,
    lookup,
    check,
    lines,
    writes,
    index,
  };
}

const isInsert = (event: Event) =>
  'query' in event &&
  event.query.sql.startsWith('insert into "app"."payout_account_verify_attempts"');

it.each([
  [
    'payout_methods without bank_card',
    { config: { 'withdraw.payout_methods': ['alipay'] } },
    {},
    {
      code: 20001,
      data: { fields: ['payout_method'] },
    },
  ],
  ['11 digits', {}, { cardNo: CARD.slice(0, 11) }, { code: 20001, data: { fields: ['card_no'] } }],
  [
    'a broken Luhn digit',
    {},
    { cardNo: `${CARD.slice(0, -1)}8` },
    {
      code: 20001,
      data: { fields: ['card_no'] },
    },
  ],
  ['a plus sign', {}, { cardNo: `+${CARD}` }, { code: 20001, data: { fields: ['card_no'] } }],
  ['no BIN source', { bin: null }, {}, { code: 50301 }],
  ['no verifier', { verifier: null }, {}, { code: 50301 }],
] as const)(
  '[AC-B1-13f] %s is refused before any lock or reservation',
  async (_name, options, input, result) => {
    const f = await harness({}, options);
    expect(await f.submit(input)).toEqual(result);
    // Only the claim's own begin / commit: no query on either database, nothing reserved.
    expect(f.events.filter((event) => event.kind === 'query')).toEqual([]);
    expect(f.events.filter((event) => event.on === 'pool')).toEqual([]);
    expect(f.verify).not.toHaveBeenCalled();
  },
);

it.each([
  ['credit', { card_type: 'credit' as const, bank_name: '示例银行', bin: '990009' }],
  ['unrecognised', null],
])('[AC-B1-13f] a %s BIN is 20001 card_no without a reservation', async (_name, answer) => {
  const lookup = vi.fn<CardBinPort['lookup']>(async () => answer);
  const f = await harness({}, { bin: { lookup } });
  expect(await f.submit()).toEqual({ code: 20001, data: { fields: ['card_no'] } });
  expect(lookup).toHaveBeenCalledExactlyOnceWith(CARD);
  expect(f.events.filter((event) => event.on === 'pool')).toEqual([]);
});

it('[AC-B1-13f] a failing BIN lookup is 50301 and its error is not logged', async () => {
  const lookup = vi.fn<CardBinPort['lookup']>(() => Promise.reject(new Error(`bin ${CARD}`)));
  const f = await harness({}, { bin: { lookup } });
  expect(await f.submit()).toEqual({ code: 50301 });
  expect(JSON.stringify(f.lines)).not.toContain(CARD);
});

it('[AC-B1-13f] new verification: reserve in a committed pool transaction, then the vendor, then matched with the save', async () => {
  const f = await harness();
  expect(await f.submit()).toEqual(SAVED);
  const insert = f.index(isInsert);
  const reserveCommit = f.events.findIndex(
    (event, at) => at > insert && event.on === 'pool' && event.kind === 'commit',
  );
  const verify = f.index((event) => event.on === 'vendor');
  const save = f.index((event) => event.on === 'service');
  const settle = f.index(
    (event) => event.on === 'claim' && 'query' in event && event.query.sql.startsWith('update'),
  );
  expect(insert).toBeGreaterThan(-1);
  expect(reserveCommit).toBeGreaterThan(insert);
  expect(verify).toBeGreaterThan(reserveCommit);
  expect(save).toBeGreaterThan(verify);
  expect(settle).toBeGreaterThan(save);
  // The users lock was taken by the pool transaction only, before the reservation.
  const locks = f.events.filter(
    (event) => 'query' in event && event.query.sql.endsWith('for no key update'),
  );
  expect(locks.map((event) => event.on)).toEqual(['pool']);
  const [input] = f.verify.mock.calls[0]!;
  expect(Object.keys(input).sort()).toEqual(['card_no', 'id_no', 'name', 'vendor_request_id']);
  expect(input).toMatchObject({ card_no: CARD, name: NAME, id_no: ID_NO });
  const inserted = f.writes('pool')[0]!;
  expect(inserted.parameters).toContain('this-key-001');
  expect(inserted.parameters).toContain(input.vendor_request_id);
  expect(inserted.parameters).toContain('2026-10-18');
  expect(f.writes('claim')[0]!.parameters.slice(0, 2)).toEqual(['matched', 1]);
  expect(f.saveBankCard).toHaveBeenCalledWith(expect.anything(), {
    appId: 'app_a',
    userId: USER,
    cardNo: CARD,
    payeeName: NAME,
    bankName: '示例银行',
    cardBin: '990001',
    attemptReservedAt: new Date(NOW),
  });
  const text = JSON.stringify(f.lines);
  for (const secret of [CARD, ID_NO, NAME]) expect(text).not.toContain(secret);
});

it.each([
  [{ code: 30303, data: { reason: 'payout_account_change_limit' } } as const, 'claim'],
  [{ code: 30308 } as const, 'claim'],
  [{ code: 44001, data: { risk_msg_code: 'blocklist.other' } } as const, 'pool'],
  [{ code: 20001, data: { fields: ['payout_method'] } } as const, 'pool'],
] as const)(
  '[AC-B1-13f] a save answer %j keeps matched (written on the %s handle)',
  async (answer, on) => {
    const f = await harness({}, { save: answer });
    expect(await f.submit()).toEqual(answer);
    const other = on === 'claim' ? 'pool' : 'claim';
    expect(f.writes(on).filter((q) => q.sql.startsWith('update'))[0]!.parameters[0]).toBe(
      'matched',
    );
    expect(f.writes(other).filter((q) => q.sql.startsWith('update'))).toEqual([]);
  },
);

it('[AC-B1-13f] a stored save whose record another writer ended answers 40901', async () => {
  // Every CAS loses and the reread finds no reserved / unknown row any more.
  const f = await harness({ updated: 0n });
  expect(await f.submit()).toEqual({ code: 40901 });
  expect(f.saveBankCard).toHaveBeenCalledTimes(1);
});

it('[AC-B1-13f] mismatch: users lock on the claim, then mismatched, 30307', async () => {
  const f = await harness({}, { verify: async () => 'mismatch' });
  expect(await f.submit()).toEqual({ code: 30307 });
  const claimQueries = f.events.flatMap((event) =>
    event.on === 'claim' && 'query' in event ? [event.query.sql] : [],
  );
  expect(claimQueries).toHaveLength(2);
  expect(claimQueries[0]).toMatch(
    /^select "phone_cipher" from "app"\."users" .* for no key update$/,
  );
  expect(claimQueries[1]).toMatch(/^update "app"\."payout_account_verify_attempts" /);
  expect(f.writes('claim')[0]!.parameters.slice(0, 2)).toEqual(['mismatched', 1]);
  expect(f.saveBankCard).not.toHaveBeenCalled();
});

it.each([
  ['a hang', () => new Promise<'match'>(() => undefined)],
  ['an error', () => Promise.reject(new Error(`vendor ${CARD} ${ID_NO}`))],
])(
  '[AC-B1-13f] %s of verify: unknown on the pool, 50401, nothing logged of the input',
  async (_name, verify) => {
    const f = await harness({}, { verify });
    expect(await f.submit()).toEqual({ code: 50401 });
    expect(f.writes('pool').map((q) => q.parameters[0])).toContain('unknown');
    expect(f.writes('claim')).toEqual([]);
    expect(f.saveBankCard).not.toHaveBeenCalled();
    const text = JSON.stringify(f.lines);
    for (const secret of [CARD, ID_NO, NAME]) expect(text).not.toContain(secret);
  },
);

it.each([
  [
    'reserved within its lease',
    attemptRow('reserved', { idempotency_key: 'this-key-001' }),
    {
      code: 40901,
    },
    0,
  ],
  [
    'reserved past its lease',
    attemptRow('reserved', {
      idempotency_key: 'this-key-001',
      reserved_at: new Date('2026-10-18T03:58:00Z'),
    }),
    { code: 40901 },
    1,
  ],
  ['unknown', attemptRow('unknown', { idempotency_key: 'this-key-001' }), { code: 40901 }, 0],
  [
    'mismatched',
    attemptRow('mismatched', { idempotency_key: 'this-key-001' }),
    {
      code: 30307,
    },
    0,
  ],
  [
    'expired_unresolved',
    attemptRow('expired_unresolved', { idempotency_key: 'this-key-001' }),
    {
      code: 50401,
    },
    0,
  ],
] as const)(
  "[AC-B1-13f] the key's own %s record answers without vendor, quota or a new record",
  async (_name, own, result, updates) => {
    const f = await harness({ own, occupied: 99 });
    expect(await f.submit()).toEqual(result);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
    expect(f.events.some(isInsert)).toBe(false);
    expect(f.writes('pool').filter((q) => q.sql.startsWith('update'))).toHaveLength(updates);
  },
);

it("[AC-B1-13f] the key's own matched record saves whatever its age, without settling it again", async () => {
  const own = attemptRow('matched', {
    idempotency_key: 'this-key-001',
    resolved_at: new Date('2026-10-01T00:00:00Z'),
  });
  const f = await harness({ own, occupied: 99 });
  expect(await f.submit()).toEqual(SAVED);
  expect(f.writes('claim')).toEqual([]);
  expect(f.writes('pool')).toEqual([]);
});

it("[AC-B1-13f] the fingerprint's matched record within the reuse period is reused before the quota", async () => {
  const f = await harness({ latest: [attemptRow('matched')], occupied: 99 });
  expect(await f.submit()).toEqual(SAVED);
  expect(f.verify).not.toHaveBeenCalled();
  expect(f.events.some(isInsert)).toBe(false);
});

it('[AC-B1-13f] a full day answers 30303 verify_limit without a vendor call', async () => {
  const f = await harness({ latest: [attemptRow('mismatched')], occupied: 3 });
  expect(await f.submit()).toEqual({
    code: 30303,
    data: { reason: 'payout_account_verify_limit' },
  });
  expect(f.verify).not.toHaveBeenCalled();
  expect(f.events.some(isInsert)).toBe(false);
});

it.each([
  ['match', SAVED, 'matched'],
  ['mismatch', { code: 30307 }, 'mismatched'],
  ['unknown', { code: 40901 }, undefined],
] as const)(
  "[AC-B1-13f] the fingerprint's unknown record is queried outside the lock: %s",
  async (answer, result, status) => {
    const f = await harness({ latest: [attemptRow('unknown')] }, { query: async () => answer });
    expect(await f.submit()).toEqual(result);
    expect(f.query).toHaveBeenCalledExactlyOnceWith('0199a3b4-0000-7000-8000-00000000abcd');
    expect(f.verify).not.toHaveBeenCalled();
    const lastPoolCommit = f.events
      .map((event) => event.on === 'pool' && event.kind === 'commit')
      .lastIndexOf(true);
    expect(f.index((event) => event.on === 'vendor')).toBeGreaterThan(lastPoolCommit);
    expect(f.writes('claim').map((q) => q.parameters[0])).toEqual(
      status === undefined ? [] : [status],
    );
  },
);

it('[AC-B1-13f] not_found ends the old record, then a new reservation and verification', async () => {
  const f = await harness(
    { latest: [attemptRow('unknown'), attemptRow('expired_unresolved')] },
    { query: async () => 'not_found' },
  );
  expect(await f.submit()).toEqual(SAVED);
  const pool = f.writes('pool');
  expect(pool[0]!.sql.startsWith('update')).toBe(true);
  expect(pool[0]!.parameters[0]).toBe('expired_unresolved');
  expect(pool[1]!.sql.startsWith('insert')).toBe(true);
  expect(f.verify).toHaveBeenCalledTimes(1);
  expect(f.verify.mock.calls[0]![0].vendor_request_id).not.toBe(
    '0199a3b4-0000-7000-8000-00000000abcd',
  );
  expect(f.lines.filter((line) => line['level'] === 50)).toEqual([]);
});

it('[AC-B1-13f] an unknown record past its recheck deadline ends with one alarm line, then a new verification', async () => {
  const old = attemptRow('unknown', { unknown_at: new Date('2026-10-18T03:30:00Z') });
  const f = await harness({ latest: [old, attemptRow('expired_unresolved')] });
  expect(await f.submit()).toEqual(SAVED);
  expect(f.query).toHaveBeenCalledTimes(1);
  expect(f.verify).toHaveBeenCalledTimes(1);
  const errors = f.lines.filter((line) => line['level'] === 50);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ vendor_request_id: old.vendor_request_id, user_id: USER });
});

it("[AC-B1-13f] the fingerprint's reserved record past its lease is taken over and queried", async () => {
  const f = await harness(
    { latest: [attemptRow('reserved', { reserved_at: new Date('2026-10-18T03:58:00Z') })] },
    { query: async () => 'match' },
  );
  expect(await f.submit()).toEqual(SAVED);
  expect(f.writes('pool').map((q) => q.parameters[0])).toEqual(['unknown']);
  // The settle CAS starts from the taken-over state (row_version + 1).
  expect(f.writes('claim')[0]!.parameters.slice(0, 2)).toEqual(['matched', 3]);
  expect(f.verify).not.toHaveBeenCalled();
});

it('[AC-B1-13f] the same card as the current binding answers it without any verification read', async () => {
  const current = {
    id: 'acc-1',
    payout_method: 'bank_card',
    alipay_hmac: null,
    alipay_logon_id_cipher: null,
    bank_card_hmac: crypto.blindIndex(CARD, 'payout_accounts.bank_card'),
    bank_card_no_cipher: Buffer.from(CARD),
    bank_name: '示例银行',
    payee_name: NAME,
    row_version: 0,
  };
  const f = await harness({ current });
  expect(await f.submit()).toEqual({
    code: 0,
    data: {
      payout_account_id: 'acc-1',
      payout_method: 'bank_card',
      masked_account: '尾号 0019',
      bank_name: '示例银行',
      masked_payee_name: '*******提',
      change_remaining_this_month: 2,
    },
  });
  expect(
    f.events.some(
      (event) => 'query' in event && event.query.sql.includes('payout_account_verify_attempts'),
    ),
  ).toBe(false);
  expect(f.verify).not.toHaveBeenCalled();
});

it('[AC-B1-13f] a blocklisted card is 44001 inside the lock, before any record read', async () => {
  const f = await harness({}, { blocked: true });
  expect(await f.submit()).toEqual({ code: 44001, data: { risk_msg_code: 'blocklist.other' } });
  expect(f.check).toHaveBeenCalledWith(
    expect.objectContaining({
      dimension: 'bank_card',
      value_hmac: crypto.blindIndex(CARD, 'payout_accounts.bank_card'),
      request_type: 'payout_account',
    }),
  );
  expect(
    f.events.some(
      (event) => 'query' in event && event.query.sql.includes('payout_account_verify_attempts'),
    ),
  ).toBe(false);
});

const CARD_B = demoCard(2);

it('[AC-B1-13f] demo card numbers of the tests are Luhn-valid and distinct', () => {
  expect(demoCard(1)).toBe(CARD);
  expect(CARD_B).not.toBe(CARD);
  expect(CARD_B).toHaveLength(16);
});

it('[AC-B1-13f] S0: after 50401 the key keeps only its record; once that record matched, the key with another card is 20901 and nothing is saved', async () => {
  // 1) Key K, card A: the vendor hangs → unknown, 50401 (the claim stores nothing for 5xxxx).
  const f = await harness({}, { verify: () => new Promise<'match'>(() => undefined) });
  expect(await f.submit()).toEqual({ code: 50401 });
  const reserved = f.writes('pool').find((q) => q.sql.startsWith('insert'))!;
  expect(reserved.parameters).toContain('this-key-001');
  expect(reserved.parameters).toContain(fingerprintOf(CARD));
  expect(f.saveBankCard).not.toHaveBeenCalled();
  // 2) Another key's recheck turned K's record into matched (still bound to K, card A).
  f.state.own = attemptRow('matched', { idempotency_key: 'this-key-001' });
  const before = f.events.length;
  // 3) K again, now with card B of somebody else: refused, never saved, no vendor, no quota.
  expect(await f.submit({ cardNo: CARD_B })).toEqual({ code: 20901 });
  const after = f.events.slice(before);
  expect(f.saveBankCard).not.toHaveBeenCalled();
  expect(after.some((event) => event.on === 'vendor')).toBe(false);
  expect(after.some(isInsert)).toBe(false);
  expect(
    after.some(
      (event) =>
        'query' in event && /^update "app"\."payout_account_verify_attempts"/.test(event.query.sql),
    ),
  ).toBe(false);
  expect(f.verify).toHaveBeenCalledTimes(1);
  // 4) K with card A itself still reuses its own matched record and saves card A.
  expect(await f.submit()).toEqual(SAVED);
  expect(f.saveBankCard).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.objectContaining({ cardNo: CARD }),
  );
  expect(f.verify).toHaveBeenCalledTimes(1);
});

it.each([
  ['reserved within its lease', 'reserved', {}],
  ['reserved past its lease', 'reserved', { reserved_at: new Date('2026-10-18T03:58:00Z') }],
  ['unknown', 'unknown', {}],
  ['matched', 'matched', {}],
  ['mismatched', 'mismatched', {}],
  ['expired_unresolved', 'expired_unresolved', {}],
] as const)(
  "[AC-B1-13f] the key's own %s record of another card answers 20901 before its status",
  async (_name, status, overrides) => {
    const own = attemptRow(status, { idempotency_key: 'this-key-001', ...overrides });
    const f = await harness({ own, occupied: 99 });
    expect(await f.submit({ cardNo: CARD_B })).toEqual({ code: 20901 });
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
    expect(f.saveBankCard).not.toHaveBeenCalled();
    // No takeover, no new record, no quota read for the refused key.
    expect(f.writes('pool')).toEqual([]);
    expect(f.writes('claim')).toEqual([]);
    const quotaRead = (event: (typeof f.events)[number]) =>
      'query' in event &&
      event.query.sql.includes('count(*)') &&
      event.query.sql.includes('"payout_account_verify_attempts"');
    expect(f.events.some(quotaRead)).toBe(false);
  },
);

it("[AC-B1-13f] the key's own matched record under another real-name record is 20901 too", async () => {
  const own = attemptRow('matched', {
    idempotency_key: 'this-key-001',
    request_fingerprint: fingerprintOf(CARD, 'rn-earlier'),
  });
  const f = await harness({ own });
  expect(await f.submit()).toEqual({ code: 20901 });
  expect(f.saveBankCard).not.toHaveBeenCalled();
});

it('[AC-B1-13f] reuse by fingerprint saves exactly the card of that fingerprint', async () => {
  // The fingerprint query is keyed by this request's card, so card B never sees card A's record.
  const f = await harness({ latest: [attemptRow('matched')] });
  expect(await f.submit()).toEqual(SAVED);
  const lookup = f.events.find(
    (event) => 'query' in event && event.query.sql.includes('"request_fingerprint" ='),
  );
  expect(lookup !== undefined && 'query' in lookup && lookup.query.parameters).toContain(
    fingerprintOf(CARD),
  );
  expect(f.saveBankCard).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ cardNo: CARD }),
  );
});

it("[AC-B1-13f] a record whose fingerprint is not the request's is never applied (invariant)", async () => {
  // A fingerprint-path answer carrying a foreign record is a broken invariant: refused loudly.
  const f = await harness({
    latest: [attemptRow('matched', { request_fingerprint: fingerprintOf(CARD_B) })],
  });
  await expect(f.submit()).rejects.toThrow(/another card or real name/);
  expect(f.saveBankCard).not.toHaveBeenCalled();
});

/** B1-27a: the realname row was corrected (rewritten in place) one hour before NOW. */
const CORRECTED = { verified_at: new Date('2026-10-18T03:00:00Z'), row_version: 2 };
const BEFORE_CORRECTION = new Date('2026-10-18T02:59:59Z');

it("[AC-B1-27a] after a real-name correction the key's own matched record of the old identity is 20901 (whatever its age), nothing saved", async () => {
  const own = attemptRow('matched', {
    idempotency_key: 'this-key-001',
    reserved_at: BEFORE_CORRECTION,
    resolved_at: BEFORE_CORRECTION,
  });
  const f = await harness({ own, realname: CORRECTED });
  expect(await f.submit()).toEqual({ code: 20901 });
  expect(f.saveBankCard).not.toHaveBeenCalled();
  expect(f.verify).not.toHaveBeenCalled();
  expect(f.events.some(isInsert)).toBe(false);
  // Control: the key's record of the current identity still saves, whatever its age.
  const fresh = await harness({
    own: attemptRow('matched', {
      idempotency_key: 'this-key-001',
      reserved_at: CORRECTED.verified_at,
      resolved_at: new Date('2026-10-18T03:00:01Z'),
    }),
    realname: CORRECTED,
  });
  expect(await fresh.submit()).toEqual(SAVED);
});

it("[AC-B1-27a] after a real-name correction the fingerprint's matched record of the old identity is not reused: a new paid verification", async () => {
  const old = attemptRow('matched', {
    reserved_at: BEFORE_CORRECTION,
    resolved_at: BEFORE_CORRECTION,
  });
  const f = await harness({ latest: [old], realname: CORRECTED });
  expect(await f.submit()).toEqual(SAVED);
  expect(f.events.some(isInsert)).toBe(true);
  expect(f.verify).toHaveBeenCalledTimes(1);
  expect(f.verify.mock.calls[0]![0]).toMatchObject({ name: NAME, id_no: ID_NO });
  expect(f.query).not.toHaveBeenCalled();
  // Control: within the reuse period and after the correction it is reused.
  const fresh = await harness({
    latest: [attemptRow('matched', { reserved_at: CORRECTED.verified_at })],
    realname: CORRECTED,
  });
  expect(await fresh.submit()).toEqual(SAVED);
  expect(fresh.verify).not.toHaveBeenCalled();
});

it.each(['unknown', 'reserved'] as const)(
  "[AC-B1-27a] after a real-name correction the fingerprint's %s record of the old identity is neither taken over nor rechecked",
  async (status) => {
    const old = attemptRow(status, { reserved_at: BEFORE_CORRECTION });
    const f = await harness({ latest: [old], realname: CORRECTED }, { query: async () => 'match' });
    expect(await f.submit()).toEqual(SAVED);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.verify).toHaveBeenCalledTimes(1);
    const pool = f.writes('pool');
    expect(pool.filter((q) => q.sql.startsWith('update'))).toEqual([]);
    expect(pool.some((q) => q.sql.startsWith('insert'))).toBe(true);
  },
);

it('[AC-B1-27a] a realname row never rewritten after its insert (row_version 0) keeps every record of its id', async () => {
  const own = attemptRow('matched', {
    idempotency_key: 'this-key-001',
    reserved_at: new Date('2026-01-01T00:00:00Z'),
  });
  const f = await harness({
    own,
    realname: { verified_at: new Date('2026-10-18T03:00:00Z'), row_version: 0 },
  });
  expect(await f.submit()).toEqual(SAVED);
});

/** saveBankCard's internal answer; the harness option is typed for the public results only. */
const PREDATES = ATTEMPT_PREDATES_CORRECTION as unknown as SaveBankCardResult;

it('[AC-B1-27l] verify path: the save is told the reserved_at and a record predating a correction is matched alone, 40901', async () => {
  const f = await harness({}, { save: PREDATES });
  expect(await f.submit()).toEqual({ code: 40901 });
  expect(f.saveBankCard.mock.calls[0]![1].attemptReservedAt).toEqual(new Date(NOW));
  expect(f.writes('pool').filter((q) => q.sql.startsWith('update'))[0]!.parameters[0]).toBe(
    'matched',
  );
  expect(f.writes('claim')).toEqual([]);
});

it('[AC-B1-27l] recheck path: a record predating a correction is matched alone, 40901, no new verification', async () => {
  const reservedAt = new Date('2026-10-18T03:59:50Z');
  const f = await harness(
    { latest: [attemptRow('unknown', { reserved_at: reservedAt })] },
    { save: PREDATES, query: async () => 'match' },
  );
  expect(await f.submit()).toEqual({ code: 40901 });
  expect(f.saveBankCard.mock.calls[0]![1].attemptReservedAt).toEqual(reservedAt);
  expect(f.query).toHaveBeenCalledTimes(1);
  expect(f.verify).not.toHaveBeenCalled();
  expect(f.writes('pool').filter((q) => q.sql.startsWith('update'))[0]!.parameters[0]).toBe(
    'matched',
  );
  expect(f.writes('claim')).toEqual([]);
});

it('[AC-B1-27l] a reused matched record predating a later correction is 40901 and is not settled again', async () => {
  const f = await harness({ latest: [attemptRow('matched')] }, { save: PREDATES });
  expect(await f.submit()).toEqual({ code: 40901 });
  expect(f.writes('pool')).toEqual([]);
  expect(f.writes('claim')).toEqual([]);
});
