// Order-side blocklist ports (task B1-09a; 08 BR-ATTR-26, orchestrator plan orders-plan-b109-v2
// §2, rulings J-16 / J-17 / D10-152 / D10-169 K-5). orders calls them inside its own transaction;
// every statement runs on the caller's handle, so nothing commits on its own.
//
// match: read only. ① order_no_suffix (taobao only): the last 6 characters (code points, as PG's
//   char_length counts them) of trade_parent_id, compared character for character with active
//   entries — no number conversion, case folding or normalisation. ② channel: relation_id equal to
//   an active entry of the same union_account_id with start_at <= attr_at and (end_at NULL or
//   attr_at < end_at), absolute instants; any platform. The executing clock and expire_at play no
//   part. Both dimensions are returned; the order decision is the caller's.
//   B1-03zk (BR-ATTR-26「申诉撤销后的再命中」, D10-1093): given order_id, a value that already has
//   a risk_hits row on this order, of any action, no later than the close of a revoked appeal of
//   this order no longer matches this order. Later values, other orders and the list stay as they
//   are; read only, on the caller's handle.
// recordHit: registers the BLACKLIST_HIT rule row (ON CONFLICT (app_id, rule_id) DO NOTHING, an
//   existing configured row stays untouched), then appends one risk_hits row (ref_type order,
//   ref_id = order id, value_hmac = HMAC of the blocklist value under blocklist.<dimension>); a
//   retry of the same (order, value, risk_action) ends on risk_hits_blacklist_once_key and adds
//   nothing. Escalating an order from manual_review to void_commission (D10-293) appends a second
//   row; the first row is never rewritten (risk_hits is append only, no UPDATE grant).
// Rule status (B1-03zh, BR-ID-36 细则「规则清单的启停」, D10-536; ./risk-rule-status.ts, read through
//   the caller's transaction and cached for the configuration items' period on the injected
//   Clock): while BLACKLIST_HIT of the app is disabled, match returns no entry (the order is
//   neither sent to manual_review nor voided because of it) and recordHit writes nothing; hits
//   already written stay. One read per judgement (money r1 S1/S2): a caller that acts on entries
//   match returned passes decided_in_force: true to recordHit, which then does not read the status
//   again (a cache expiry between match and recordHit never leaves a void without its hit).
// importChannels: per row, under a transaction-scoped advisory lock on (app_id, union_account_id,
//   relation_id) taken in sorted order (no deadlock between batches), an existing effective entry
//   (active, end_at NULL or later than imported_at; no start_at condition, K-5) is returned as
//   duplicate, otherwise a channel entry is inserted with start_at = imported_at,
//   violation_type other and created_by from the caller. Insert only; audit is written by orders.
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import { newUuidV7, type Clock, type FieldCrypto } from '../../platform/index.ts';
import { createRiskRuleStatusReader, type RiskRuleStatusReader } from './risk-rule-status.ts';

export type OrderBlocklistDimension = 'order_no_suffix' | 'channel';

export interface OrderBlocklistQuery {
  readonly app_id: string;
  readonly platform: string;
  readonly trade_parent_id: string | null;
  readonly relation_id: string | null;
  readonly union_account_id: string | null;
  readonly attr_at: Date;
  /** B1-03zk: the order being judged, when it already exists (none on a first import). */
  readonly order_id?: string;
}

export interface OrderBlocklistMatch {
  readonly blocklist_id: string;
  readonly dimension: OrderBlocklistDimension;
  readonly value: string;
}

export interface OrderBlocklistHitInput {
  readonly app_id: string;
  readonly user_id: string | null;
  readonly order_id: string;
  readonly dimension: OrderBlocklistDimension;
  readonly value: string;
  /** 调用方依据订单状态和尾号开关决定；本端口不变更订单。 */
  readonly risk_action: 'manual_review' | 'void_commission';
  /**
   * B1-03zh (BR-ID-36, one read per judgement): the hit comes from match of this judgement, which
   * already found BLACKLIST_HIT in force, so the status is not read again. Absent → read here.
   */
  readonly decided_in_force?: true;
}

export interface ChannelBlocklistImport {
  readonly app_id: string;
  readonly platform: string;
  readonly union_account_id: string;
  readonly created_by: string;
  /** rights_imports.created_at；即使稍后重试，也沿用该时刻。 */
  readonly imported_at: Date;
  readonly rows: readonly {
    readonly relation_id: string;
    readonly end_at: Date | null;
  }[];
}

export interface ChannelBlocklistImportResult {
  readonly status: 'inserted' | 'duplicate';
  readonly blocklist_id: string;
}

export interface OrderBlocklistPorts {
  /** 只读；返回两种维度全部命中，订单决策由调用方负责。 */
  match(trx: Transaction<DB>, input: OrderBlocklistQuery): Promise<readonly OrderBlocklistMatch[]>;
  /** BLACKLIST_HIT 惰性登记；同订单同值同处置的重试由 PG 部分唯一索引兜底，改判只追加。 */
  recordHit(trx: Transaction<DB>, input: OrderBlocklistHitInput): Promise<void>;
  /** 按输入行序返回结果；只新增，既有条目不修改；整份文件审计由 orders 写。 */
  importChannels(
    trx: Transaction<DB>,
    input: ChannelBlocklistImport,
  ): Promise<readonly ChannelBlocklistImportResult[]>;
}

export interface OrderBlocklistOptions {
  readonly clock: Clock;
  /** HMAC 上下文为 blocklist.order_no_suffix / blocklist.channel，沿用名单命名惯例。 */
  readonly crypto: Pick<FieldCrypto, 'blindIndex'>;
  /** Rule status reader (B1-03zh); defaults to one of its own on `clock`, read through trx. */
  readonly rules?: RiskRuleStatusReader;
}

const RULE_ID = 'BLACKLIST_HIT';
const RULE_SCENE = 'order';
/** Nominal action of the lazily registered rule row; each hit stores the caller's action. */
const RULE_ACTION = 'void_commission';
const REF_TYPE = 'order';
const SUFFIX_LENGTH = 6;
const HIT_ACTIONS: ReadonlySet<string> = new Set(['manual_review', 'void_commission']);
const DIMENSIONS: ReadonlySet<string> = new Set(['order_no_suffix', 'channel']);

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`order blocklist: ${field} must be a non-empty string`);
  }
  return value;
}

function requireInstant(value: unknown, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`order blocklist: ${field} must be a valid Date`);
  }
  return value;
}

/** The last SUFFIX_LENGTH code points, or null when the parent id is shorter. */
function parentSuffix(tradeParentId: string | null): string | null {
  if (typeof tradeParentId !== 'string') return null;
  const chars = Array.from(tradeParentId);
  if (chars.length < SUFFIX_LENGTH) return null;
  return chars.slice(-SUFFIX_LENGTH).join('');
}

function lockKey(appId: string, unionAccountId: string, relationId: string): string {
  // JSON escaping keeps the tuple boundaries unambiguous.
  return JSON.stringify(['risk.blocklist.channel', appId, unionAccountId, relationId]);
}

function hmacOf(crypto: Pick<FieldCrypto, 'blindIndex'>, dimension: string, value: string): string {
  return crypto.blindIndex(value, `blocklist.${dimension}`);
}

function hitKey(dimension: string, valueHmac: string): string {
  return `${dimension}\0${valueHmac}`;
}

/**
 * B1-03zk: the (dimension, value) pairs that no longer match this order — every blacklist hit it
 * has, of any action, no later than the latest close of its revoked order appeals.
 */
async function exemptValues(
  trx: Transaction<DB>,
  input: { readonly appId: string; readonly orderId: string },
): Promise<ReadonlySet<string>> {
  const app = trx.withSchema('app');
  const revoked = await app
    .selectFrom('appeals')
    .select((eb) => eb.fn.max('closed_at').as('closed_at'))
    .where('app_id', '=', input.appId)
    .where('target_type', '=', 'order')
    .where('target_id', '=', input.orderId)
    .where('status', '=', 'revoked')
    .executeTakeFirst();
  const closedAt = revoked?.closed_at ?? null;
  if (closedAt === null) return new Set();
  const hits = await app
    .selectFrom('risk_hits')
    .select(['dimension', 'value_hmac'])
    .where('app_id', '=', input.appId)
    .where('rule_id', '=', RULE_ID)
    .where('ref_type', '=', REF_TYPE)
    .where('ref_id', '=', input.orderId)
    .where('created_at', '<=', closedAt)
    .execute();
  return new Set(hits.map((hit) => hitKey(hit.dimension, hit.value_hmac)));
}

export function createOrderBlocklistPorts(options: OrderBlocklistOptions): OrderBlocklistPorts {
  const { clock, crypto } = options;
  const rules = options.rules ?? createRiskRuleStatusReader({ clock });
  return {
    async match(trx, input) {
      const appId = requireText(input.app_id, 'app_id');
      const attrAt = requireInstant(input.attr_at, 'attr_at');
      // A disabled BLACKLIST_HIT decides nothing (BR-ID-36).
      if (!(await rules.isEnabled({ app_id: appId, rule_id: RULE_ID }, trx))) return [];
      const app = trx.withSchema('app');
      const result: OrderBlocklistMatch[] = [];
      const relationId = input.relation_id;
      const accountId = input.union_account_id;
      if (
        typeof relationId === 'string' &&
        relationId.length > 0 &&
        typeof accountId === 'string' &&
        accountId.length > 0
      ) {
        const rows = await app
          .selectFrom('blocklist')
          .select(['id', 'value'])
          .where('app_id', '=', appId)
          .where('dimension', '=', 'channel')
          .where('status', '=', 'active')
          .where('union_account_id', '=', accountId)
          .where('value', '=', relationId)
          .where('start_at', '<=', attrAt)
          .where((eb) => eb.or([eb('end_at', 'is', null), eb('end_at', '>', attrAt)]))
          .orderBy('id')
          .execute();
        for (const row of rows) {
          result.push({ blocklist_id: row.id, dimension: 'channel', value: row.value ?? '' });
        }
      }
      const suffix = input.platform === 'taobao' ? parentSuffix(input.trade_parent_id) : null;
      if (suffix !== null) {
        const rows = await app
          .selectFrom('blocklist')
          .select(['id', 'value'])
          .where('app_id', '=', appId)
          .where('dimension', '=', 'order_no_suffix')
          .where('platform', '=', 'taobao')
          .where('status', '=', 'active')
          .where('value', '=', suffix)
          .orderBy('id')
          .execute();
        for (const row of rows) {
          result.push({
            blocklist_id: row.id,
            dimension: 'order_no_suffix',
            value: row.value ?? '',
          });
        }
      }
      if (input.order_id === undefined || result.length === 0) return result;
      const exempt = await exemptValues(trx, {
        appId,
        orderId: requireText(input.order_id, 'order_id'),
      });
      return result.filter(
        (match) =>
          !exempt.has(hitKey(match.dimension, hmacOf(crypto, match.dimension, match.value))),
      );
    },

    async recordHit(trx, input) {
      const appId = requireText(input.app_id, 'app_id');
      const orderId = requireText(input.order_id, 'order_id');
      const value = requireText(input.value, 'value');
      if (!DIMENSIONS.has(input.dimension)) {
        throw new TypeError('order blocklist: unknown dimension');
      }
      if (!HIT_ACTIONS.has(input.risk_action)) {
        throw new TypeError(
          'order blocklist: risk_action must be manual_review or void_commission',
        );
      }
      if (input.user_id !== null && typeof input.user_id !== 'string') {
        throw new TypeError('order blocklist: user_id must be a string or null');
      }
      // A disabled BLACKLIST_HIT writes no hit row (BR-ID-36); a caller's decision is not re-read.
      if (
        input.decided_in_force !== true &&
        !(await rules.isEnabled({ app_id: appId, rule_id: RULE_ID }, trx))
      )
        return;
      const now = clock.now();
      const app = trx.withSchema('app');
      await app
        .insertInto('risk_rules')
        .values({
          id: newUuidV7(now),
          app_id: appId,
          rule_id: RULE_ID,
          scene: RULE_SCENE,
          conditions: sql`'{}'::jsonb`,
          risk_action: RULE_ACTION,
          status: 'active',
          version: 1,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.columns(['app_id', 'rule_id']).doNothing())
        .execute();
      await app
        .insertInto('risk_hits')
        .values({
          app_id: appId,
          user_id: input.user_id,
          rule_id: RULE_ID,
          risk_action: input.risk_action,
          dimension: input.dimension,
          value_hmac: hmacOf(crypto, input.dimension, value),
          ref_type: REF_TYPE,
          ref_id: orderId,
          created_at: now,
        })
        // Arbiter: risk_hits_blacklist_once_key (partial on this literal rule_id; D10-293 key).
        .onConflict((oc) =>
          oc
            .columns(['app_id', 'rule_id', 'ref_type', 'ref_id', 'value_hmac', 'risk_action'])
            .where('rule_id', '=', sql.lit(RULE_ID))
            .doNothing(),
        )
        .execute();
    },

    async importChannels(trx, input) {
      const appId = requireText(input.app_id, 'app_id');
      const platform = requireText(input.platform, 'platform');
      const accountId = requireText(input.union_account_id, 'union_account_id');
      const createdBy = requireText(input.created_by, 'created_by');
      const importedAt = requireInstant(input.imported_at, 'imported_at');
      if (!Array.isArray(input.rows)) {
        throw new TypeError('order blocklist: rows must be an array');
      }
      const rows = input.rows.map((row, index) => {
        const relationId = requireText(row.relation_id, `rows[${index}].relation_id`);
        const endAt =
          row.end_at === null ? null : requireInstant(row.end_at, `rows[${index}].end_at`);
        if (endAt !== null && endAt.getTime() <= importedAt.getTime()) {
          throw new RangeError(`order blocklist: rows[${index}].end_at must be after imported_at`);
        }
        return { relationId, endAt };
      });
      if (rows.length === 0) return [];
      const app = trx.withSchema('app');
      // Lock every distinct key first, in a fixed order, so concurrent batches cannot deadlock and
      // the duplicate check below reads after any competing import of the same key has committed.
      const keys = [
        ...new Set(rows.map((row) => lockKey(appId, accountId, row.relationId))),
      ].sort();
      for (const key of keys) {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
      }
      const now = clock.now();
      const results: ChannelBlocklistImportResult[] = [];
      for (const row of rows) {
        const existing = await app
          .selectFrom('blocklist')
          .select('id')
          .where('app_id', '=', appId)
          .where('dimension', '=', 'channel')
          .where('union_account_id', '=', accountId)
          .where('value', '=', row.relationId)
          .where('status', '=', 'active')
          .where((eb) => eb.or([eb('end_at', 'is', null), eb('end_at', '>', importedAt)]))
          .orderBy('created_at')
          .orderBy('id')
          .limit(1)
          .executeTakeFirst();
        if (existing !== undefined) {
          results.push({ status: 'duplicate', blocklist_id: existing.id });
          continue;
        }
        const id = newUuidV7(now);
        await app
          .insertInto('blocklist')
          .values({
            id,
            app_id: appId,
            dimension: 'channel',
            value: row.relationId,
            value_hmac: null,
            platform,
            union_account_id: accountId,
            start_at: importedAt,
            end_at: row.endAt,
            expire_at: null,
            status: 'active',
            violation_type: 'other',
            created_by: createdBy,
            created_at: now,
            updated_at: now,
          })
          .execute();
        results.push({ status: 'inserted', blocklist_id: id });
      }
      return results;
    },
  };
}
