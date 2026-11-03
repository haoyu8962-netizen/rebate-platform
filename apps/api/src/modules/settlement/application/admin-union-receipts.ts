// B2-04zr: the union collection records of the fund ledger page (contracts/openapi.yaml
// adminCreateUnionReceipt, adminReverseUnionReceipt, adminListUnionReceipts, CT-24zh; 08 BR-FUND-20
// 细则「联盟回款凭证」, BR-FUND-16; 04 §3.2 union_receipts; 编排裁定 D10-538, D10-589). The controller
// (http/admin/) only authorises through the AdminOperationGuard and takes the parameters.
//
// Both writes run under platform idempotency in its transactional mode (subject a:<admin_users.id>,
// the concrete path, the Idempotency-Key header); 2xxxx refusals are not stored. Any failure rolls
// back the record, the voucher, its entries and the audit record together (5xx) and leaves no
// idempotency record.
//
// Entry: the amount is what actually arrived and is not compared with the receivable; a difference
// shows up in R1, this operation opens none. No user balance moves and W does not change. The
// voucher's accounting day comes from the injected Clock, not from receipt_date, so entering an
// older collection lowers the exposure from the day it is entered and rewrites no earlier snapshot
// (D10-589 ②).
//
// Reversal: whole record, once. ledger.reverse answers a replay with the stored voucher instead of
// an error, so it cannot tell that a record was already reversed: the record's row is locked first
// and reversed_at judged under that lock, which is what makes the second reversal 20902 also when
// two requests race. Only the reversal's own voucher is posted; the original record and voucher
// stay.
//
// R1_RECON records are written by the reconciliation task that comes later (D10-538 ③); this file
// only reverses them.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { accountingDate, buildVouchers, type BuiltVoucher } from '@couli/domain';
import { fenToJsonNumber } from '@couli/money';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Ledger, PostingEntry, PostingVoucher } from '../../ledger/index.ts';
import {
  fieldsErrorEnvelope,
  newUuidV7,
  type AuditPort,
  type Clock,
  type EventBus,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
} from '../../platform/index.ts';

/** The audit actions of the contract. */
export const UNION_RECEIPT_CREATE_AUDIT_ACTION = 'union_receipt_create';
export const UNION_RECEIPT_REVERSE_AUDIT_ACTION = 'union_receipt_reverse';

/** D10-538 ⑥: CASH_BANK is refused until the withdrawal bank card channel is open. */
const BANK_SWITCH = 'payout.channel_enabled.bank_card';
const COLLECTIONS_PATH = '/admin/v1/union-receipts';
/** Contract AdminUnionReceiptReverseRequest.reason, after trimming. */
const REASON_MAX = 200;
/** BR-TEXT-14 fallback text of 20902 (contracts/texts.default.json error.20902). */
const CONFLICT_MESSAGE = '状态已变化，请刷新后重试';
/** db/invariants/ledger/05 leaves this kind out of the order receivables. */
const VOUCHER_KIND = 'UNION_RECEIPT';
const BIZ_TYPE = 'UNION_RECEIPT';
/** Contract AdminPage / AdminPageSize defaults. */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
/** union_receipts.receipt_id is a uuid column; any other text names no row. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminUnionReceiptConfigReader {
  get(appId: string, key: string): Promise<unknown>;
}

export interface AdminUnionReceiptNameReader {
  /** admin_id → display name; unknown ids are left out and shown as null. */
  displayNames(appId: string, adminIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

/** What app.module hands in: the other modules' ports (settlement imports none of them). */
export interface AdminUnionReceiptPorts {
  /** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
  readonly auditWriter: (db: Kysely<DB>, clock: Clock) => AuditPort;
  /** content's configuration, read fresh on the given handle. */
  readonly config: (db: Kysely<DB>, clock: Clock) => AdminUnionReceiptConfigReader;
  /** admin's createAdminDisplayNameReader. */
  readonly adminNames: (db: Kysely<DB>) => AdminUnionReceiptNameReader;
  /** ledger's createLedger with payout's recovery hook. */
  readonly ledger: (context: { readonly clock: Clock; readonly eventBus: EventBus }) => Ledger;
}

export interface AdminUnionReceiptDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly idempotency: Idempotency;
  readonly eventBus: EventBus;
  readonly ports: AdminUnionReceiptPorts;
}

/** The guard's verified admin account and the request's address (for the audit row). */
export interface UnionReceiptOperator {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface UnionReceiptWrite<Body> {
  readonly body: Body;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

/** The query of adminListUnionReceipts after the route schema (page / page_size as integers). */
export interface UnionReceiptListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly platform?: Schema<'PlatformCode'>;
  readonly date_from?: string;
  readonly date_to?: string;
}

/** A refusal of the list (20001 data.fields), thrown for the controller. */
export class AdminUnionReceiptFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super('settlement: admin union receipt read refused');
    this.name = 'AdminUnionReceiptFieldsError';
    this.fields = fields;
  }
}

function fieldsRefusal(fields: readonly string[], traceId: string): HandlerResult {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return { status: refused.statusCode, envelope: refused.body };
}

function conflictRefusal(traceId: string): HandlerResult {
  return {
    status: 409,
    envelope: {
      code: 20902,
      msg: CONFLICT_MESSAGE,
      data: { resource: 'union_receipt' },
      trace_id: traceId,
    },
  };
}

function characters(value: string): number {
  return [...value].length;
}

/** All the columns, with receipt_date as its YYYY-MM-DD text. */
function selectReceipts(db: Kysely<DB>) {
  return db
    .withSchema('app')
    .selectFrom('union_receipts')
    .select([
      'receipt_id',
      'platform',
      sql<string>`receipt_date::text`.as('receipt_date'),
      'amount_fen',
      'method',
      'cash_account',
      'voucher_id',
      'note',
      'created_by',
      'created_at',
      'reversed_at',
      'reversed_by',
      'reversal_voucher_id',
    ]);
}

type ReceiptRow = Awaited<ReturnType<ReturnType<typeof selectReceipts>['executeTakeFirstOrThrow']>>;

function viewOf(row: ReceiptRow, names: ReadonlyMap<string, string>): Schema<'AdminUnionReceipt'> {
  const nameOf = (id: string | null) => (id === null ? null : (names.get(id) ?? null));
  return {
    receipt_id: row.receipt_id,
    platform: row.platform as Schema<'AdminUnionReceipt'>['platform'],
    receipt_date: row.receipt_date,
    amount_fen: fenToJsonNumber(row.amount_fen),
    method: row.method as Schema<'AdminUnionReceipt'>['method'],
    cash_account: row.cash_account as Schema<'AdminUnionReceipt'>['cash_account'],
    voucher_id: row.voucher_id,
    note: row.note,
    created_by: row.created_by,
    created_by_name: nameOf(row.created_by),
    created_at: row.created_at.toISOString(),
    reversed_at: row.reversed_at?.toISOString() ?? null,
    reversed_by: row.reversed_by,
    reversed_by_name: nameOf(row.reversed_by),
    reversal_voucher_id: row.reversal_voucher_id,
  };
}

function operatorIds(rows: readonly ReceiptRow[]): string[] {
  return rows.flatMap((row) =>
    [row.created_by, row.reversed_by].filter((id): id is string => id !== null),
  );
}

/** The record as the answer shows it, read back on the writing transaction. */
async function resultOf(
  deps: AdminUnionReceiptDeps,
  trx: Transaction<DB>,
  appId: string,
  receiptId: string,
  traceId: string,
): Promise<HandlerResult> {
  const row = await selectReceipts(trx)
    .where('app_id', '=', appId)
    .where('receipt_id', '=', receiptId)
    .executeTakeFirstOrThrow();
  const names = await deps.ports.adminNames(trx).displayNames(appId, operatorIds([row]));
  const data: Schema<'AdminUnionReceiptResult'> = { receipt: viewOf(row, names) };
  return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
}

function postingOf(
  appId: string,
  adminId: string,
  receiptId: string,
  built: BuiltVoucher,
): PostingVoucher {
  const entries: PostingEntry[] = built.entries.map((entry) => {
    if (entry.account.owner_type === 'user') {
      throw new Error('settlement: a union receipt voucher moved a user balance');
    }
    return {
      account: { ownerType: 'platform', subject: entry.account.subject },
      sub_account: entry.sub_account ?? 'available',
      amount_fen: entry.amount_fen,
      ledger_type: entry.ledger_type,
      sub_type: entry.sub_type,
      income_type: null,
    };
  });
  return {
    appId,
    uniqKey: built.uniq_key,
    bizType: BIZ_TYPE,
    bizId: receiptId,
    operator: `admin:${adminId}`,
    memo: null,
    orderKey: null,
    beneficiaryUserId: null,
    role: null,
    voucherKind: VOUCHER_KIND,
    entries,
  };
}

/** One collection of the operator's app: the record, its voucher and the audit record. */
export function createAdminUnionReceipt(
  deps: AdminUnionReceiptDeps,
  operator: UnionReceiptOperator,
  request: UnionReceiptWrite<Schema<'AdminUnionReceiptCreateRequest'>>,
): Promise<IdempotentResponse> {
  const { appId, adminId } = operator;
  const { body, traceId } = request;
  return deps.idempotency.executeInTransaction(
    {
      appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: adminId },
      method: 'POST',
      path: COLLECTIONS_PATH,
      key: request.key,
      body,
      traceId,
    },
    async (trx): Promise<HandlerResult> => {
      // A JSON number above 2^53 − 1 has already lost its exact value: never book it.
      if (!Number.isSafeInteger(body.amount_fen)) return fieldsRefusal(['amount_fen'], traceId);
      const note = body.note?.trim();
      if (note !== undefined && note === '') return fieldsRefusal(['note'], traceId);
      const now = deps.clock.now();
      // YYYY-MM-DD (the route schema's format) orders as text.
      if (body.receipt_date > accountingDate(now)) {
        return fieldsRefusal(['receipt_date'], traceId);
      }
      if (
        body.cash_account === 'CASH_BANK' &&
        (await deps.ports.config(trx, deps.clock).get(appId, BANK_SWITCH)) !== true
      ) {
        return fieldsRefusal(['cash_account'], traceId);
      }

      const receiptId = newUuidV7(now);
      const amount = BigInt(body.amount_fen);
      const vouchers = buildVouchers(`UNION_RECEIPT:${body.cash_account}`, {
        platform: body.platform,
        receipt_id: receiptId,
        receipt_fen: amount,
      });
      const [built] = vouchers;
      if (built === undefined || vouchers.length !== 1) {
        throw new Error('settlement: a union receipt must build exactly one voucher');
      }
      const posted = await ledgerOf(deps).post(trx, postingOf(appId, adminId, receiptId, built));
      await trx
        .withSchema('app')
        .insertInto('union_receipts')
        .values({
          receipt_id: receiptId,
          app_id: appId,
          platform: body.platform,
          receipt_date: body.receipt_date,
          amount_fen: amount,
          method: 'ADMIN_ENTRY',
          cash_account: body.cash_account,
          voucher_id: posted.voucherId,
          note: note ?? null,
          created_by: adminId,
          created_at: now,
        })
        .execute();
      await deps.ports.auditWriter(trx, deps.clock).append({
        appId,
        actor: adminId,
        action: UNION_RECEIPT_CREATE_AUDIT_ACTION,
        target: receiptId,
        before: null,
        after: {
          receipt_id: receiptId,
          platform: body.platform,
          receipt_date: body.receipt_date,
          amount_fen: amount.toString(),
          cash_account: body.cash_account,
          voucher_id: posted.voucherId,
        },
        ip: operator.ip,
      });
      return resultOf(deps, trx, appId, receiptId, traceId);
    },
  );
}

function ledgerOf(deps: AdminUnionReceiptDeps): Ledger {
  return deps.ports.ledger({ clock: deps.clock, eventBus: deps.eventBus });
}

/** The whole record reversed, once (BR-FUND-16, BR-FUND-20 细则; D10-538 ⑱). */
export function reverseAdminUnionReceipt(
  deps: AdminUnionReceiptDeps,
  operator: UnionReceiptOperator,
  receiptId: string,
  request: UnionReceiptWrite<Schema<'AdminUnionReceiptReverseRequest'>>,
): Promise<IdempotentResponse> {
  const { appId, adminId } = operator;
  const { body, traceId } = request;
  return deps.idempotency.executeInTransaction(
    {
      appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: adminId },
      method: 'POST',
      path: `${COLLECTIONS_PATH}/${receiptId}/reverse`,
      key: request.key,
      body,
      traceId,
    },
    async (trx): Promise<HandlerResult> => {
      const reason = body.reason.trim();
      const length = characters(reason);
      if (length < 1 || length > REASON_MAX) return fieldsRefusal(['reason'], traceId);
      if (!UUID.test(receiptId)) return fieldsRefusal(['receipt_id'], traceId);
      const id = receiptId.toLowerCase();

      const row = await trx
        .withSchema('app')
        .selectFrom('union_receipts')
        .select(['platform', 'amount_fen', 'voucher_id', 'reversed_at'])
        .where('app_id', '=', appId)
        .where('receipt_id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return fieldsRefusal(['receipt_id'], traceId);
      if (row.reversed_at !== null) return conflictRefusal(traceId);

      const reversal = await ledgerOf(deps).reverse(trx, {
        appId,
        originalUniqKey: `RECEIPT:${row.platform}:${id}`,
      });
      // The row lock is held and reversed_at was null: a stored reversal here is a broken record.
      if (reversal.kind !== 'posted') {
        throw new Error('settlement: a union receipt had a reversal voucher but no reversed_at');
      }
      const now = deps.clock.now();
      const updated = await trx
        .withSchema('app')
        .updateTable('union_receipts')
        .set({ reversed_at: now, reversed_by: adminId, reversal_voucher_id: reversal.voucherId })
        .where('app_id', '=', appId)
        .where('receipt_id', '=', id)
        .where('reversed_at', 'is', null)
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) {
        throw new Error('settlement: the locked union receipt was not reversed');
      }
      await deps.ports.auditWriter(trx, deps.clock).append({
        appId,
        actor: adminId,
        action: UNION_RECEIPT_REVERSE_AUDIT_ACTION,
        target: id,
        before: { reversed_at: null },
        after: {
          receipt_id: id,
          platform: row.platform,
          amount_fen: row.amount_fen.toString(),
          voucher_id: row.voucher_id,
          reversal_voucher_id: reversal.voucherId,
          reason,
        },
        ip: operator.ip,
      });
      return resultOf(deps, trx, appId, id, traceId);
    },
  );
}

/** One page of the app's records, reversed ones included; reading writes no audit record. */
export async function listAdminUnionReceipts(
  deps: Pick<AdminUnionReceiptDeps, 'db' | 'ports'>,
  appId: string,
  query: UnionReceiptListQuery,
): Promise<Schema<'AdminUnionReceiptPage'>> {
  const { platform, date_from: from, date_to: to } = query;
  // YYYY-MM-DD (the route schema's format) orders as text.
  if (from !== undefined && to !== undefined && from > to) {
    throw new AdminUnionReceiptFieldsError(['date_from', 'date_to']);
  }
  const page = query.page ?? DEFAULT_PAGE;
  const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
  let rows = selectReceipts(deps.db).where('app_id', '=', appId);
  let count = deps.db
    .withSchema('app')
    .selectFrom('union_receipts')
    .select(sql<string>`count(*)`.as('total'))
    .where('app_id', '=', appId);
  if (platform !== undefined) {
    rows = rows.where('platform', '=', platform);
    count = count.where('platform', '=', platform);
  }
  if (from !== undefined) {
    rows = rows.where('receipt_date', '>=', sql<Date>`${from}::date`);
    count = count.where('receipt_date', '>=', sql<Date>`${from}::date`);
  }
  if (to !== undefined) {
    rows = rows.where('receipt_date', '<=', sql<Date>`${to}::date`);
    count = count.where('receipt_date', '<=', sql<Date>`${to}::date`);
  }
  const items = await rows
    .orderBy('receipt_date', 'desc')
    .orderBy('created_at', 'desc')
    .orderBy('receipt_id', 'desc')
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();
  const { total } = await count.executeTakeFirstOrThrow();
  const names = await deps.ports.adminNames(deps.db).displayNames(appId, operatorIds(items));
  return {
    items: items.map((row) => viewOf(row, names)),
    page,
    page_size: pageSize,
    total: Number(total),
  };
}
