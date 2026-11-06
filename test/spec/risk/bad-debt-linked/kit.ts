// B2-12g rule-test kit (claude-independent, SPEC_REF 18f0015e): 08 BR-FUND-12「核销时给同实名、同设备、
// 同收款账号的关联账户打风控标记」; task brief §10 (D10-727 ③, D10-590 ⑤, D10-758): append-only
// app.risk_linked_marks (id identity, app_id, user_id, source_user_id, source_ref = candidate id,
// dimension id_no | device | payout_account, created_at), written by risk on ledger's approving
// transaction of a bad-debt write-off; trace only.
//
// Real pieces: the api entry of ../../identity/payout-account/kit.ts (members come out of real SMS
// logins through ../blocklist-device-scope/kit.ts smsLogin, so every sessions row is written by
// the login itself and devices.user_id stays NULL as in production), the admin entry of
// ../../ledger/bad-debt-writeoffs/kit.ts withWriteoffAdmin (the real approval POST
// /admin/v1/bad-debt-writeoffs/{id}/approve, step-up, idempotency, audit), both on one PostgreSQL
// as couli_app and one Redis; an Alipay change goes through identity's real save (rebind), and a
// reinstall is a second real POST /v1/devices with the same device_hash (a new devices row).
// Synthetic (fixtures, never on the path under test): the verified real name, the current payout
// account, the funds and the labor agreement of a member (as ../blocklist-device-scope/kit.ts
// seeds them, with a chosen identity number and alipay logon id so two members can share one);
// the negative balance (a plain ledger whose Clock stands on the day it went below 0) and the
// PENDING candidate as the daily job would have generated it; an APPROVED withdrawal holding
// frozen money; a bank card bound earlier and since changed away from (an is_current=false row,
// pastCard); a one-shot fault on the INSERT into app.risk_linked_marks. All values are
// synthetic. A missing table fails as an assertion (requireMarksTable) before anything reads it.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { PostgresQueryCompiler, sql, type Kysely, type KyselyPlugin } from 'kysely';
import { expect } from 'vitest';
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  ALIPAY_CONTEXT,
  BANK_CONTEXT,
  NAME,
  account,
  service,
  type Fixture,
  type Kit,
} from '../../identity/payout-account/kit.ts';
import { phone } from '../../identity/sms-codes/kit.ts';
import { seedWithdrawal } from '../../ledger/admin-adjustments/kit.ts';
import {
  NOW,
  SINCE,
  credit,
  moneyOf,
  noon,
  seedCandidate,
  type AdjustFixture,
  type CandidateRow,
  type Member as LedgerMember,
} from '../../ledger/bad-debt-writeoffs/kit.ts';
import type { Suite } from '../../payment/orders/kit.ts';
import { fund } from '../../payout/apply/kit.ts';
import { smsLogin, type Device, type Session } from '../blocklist-device-scope/kit.ts';

export const TABLE = 'app.risk_linked_marks';
export const DIMENSIONS = ['id_no', 'device', 'payout_account'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
/** The roles of ADR-0001 §4 besides couli_app. */
export const READONLY = 'couli_readonly';
export const NO_ACCESS = ['couli_payout', 'couli_maint'] as const;

const FUNDED_AT = '2026-10-01T02:00:00.000Z';
const ID_NO_CONTEXT = 'realname.id_no';

// ---------------------------------------------------------------------------------------------
// The table.

/** The table must exist before anything reads it: its absence is this assertion's failure. */
export async function requireMarksTable(db: Kysely<DB>): Promise<void> {
  const { rows } = await sql<{ present: boolean }>`
    SELECT to_regclass(${TABLE}) IS NOT NULL AS present`.execute(db);
  expect(rows[0]?.present, `${TABLE} 应由本任务的迁移建出`).toBe(true);
}

export interface MarkRow {
  readonly id: string;
  readonly app_id: string;
  readonly user_id: string;
  readonly source_user_id: string;
  readonly source_ref: string;
  readonly dimension: string;
  readonly created_at: Date;
}

/** Every mark of the app, by user_id, dimension, id. */
export async function marks(db: Kysely<DB>, appId: string): Promise<MarkRow[]> {
  const { rows } = await sql<MarkRow>`
    SELECT id::text AS id, app_id, user_id::text AS user_id,
      source_user_id::text AS source_user_id, source_ref, dimension, created_at
    FROM app.risk_linked_marks WHERE app_id = ${appId}
    ORDER BY user_id, dimension, id`.execute(db);
  return rows;
}

export interface ExpectedMark {
  readonly user: Pick<Person, 'userId'>;
  readonly dimension: Dimension;
}

/**
 * The app's marks are exactly `expected` (one row per user and dimension), all of the written-off
 * `source` and its candidate `row`, created at `at` (the approval's Clock).
 */
export async function expectMarks(
  db: Kysely<DB>,
  appId: string,
  source: { readonly userId: string; readonly row: Pick<CandidateRow, 'id'> },
  expected: readonly ExpectedMark[],
  at: Date,
): Promise<MarkRow[]> {
  const rows = await marks(db, appId);
  const shape = (item: {
    user_id: string;
    dimension: string;
    source_user_id: string;
    source_ref: string;
  }) => `${item.user_id}|${item.dimension}|${item.source_user_id}|${item.source_ref}`;
  expect(rows.map(shape).sort(), 'risk_linked_marks').toEqual(
    expected
      .map((item) =>
        shape({
          user_id: item.user.userId,
          dimension: item.dimension,
          source_user_id: source.userId,
          source_ref: source.row.id,
        }),
      )
      .sort(),
  );
  for (const row of rows) {
    expect(row.app_id).toBe(appId);
    expect(row.created_at, 'created_at 取注入时钟').toEqual(at);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Members from real logins.

export interface Person {
  readonly appId: string;
  readonly userId: string;
  /** The session of the login that registered the account. */
  readonly first: Session;
  /** The identity number of the real name (plaintext, synthetic). */
  readonly idNo: string;
  /** The current alipay logon id (plaintext, synthetic). */
  readonly payee: string;
  /** A further real login of this account. */
  login(device: Device): Promise<Session>;
}

export interface EnrolOptions {
  /** The identity number of the real name (default: one of its own). */
  readonly idNo?: string;
  /**
   * verified (default), or status none with the tax identity retained (what deletion leaves,
   * BR-ID-28): the identity HMAC stays on a realname row that is not verified.
   */
  readonly realname?: 'verified' | 'retained';
  /** The current alipay logon id (default: one of its own). */
  readonly payee?: string;
}

export function syntheticIdNo(): string {
  return `SYN${randomBytes(8).toString('hex')}`;
}

export function syntheticPayee(): string {
  return `linked-${randomBytes(6).toString('hex')}@example.test`;
}

/**
 * A member registered by a real SMS login on `device`, ready to withdraw: real name, current
 * alipay account, 10000 fen credited earlier, current labor agreement.
 */
export async function enrol(
  kit: Kit,
  appId: string,
  device: Device,
  options: EnrolOptions = {},
): Promise<Person> {
  const number = phone();
  const first = await smsLogin(kit, device, number);
  const userId = first.userId;
  const idNo = options.idNo ?? syntheticIdNo();
  const payee = options.payee ?? syntheticPayee();
  const verified = options.realname !== 'retained';
  await sql`INSERT INTO app.realname (id, app_id, user_id, status, name_cipher, id_no_cipher,
      id_no_hmac, birth_date_cipher, provider, verified_at, tax_retained)
    VALUES (${randomUUID()}, ${appId}, ${userId}, ${verified ? 'verified' : 'none'},
      ${Buffer.from(kit.crypto.encrypt(NAME, 'realname.name'))},
      ${Buffer.from(kit.crypto.encrypt(idNo, ID_NO_CONTEXT))},
      ${kit.crypto.blindIndex(idNo, ID_NO_CONTEXT)},
      ${Buffer.from(kit.crypto.encrypt('1990-01-01', 'realname.birth_date'))}, 'fixture',
      ${kit.clock.now()}, ${!verified})`.execute(kit.db);
  await account(kit, { appId, uid: userId } as Fixture, payee);
  await fund(kit.db, createLedger({ clock: new FixedClock(FUNDED_AT) }), { appId, userId }, 10000n);
  await sql`INSERT INTO app.consent_records
    (app_id, subject_type, user_id, device_id, type, version, accepted, channel, text_sha256,
     signer_snapshot, client_at, server_at)
    VALUES (${appId}, 'user', ${userId}, ${device.deviceId}, 'labor_agreement', 1, true,
      'withdraw_flow', ${'a'.repeat(64)}, '{}'::jsonb, ${kit.clock.now()}, ${kit.clock.now()})`.execute(
    kit.db,
  );
  return {
    appId,
    userId,
    first,
    idNo,
    payee,
    login: (next) => smsLogin(kit, next, number),
  };
}

// ---------------------------------------------------------------------------------------------
// Payout account history (brief §11: every row of payout_accounts, is_current=false ones too).

/** A synthetic 16-digit card number. */
export function syntheticCard(): string {
  const digits = Array.from(randomBytes(12), (byte) => String(byte % 10)).join('');
  return `6222${digits}`;
}

/**
 * The member's real Alipay binding change to `payee` through identity's save (B1-13e, BR-WDR-02):
 * the old current row is kept with is_current=false. `p.payee` keeps the enrolled value.
 */
export async function rebind(kit: Kit, p: Person, payee: string): Promise<void> {
  const payout = await service(kit);
  const result = await kit.db.transaction().execute((trx) =>
    payout.save(trx, {
      appId: p.appId,
      userId: p.userId,
      alipayLogonId: payee,
      payeeName: NAME,
    }),
  );
  expect(result, '换绑支付宝（BR-WDR-02 允许）').toMatchObject({ code: 0 });
}

/**
 * A bank card the member bound before and has since changed away from: a payout_accounts row with
 * is_current=false, as a change leaves it (the bank-card save needs the vendor's verification).
 */
export async function pastCard(kit: Kit, p: Person, cardNo: string): Promise<void> {
  await account(kit, { appId: p.appId, uid: p.userId } as Fixture, cardNo, {
    method: 'bank_card',
    current: false,
  });
}

export interface Holder {
  readonly user_id: string;
  readonly is_current: boolean;
}

/** Holder order of holdersOf, for the expected side too. */
export function byHolder(list: readonly Holder[]): Holder[] {
  const key = (h: Holder) => `${h.user_id}|${String(h.is_current)}`;
  return [...list].sort((x, y) => key(x).localeCompare(key(y)));
}

/** Every payout_accounts row of the app holding the value (fixture check), in byHolder order. */
export async function holdersOf(
  kit: Kit,
  appId: string,
  value: { readonly alipay: string } | { readonly card: string },
): Promise<Holder[]> {
  const column = 'alipay' in value ? sql.ref('alipay_hmac') : sql.ref('bank_card_hmac');
  const digest =
    'alipay' in value
      ? kit.crypto.blindIndex(value.alipay, ALIPAY_CONTEXT)
      : kit.crypto.blindIndex(value.card, BANK_CONTEXT);
  const { rows } = await sql<Holder>`
    SELECT user_id::text AS user_id, is_current FROM app.payout_accounts
    WHERE app_id = ${appId} AND ${column} = ${digest}`.execute(kit.db);
  return byHolder(rows);
}

// ---------------------------------------------------------------------------------------------
// The write-off.

/** One-shot: armed, the next INSERT into app.risk_linked_marks fails and disarms. */
export interface MarksFault {
  armed: boolean;
  tripped: number;
}

function marksFaultPlugin(fault: MarksFault): KyselyPlugin {
  const compiler = new PostgresQueryCompiler();
  return {
    transformQuery({ node, queryId }) {
      if (!fault.armed) return node;
      const text = compiler.compileQuery(node, queryId).sql;
      if (/insert\s+into\s+(?:"?app"?\s*\.\s*)?"?risk_linked_marks\b/i.test(text)) {
        fault.armed = false;
        fault.tripped += 1;
        throw new Error('synthetic failure at risk_linked_marks');
      }
      return node;
    },
    transformResult({ result }) {
      return Promise.resolve(result);
    },
  };
}

/**
 * The approval's fixture on the api kit's database and the test Redis: the admin entry of
 * withWriteoffAdmin runs on `db` (through `fault` when given) with its Clock at NOW.
 */
export function writeoffFixture(
  kit: Kit,
  redisUrl: string,
  appId: string,
  fault?: MarksFault,
): AdjustFixture {
  const clock = new FixedClock(NOW);
  const db = fault === undefined ? kit.db : kit.db.withPlugin(marksFaultPlugin(fault));
  const s: Suite = {
    db: () => db,
    holder: () => {
      throw new Error('kit: no holder pool');
    },
    redisUrl: () => redisUrl,
  };
  return { s, db, clock, appId, ledger: createLedger({ clock }) };
}

export interface Owing {
  readonly m: LedgerMember;
  readonly row: CandidateRow;
}

/**
 * The member's available taken to `available` (default −800) on SINCE — after `frozen` (default 0)
 * was frozen by an APPROVED withdrawal — and a PENDING candidate of it, as the daily job leaves it.
 */
export async function owing(
  f: AdjustFixture,
  p: Person,
  options: { readonly available?: bigint; readonly frozen?: bigint } = {},
): Promise<Owing> {
  const available = options.available ?? -800n;
  const frozen = options.frozen ?? 0n;
  if (available >= 0n) throw new Error('kit: owing needs available below 0');
  const saved = f.clock.now();
  f.clock.set(noon(SINCE));
  let withdrawalId: string | null = null;
  try {
    if (frozen > 0n) {
      withdrawalId = await seedWithdrawal(f, p.userId, {
        status: 'APPROVED',
        amount: frozen,
        appId: p.appId,
      });
    }
  } finally {
    f.clock.set(saved);
  }
  const [balance] = await f.ledger.getBalances(f.db, { appId: p.appId, userIds: [p.userId] });
  if (balance === undefined) throw new Error(`kit: ${p.userId} has no ledger account`);
  const m: LedgerMember = {
    appId: p.appId,
    userId: p.userId,
    accountId: balance.account_id,
    withdrawalId,
  };
  await credit(f, m, available - balance.available_fen, SINCE);
  expect(await moneyOf(f, m), 'fixture balance').toEqual({
    available,
    frozen,
    negativeSince: SINCE,
  });
  return { m, row: await seedCandidate(f, m) };
}

// ---------------------------------------------------------------------------------------------
// What a mark must leave alone.

export async function userRowOf(db: Kysely<DB>, p: Person) {
  const { rows } = await sql<Record<string, unknown>>`
    SELECT * FROM app.users WHERE app_id = ${p.appId} AND id = ${p.userId}`.execute(db);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** The member's inbox messages and notify logs (counts): marks send nothing. */
export async function noticesOf(db: Kysely<DB>, p: Person) {
  const inbox = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.inbox_messages
    WHERE app_id = ${p.appId} AND user_id = ${p.userId}`.execute(db);
  const notify = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.notify_logs
    WHERE app_id = ${p.appId} AND user_id = ${p.userId}`.execute(db);
  return { inbox: inbox.rows[0]?.n, notify: notify.rows[0]?.n };
}
