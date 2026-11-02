// B1-02zq rule-test kit (BR-WDR-01 细则「旧手机号被二次放号时的提现加验」位置与返回码; BR-WDR-03 ③b;
// BR-ID-27; contract 10010, createWithdrawal, getWithdrawRules, savePayoutAccount, submitRealname,
// requestDeletion). Built on the B1-02zp kit (test/spec/identity/reverify/kit.ts): the real AppModule
// over a test database and Redis, the only seams its two vendors (kit.exchange, kit.vendor). No port
// is replaced and no skeleton is imported: every assertion goes through an HTTP entry.
//   withdraw   POST /v1/withdrawals            signed, idempotent, x-step-up withdraw
//   rules      GET  /v1/withdrawals/rules      login, unsigned
//   payout     PUT  /v1/me/payout-account      signed, idempotent, x-step-up payout_account_change
//   realname   POST /v1/me/realname            signed, idempotent
//   deletion   POST /v1/me/deletion            signed, idempotent, x-step-up account_deletion
//   status     GET  /v1/me/reverify            what the Reverify page reads (the same conclusion)
//   by id / oauth  POST /v1/me/reverify/*      a real self-service pass
// The admin side is admin-realname.int.test.ts, on the admin entry of ../admin-realname/kit.ts.
//
// The flag is seeded on users.reverify_* (kit.flag); a pass is a real request. Step-up tokens are
// signed as POST /v1/auth/step-up issues them. Tokens are minted per call, so the Clock may move.
//
// Every rule test carries a step that only the wired gate answers (10010, or 30419 reverify_pending
// on the admin side). A passing path alone is green on today's constant-null stub and would prove
// nothing, so the cases of the "passes" kind hold a flagged control next to them.
//
// Not pinned on purpose: the three spec conflicts and the gaps listed in the task's output
// (a flagged member without a real name on POST /v1/withdrawals; 30419 reverify_pending against
// identity_blacklisted; a flag with the switch at 0; the place of the gate among the other refusals
// of first real name and of payout account change).
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect } from 'vitest';
import type * as AccessTokensApi from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type { TokenKeyProvider } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type * as IdentityTokensApi from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { fund } from '../../payout/apply/kit.ts';
import { block } from '../../payout/risk-rule-toggle/kit.ts';
import { ROOT, sign } from '../../risk/signature/kit.ts';
import { ALIPAY_CONTEXT } from '../payout-account/kit.ts';
import { residentId } from '../realname/kit.ts';
import {
  BY_ID,
  BY_OAUTH,
  FAIL_LIMIT,
  ID,
  attemptOf,
  fixture,
  oauthBody,
  passed,
  type Device,
  type Envelope,
  type Kit,
  type Provider,
  type Scope,
} from '../reverify/kit.ts';
import type { Response } from '../sms-codes/http-kit.ts';

export const WITHDRAW = '/v1/withdrawals';
export const RULES = '/v1/withdrawals/rules';
export const PAYOUT = '/v1/me/payout-account';
export const REALNAME = '/v1/me/realname';
export const DELETION = '/v1/me/deletion';
/** The name of the realname rows of the B1-02zp kit: payee and real name must agree (30307). */
export const PERSON = '欧阳小明';
const VENDOR = 'test-two-elements';
const STEP_UP_TTL_SECONDS = 300;
const TEXT_SHA256 = 'a'.repeat(64);

/** 10010's data (contracts/error-codes.yaml): exactly these keys, per method. */
export const ID_NUMBER = { method: 'id_number', fail_limit: FAIL_LIMIT };
export const MANUAL = { method: 'manual' };
export function oauth(providers: readonly Provider[]) {
  return { method: 'oauth', providers, fail_limit: FAIL_LIMIT };
}
export type PendingData = typeof ID_NUMBER | typeof MANUAL | ReturnType<typeof oauth>;

type Verb = 'get' | 'post' | 'put';
type StepUpAction = 'withdraw' | 'payout_account_change' | 'account_deletion';

/** contracts/error-codes.yaml, for the codes these tests read. */
const HTTP_STATUS: Readonly<Record<number, number>> = {
  0: 200,
  10003: 403,
  10006: 403,
  10010: 403,
  10405: 403,
  30304: 422,
  30412: 422,
  30416: 422,
  44001: 403,
};

/** The app, as this kit also sends PUT. */
interface Wire {
  inject(request: {
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
}

export interface MemberOptions {
  /** A completed real name (default true). */
  realname?: boolean;
  /** A current Alipay account in the real name's name (default true). */
  payout?: boolean;
  /** Funded through the ledger; null: no ledger account (default 10000 fen). */
  balance?: bigint | null;
}

export interface Call {
  /** The Idempotency-Key; a fresh one when absent. */
  key?: string;
  /** The X-Step-Up-Token; null sends none; a fresh valid one when absent. */
  step?: string | null;
  /** The body; a valid one when absent. */
  body?: object;
}

/** The response envelope, checked against the contract of the operation. */
export function answer(
  kit: Kit,
  path: string,
  verb: Verb,
  response: Response,
  code: number,
): Envelope {
  expect(response.statusCode).toBe(HTTP_STATUS[code]);
  const body = response.json<Envelope>();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  const status = code === 0 ? '200' : code >= 50000 ? '5XX' : '4XX';
  const schema =
    kit.document.paths[path]![verb]!.responses[status]!.content['application/json']!.schema;
  const check = kit.compile({ schema, httpPart: 'body' });
  expect(check(body), JSON.stringify(check.errors)).toBe(true);
  return body;
}

/** HTTP 403, code 10010 and exactly this data. */
export function refused(
  kit: Kit,
  path: string,
  verb: Verb,
  response: Response,
  data: PendingData,
): void {
  expect(answer(kit, path, verb, response, 10010).data).toEqual(data);
}

/** The data of the same account on GET /v1/me/reverify says what `data` says. */
export function sameConclusion(status: object | undefined, data: PendingData): void {
  const { method } = data;
  expect(status).toMatchObject({
    required: true,
    method,
    providers: 'providers' in data ? data.providers : [],
    fail_limit: 'fail_limit' in data ? data.fail_limit : null,
  });
}

export async function gates(kit: Kit, options: { days?: number } = {}) {
  const f = await fixture(kit, options);
  kit.vendor.mockReset().mockResolvedValue({ outcome: 'mismatch', provider: VENDOR });
  const { appId } = f;
  const db = kit.suite.db.withSchema('app');
  const wire = kit.app as unknown as Wire;
  const ledger = createLedger({ clock: kit.clock });
  const base = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const access = (await import(
    new URL('apps/api/src/modules/identity/application/access-tokens.ts', ROOT).href
  )) as typeof AccessTokensApi;
  const tokens = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as typeof IdentityTokensApi;
  const keys = kit.app.get<TokenKeyProvider>(tokens.TOKEN_KEYS);

  // Before this app's first request, as the switch of the B1-02zp fixture.
  for (const [key, value] of Object.entries({
    'legal.labor_agreement.version': 1,
    'legal.labor_agreement.text_url': 'https://example.test/labor',
    'legal.labor_agreement.text_sha256': TEXT_SHA256,
    'legal.labor_agreement.resign_from_version': 1,
    'withdraw.daily_count_per_user': 0,
    'withdraw.monthly_count_per_user': 0,
    'withdraw.payee_daily_count': 0,
    'withdraw.payee_daily_distinct_users': 0,
  })) {
    await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
      VALUES (${appId}, ${key}, ${JSON.stringify(value)}::jsonb, 'b1-02zq-fixture')`.execute(db);
  }

  /** A current Alipay account; returns its digest (the blocklist's alipay value). */
  const payoutAccount = async (uid: string) => {
    const logon = `member-${randomBytes(6).toString('hex')}@example.test`;
    const hmac = kit.crypto.blindIndex(logon, ALIPAY_CONTEXT);
    await db
      .insertInto('payout_accounts')
      .values({
        id: randomUUID(),
        app_id: appId,
        user_id: uid,
        payout_method: 'alipay',
        is_current: true,
        payee_name: PERSON,
        alipay_hmac: hmac,
        alipay_logon_id_cipher: Buffer.from(kit.crypto.encrypt(logon, ALIPAY_CONTEXT)),
        created_at: kit.clock.now(),
        updated_at: kit.clock.now(),
      })
      .execute();
    return hmac;
  };

  const consents = async (uid: string, from: Device) => {
    const now = kit.clock.now();
    await sql`INSERT INTO app.consent_records
      (app_id, subject_type, user_id, device_id, type, version, accepted, channel, text_sha256,
       signer_snapshot, client_at, server_at)
      VALUES (${appId}, 'user', ${uid}, ${from.id}, 'labor_agreement', 1, true, 'withdraw_flow',
        ${TEXT_SHA256}, '{}'::jsonb, ${now}, ${now})`.execute(db);
    await sql`INSERT INTO app.consent_records (app_id, subject_type, user_id, device_id, type,
        version, channel, accepted, client_at, server_at, created_at)
      VALUES (${appId}, 'user', ${uid}, NULL, 'id_verification', 1, 'realname_sheet', true, ${now},
        ${now}, ${now})`.execute(db);
  };

  let members = 0;
  /** An ID number of its own: verified numbers are unique within an app. */
  const nextIdNo = () => {
    members += 1;
    return members === 1 ? ID : residentId('1980-01-01', String(100 + members));
  };

  const member = async (options: MemberOptions = {}) => {
    const { uid } = await f.user();
    const device = await f.device();
    const idNo = nextIdNo();
    if (options.realname !== false) await f.realname(uid, idNo);
    const payeeHmac = options.payout === false ? null : await payoutAccount(uid);
    await consents(uid, device);
    const balance = options.balance === undefined ? 10000n : options.balance;
    if (balance !== null) {
      await fund(kit.suite.db, ledger, { appId, userId: uid }, balance);
    }
    return { uid, device, idNo, payeeHmac };
  };
  type Member = Awaited<ReturnType<typeof member>>;

  const openSession = async (uid: string, from: Device) => {
    const now = kit.clock.now();
    const sid = randomBytes(16).toString('base64url');
    await db
      .insertInto('sessions')
      .values({
        id: randomUUID(),
        app_id: appId,
        sid,
        login_method: null,
        user_id: uid,
        device_id: from.id,
        revoked_at: null,
        revoke_reason: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return sid;
  };

  /** The operations under test, as this member on this device. */
  const on = (who: Member, from: Device = who.device, scope: Scope = 'full') => {
    const { uid } = who;
    let opened: Promise<string> | undefined;
    const session = () => {
      opened ??= openSession(uid, from);
      return opened;
    };
    const bearer = async () => {
      const sid = await session();
      const token = await kit.tokens.issueAccess({
        uid,
        app_id: appId,
        sid,
        device_id: from.id,
        scp: scope,
      });
      return `Bearer ${token}`;
    };
    const stepUp = async (action: StepUpAction) =>
      access.signScopedToken(keys, {
        audience: access.STEP_UP_AUDIENCE,
        claims: {
          uid,
          app_id: appId,
          sid: await session(),
          device_id: from.id,
          action,
          jti: randomUUID(),
        },
        issuedAt: Math.floor(kit.clock.now().getTime() / 1000),
        ttlSeconds: STEP_UP_TTL_SECONDS,
      });
    const send = async (
      method: 'POST' | 'PUT',
      path: string,
      body: object,
      action: StepUpAction | null,
      call: Call,
    ) => {
      const raw = JSON.stringify(body);
      const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const token = call.step === undefined && action !== null ? await stepUp(action) : call.step;
      return wire.inject({
        method,
        url: path,
        payload: raw,
        headers: {
          ...base,
          'x-device-id': from.id,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-sign': sign(method, path, Buffer.from(raw), timestamp, nonce, from.secret),
          authorization: await bearer(),
          'idempotency-key': call.key ?? randomUUID(),
          ...(token === null || token === undefined ? {} : { 'x-step-up-token': token }),
        },
      });
    };
    return {
      stepUp,
      rules: async (query = '') =>
        wire.inject({
          method: 'GET',
          url: `${RULES}${query}`,
          headers: { ...base, 'x-device-id': from.id, authorization: await bearer() },
        }),
      withdraw: (call: Call = {}) =>
        send('POST', WITHDRAW, call.body ?? { amount_fen: 1000 }, 'withdraw', call),
      payout: (call: Call = {}) =>
        send(
          'PUT',
          PAYOUT,
          call.body ?? {
            payout_method: 'alipay',
            alipay_logon_id: `new-${randomBytes(6).toString('hex')}@example.test`,
            payee_name: PERSON,
          },
          'payout_account_change',
          call,
        ),
      realname: (call: Call = {}) =>
        send('POST', REALNAME, call.body ?? { name: PERSON, id_no: who.idNo }, null, call),
      deletion: (call: Call = {}) =>
        send('POST', DELETION, call.body ?? {}, 'account_deletion', call),
    };
  };

  /** A real pass by ID number on `from`. */
  const passById = async (who: Member, from: Device = who.device) => {
    passed(kit, BY_ID, await f.client(who.uid, from).byId(who.idNo));
  };

  /** A real pass by re-authorising the bound WeChat identity on `from`. */
  const passByOauth = async (who: Member, unionId: string, from: Device = who.device) => {
    const client = f.client(who.uid, from);
    const attempt = attemptOf(kit, await client.attempt('wechat'));
    kit.exchange.mockReset().mockResolvedValue({ union_id: unionId });
    passed(kit, BY_OAUTH, await client.byOauth(oauthBody('wechat', attempt.attempt_id)));
  };

  const blockPayee = (hmac: string) => block(kit.suite.db, appId, 'alipay', hmac);
  const unblock = async () => {
    await sql`UPDATE app.blocklist SET status = 'inactive' WHERE app_id = ${appId}`.execute(db);
  };

  const freeze = (uid: string) =>
    db.transaction().execute((trx) =>
      kit.risk.setRiskState(trx, {
        app_id: appId,
        user_id: uid,
        state: 'frozen',
        reason: 'fixture reason',
        reason_category: 'other',
        frozen_until: null,
        changed_by: 'fixture_operator',
      }),
    );

  /** One withdrawal outside the terminal set of BR-WDR-08 (a seed, no ledger). */
  const inFlight = async (uid: string) => {
    const id = randomUUID();
    await db
      .insertInto('withdrawals')
      .values({
        id,
        app_id: appId,
        user_id: uid,
        amount_fen: 1000n,
        fee_fen: 0n,
        tax_fen: 0n,
        net_fen: 1000n,
        income_type: 'SERVICE_FEE',
        payout_method: 'alipay',
        payout_channel: 'alipay',
        payee_name: PERSON,
        payee_account_cipher: Buffer.from('synthetic-payee'),
        payee_hmac: randomBytes(32).toString('hex'),
        status: 'PENDING_REVIEW',
        out_biz_no: id.replaceAll('-', ''),
      })
      .execute();
  };

  /** A USER_BALANCE account with this negative available balance. */
  const negative = async (uid: string, availableFen: bigint) => {
    const accountId = randomUUID();
    await sql`INSERT INTO app.ledger_accounts (id, app_id, owner_type, owner_id, subject)
      VALUES (${accountId}, ${appId}, 'user', ${uid}, 'USER_BALANCE')`.execute(db);
    await sql`INSERT INTO app.account_balances
      (app_id, account_id, available_fen, frozen_fen, negative_since, version)
      VALUES (${appId}, ${accountId}, ${availableFen}, 0, '2026-10-01'::date, 1)`.execute(db);
  };

  /** A cooling deletion request written directly (not through the application). */
  const cooling = async (uid: string) => {
    const now = kit.clock.now();
    await db
      .insertInto('deletion_requests')
      .values({
        id: randomUUID(),
        app_id: appId,
        user_id: uid,
        status: 'cooling',
        apply_at: now,
        cooling_until: new Date(now.getTime() + 7 * 86_400_000),
        cancelled_at: null,
        cancel_reason: null,
        processed_at: null,
        balance_snapshot_fen: 0n,
        created_at: now,
        updated_at: now,
      })
      .execute();
  };

  const withdrawals = (uid: string) =>
    db
      .selectFrom('withdrawals')
      .selectAll()
      .where('app_id', '=', appId)
      .where('user_id', '=', uid)
      .orderBy('id')
      .execute();

  /** The member's withdrawals and balances: what a refusal must leave alone. */
  const funds = async (uid: string) => ({
    withdrawals: await withdrawals(uid),
    balances: await ledger.getBalances(kit.suite.db, { appId, userIds: [uid] }),
  });

  /** The payout account tables of the member, verification attempts included. */
  const payoutState = async (uid: string) => ({
    accounts: await db
      .selectFrom('payout_accounts')
      .selectAll()
      .where('app_id', '=', appId)
      .where('user_id', '=', uid)
      .orderBy('id')
      .execute(),
    changes: await db
      .selectFrom('payout_account_changes')
      .selectAll()
      .where('app_id', '=', appId)
      .where('user_id', '=', uid)
      .orderBy('id')
      .execute(),
    attempts: await db
      .selectFrom('payout_account_verify_attempts')
      .selectAll()
      .where('app_id', '=', appId)
      .where('user_id', '=', uid)
      .orderBy('reserved_at')
      .execute(),
  });

  const realnameRows = (uid: string) =>
    db
      .selectFrom('realname')
      .selectAll()
      .where('app_id', '=', appId)
      .where('user_id', '=', uid)
      .execute();

  const deletions = (uid: string) =>
    db
      .selectFrom('deletion_requests')
      .selectAll()
      .where('app_id', '=', appId)
      .where('user_id', '=', uid)
      .orderBy('id')
      .execute();

  return {
    ...f,
    member,
    on,
    passById,
    passByOauth,
    blockPayee,
    unblock,
    freeze,
    inFlight,
    negative,
    cooling,
    withdrawals,
    funds,
    payoutState,
    realnameRows,
    deletions,
  };
}
export type Gates = Awaited<ReturnType<typeof gates>>;
export type Member = Awaited<ReturnType<Gates['member']>>;
export type Client = ReturnType<Gates['on']>;

/** The four operations that answer 10010, each with what its acceptance looks like. */
export interface Surface {
  readonly name: string;
  readonly path: string;
  readonly verb: 'post' | 'put';
  readonly member: MemberOptions;
  /** A first real name: the trusted identities cannot hold a completed one. */
  readonly first: boolean;
  submit(client: Client): Promise<Response>;
  /** What the operation needs from a vendor to be accepted. */
  ready(kit: Kit): void;
  accepted(kit: Kit, response: Response): void;
}

const NO_VENDOR = (): void => undefined;

export const SURFACES: readonly Surface[] = [
  {
    name: '提现',
    path: WITHDRAW,
    verb: 'post',
    member: {},
    first: false,
    submit: (client) => client.withdraw(),
    ready: NO_VENDOR,
    accepted(kit, response) {
      expect(answer(kit, WITHDRAW, 'post', response, 0).data).toMatchObject({
        status: 'PENDING_REVIEW',
        amount_fen: 1000,
      });
    },
  },
  {
    name: '收款账号变更',
    path: PAYOUT,
    verb: 'put',
    member: { payout: false, balance: null },
    first: false,
    submit: (client) => client.payout(),
    ready: NO_VENDOR,
    accepted(kit, response) {
      answer(kit, PAYOUT, 'put', response, 0);
    },
  },
  {
    name: '首次实名',
    path: REALNAME,
    verb: 'post',
    member: { realname: false, payout: false, balance: null },
    first: true,
    submit: (client) => client.realname(),
    ready(kit) {
      kit.vendor.mockReset().mockResolvedValue({ outcome: 'match', provider: VENDOR });
    },
    accepted(kit, response) {
      expect(answer(kit, REALNAME, 'post', response, 0).data).toMatchObject({
        realname_status: 'verified',
      });
    },
  },
  {
    name: '申请注销',
    path: DELETION,
    verb: 'post',
    member: { payout: false, balance: null },
    first: false,
    submit: (client) => client.deletion(),
    ready: NO_VENDOR,
    accepted(kit, response) {
      expect(answer(kit, DELETION, 'post', response, 0).data).toMatchObject({ status: 'cooling' });
    },
  },
];
