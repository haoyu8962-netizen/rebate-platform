// Blocklist hits and 44001 (规划/08 BR-ID-31 黑名单, BR-ID-36 risk_hits 与「被拦截请求申诉」, BR-ID-05
// 发码 / 同设备注册上限, BR-ID-33 脱敏; 04 §3.2 blocklist / risk_rules / risk_hits, §7 44001).
//
// Account-side matching (0014 header): (app_id, dimension, value_hmac) with status='active' and
// expire_at later than the injected Clock; several entries for one value are allowed and any one
// hits. Matching never consults users, so a deleted account's values still hit (BR-ID-31).
// Values arrive in plaintext (hashed here with blindIndex and the per-dimension context of
// blocklistHmacContexts()) or as a precomputed HMAC; the device dimension stores the device hash
// itself (64 lowercase hex, BR-ID-09) and is never hashed again.
//
// Every hit writes risk_hits rows (ref_type blocked_request) in an independent short transaction
// of its own (db.transaction(), never the caller's transaction): whatever the blocked request
// rolls back, the hit record stays (orchestrator ruling B1-03d §9.3). Before the rows, the rule
// codes are registered with INSERT … ON CONFLICT (app_id, rule_id) DO NOTHING (created_at and
// updated_at from the same Clock instant as the hits), so the foreign key risk_hits → risk_rules
// never fails on a first hit.
//
// Inside a caller's transaction nothing here borrows a second pooled connection on the
// production path: matchRegistration only reads through trx and returns the hits, and the caller
// records them with recordHits after its transaction rolled back and released its connection (a
// hit written while the caller still holds a connection would let concurrent blocked first logins
// hold the whole pool and wait for each other). checkRegistration (match, then record at once) is
// for callers that hold no other pooled connection while it records. One blocked request has one UUIDv7 ref_id
// (the 拦截请求编号) shared by all its rows. The related phone is stored only as its users.phone
// blind index and its masked form 138****5678 (BR-ID-33); the answer carries only the message
// code blocklist.<violation_type> (04 §7), never the registration reason.
//
// Rule codes (orchestrator ruling, to be registered in 规划/06): BLACKLIST_<DIMENSION>,
// SMS_BLOCKED_PREFIX and DEVICE_REGISTER_LIMIT; scene is the request type (register, withdraw,
// phone_change, payout_account; blocked_request when the request has no type), risk_action
// block, status active, version 1, conditions {}.
//
// Rule status (B1-03zh, BR-ID-36 细则「规则清单的启停」, D10-536; ./risk-rule-status.ts): a disabled
// BLACKLIST_<DIMENSION> takes no part in judgements — check answers null for it and the
// registration match skips that dimension (read through trx), so it refuses nothing. ruleInForce
// exposes the same reader (one cache) to identity's decision points (SMS_BLOCKED_PREFIX,
// DEVICE_REGISTER_LIMIT), which ask before deciding. Answers are cached for the configuration
// items' period on the injected Clock; hits and appeals already written are never touched.
// One read per judgement (money r1 S1): a writer behind a decision that already read the status
// does not read it again, so a cache expiry between the two can never leave a refusal without its
// hit. recordDecidedHit, or recordHit with decided_in_force: true (identity's prefix and
// device-limit refusals), and
// recordHits of rows matchRegistration of this service returned for that app (an unforgeable
// in-memory token, not a status cache) write without a status read. Any other row — a caller with
// no decision of its own — is checked here: rows of a disabled rule are dropped and, with none
// left, nothing is written.
//
// Nothing logged identifies the person: no phone, value, HMAC or device hash.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for types, `.ts` relative imports, no decorators.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { newUuidV7, type Clock, type FieldCrypto, type RootLogger } from '../../platform/index.ts';
import {
  createRiskRuleStatusReader,
  type RiskRuleKey,
  type RiskRuleStatusReader,
} from './risk-rule-status.ts';

export type BlocklistDimension =
  'phone' | 'id_no' | 'alipay' | 'bank_card' | 'wechat_openid' | 'device' | 'relation_id';

/** The blindIndex context of each non-device dimension. phone equals identity's users.phone. */
const HMAC_CONTEXTS: Readonly<Record<Exclude<BlocklistDimension, 'device'>, string>> =
  Object.freeze({
    phone: 'users.phone',
    id_no: 'blocklist.id_no',
    alipay: 'payout_accounts.alipay',
    bank_card: 'payout_accounts.bank_card',
    wechat_openid: 'payout_accounts.wechat_openid',
    relation_id: 'blocklist.relation_id',
  });

/** Shared by risk, backend registration (F1-10) and payout accounts (B2).
 * A function exposes the shared contexts because test-stage skeletons cannot initialize constants.
 * Device hashes are already digests and have no blindIndex context.
 */
export function blocklistHmacContexts(): Readonly<
  Record<Exclude<BlocklistDimension, 'device'>, string>
> {
  return HMAC_CONTEXTS;
}

export interface BlockedRequest {
  readonly app_id: string;
  readonly request_type: 'register' | 'withdraw' | 'phone_change' | 'payout_account' | null;
  readonly related_phone: string;
  readonly user_id?: string;
  readonly amount_fen?: bigint;
  /** Reuse the first hit's UUIDv7 for other dimensions of the same request. */
  readonly ref_id?: string;
}

export type BlocklistInput = BlockedRequest & {
  readonly dimension: BlocklistDimension;
} & (
    | { readonly value: string; readonly value_hmac?: never }
    | { readonly value_hmac: string; readonly value?: never }
  );

export interface BlocklistHit {
  readonly code: 44001;
  readonly data: { readonly risk_msg_code: string };
  readonly ref_id: string;
}

/** One hit row of a blocked request: the dimension, its value digest and the rule code. */
export interface BlockedHitTarget {
  readonly dimension: string;
  readonly value_hmac: string;
  readonly rule_id: string;
}

export interface RecordBlockedHit extends BlockedRequest, BlockedHitTarget {
  /**
   * B1-03zh (BR-ID-36, one read per judgement): the caller's decision already found rule_id in
   * force for this request (and refused on it), so the status is not read again. Absent → the
   * writer reads the status itself and writes nothing for a disabled rule.
   */
  readonly decided_in_force?: true;
}

/** A registration refusal decided but not recorded yet (matchRegistration). */
export interface RegistrationBlock {
  readonly code: 44001;
  readonly data: { readonly risk_msg_code: string };
  /** The hit rows to record with recordHits once the caller's transaction has ended. */
  readonly hits: readonly BlockedHitTarget[];
}

export interface BlockedRegistrationInput {
  readonly app_id: string;
  readonly device_hash: string;
  readonly count: number;
  readonly limit: number;
  readonly phone_hmac: string | null;
  readonly third_party_digest: string | null;
}

export interface RegistrationBlocklistInput {
  readonly app_id: string;
  readonly phone_hmac: string;
  readonly device_hash?: string;
  readonly related_phone: string;
}

export interface BlocklistService {
  /** Check account dimensions without consulting users; persist hits in an independent transaction. */
  check(input: BlocklistInput): Promise<BlocklistHit | null>;
  /** Check both phone and optional device before registration; all hits share one ref_id.
   * Audit writes use an independent transaction even when the caller rolls back trx, so this
   * borrows a second pooled connection while trx is open: callers holding a transaction on the
   * request path use matchRegistration and record after their rollback instead.
   */
  checkRegistration(
    trx: Transaction<DB>,
    input: RegistrationBlocklistInput,
  ): Promise<BlocklistHit | null>;
  /** The decision of checkRegistration read through trx only; writes nothing, borrows nothing. */
  matchRegistration(
    trx: Transaction<DB>,
    input: RegistrationBlocklistInput,
  ): Promise<RegistrationBlock | null>;
  /**
   * For prefix/device-limit decisions already made by identity (pass decided_in_force: true so the
   * rule status is not read a second time).
   */
  recordHit(input: RecordBlockedHit): Promise<{ readonly ref_id: string }>;
  /**
   * B1-03zh (BR-ID-36, one read per judgement): recordHit of a refusal the caller already decided
   * on the rule in force (decided_in_force: true). Optional so that hand-written fakes of this port
   * stay valid; createBlocklistService has it.
   */
  recordDecidedHit?(input: RecordBlockedHit): Promise<{ readonly ref_id: string }>;
  /**
   * All hit rows of one blocked request, one shared ref_id, in a short transaction of its own.
   * Rows matchRegistration returned are decided and written without a second status read.
   */
  recordHits(
    request: BlockedRequest,
    hits: readonly BlockedHitTarget[],
  ): Promise<{ readonly ref_id: string }>;
  /** No backend-issued release record means false; this port does not create release records. */
  allowBlockedRegistration(trx: Transaction<DB>, input: BlockedRegistrationInput): Promise<boolean>;
  /**
   * B1-03zh (BR-ID-36): whether the rule of the app takes part in judgements now (the status read
   * port, same cache as this service's own checks). `executor`: the caller's transaction, if any.
   * Optional so that hand-written fakes of this port stay valid; createBlocklistService has it.
   */
  ruleInForce?(key: RiskRuleKey, executor?: Kysely<DB>): Promise<boolean>;
}

export interface BlocklistOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly logger: RootLogger;
  /** Rule status reader (B1-03zh); defaults to one of its own on `db` and `clock`. */
  readonly rules?: RiskRuleStatusReader;
}

/** Rule code of a blocklist hit on one dimension (BLACKLIST_PHONE, BLACKLIST_DEVICE, …). */
export function blocklistRule(dimension: BlocklistDimension): string {
  return `BLACKLIST_${dimension.toUpperCase()}`;
}

/** BR-ID-33 default mask: the first 3 and the last 4 characters, e.g. 138****5678. */
function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

export function createBlocklistService(options: BlocklistOptions): BlocklistService {
  const { db, clock, crypto, logger } = options;
  const rules = options.rules ?? createRiskRuleStatusReader({ db, clock });
  /** Hit rows matchRegistration returned, with the app they were decided for (decision token). */
  const decidedRows = new WeakMap<BlockedHitTarget, string>();

  function inForce(appId: string, ruleId: string, executor?: Kysely<DB>): Promise<boolean> {
    return rules.isEnabled({ app_id: appId, rule_id: ruleId }, executor);
  }

  /** The rows whose rule is in force (BR-ID-36: a disabled rule writes no hit). */
  async function rowsInForce(
    request: BlockedRequest,
    rows: readonly BlockedHitTarget[],
  ): Promise<BlockedHitTarget[]> {
    const enabled = new Set<string>();
    const unchecked = rows.filter((row) => decidedRows.get(row) !== request.app_id);
    for (const ruleId of new Set(unchecked.map((row) => row.rule_id))) {
      if (await inForce(request.app_id, ruleId)) enabled.add(ruleId);
      else {
        logger.info(
          { app_id: request.app_id, rule_id: ruleId, request_type: request.request_type },
          'risk_rule_disabled_hit_skipped',
        );
      }
    }
    return rows.filter(
      (row) => decidedRows.get(row) === request.app_id || enabled.has(row.rule_id),
    );
  }

  function digestOf(input: BlocklistInput): string {
    if (input.value_hmac !== undefined) return input.value_hmac;
    if (input.dimension === 'device') return input.value;
    return crypto.blindIndex(input.value, HMAC_CONTEXTS[input.dimension]);
  }

  /** The violation type of an active, unexpired entry of this value, or null. */
  async function matchOn(
    reader: Kysely<DB>,
    appId: string,
    dimension: BlocklistDimension,
    valueHmac: string,
  ): Promise<string | null> {
    const row = await reader
      .withSchema('app')
      .selectFrom('blocklist')
      .select('violation_type')
      .where('app_id', '=', appId)
      .where('dimension', '=', dimension)
      .where('value_hmac', '=', valueHmac)
      .where('status', '=', 'active')
      .where('expire_at', '>', clock.now())
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.violation_type ?? null;
  }

  /**
   * The hit rows of one blocked request, in one short transaction of their own. The callers have
   * already kept only rules in force (check / checkRegistration decided on them; recordHit and
   * recordHits take decided rows as they are and filter the others first).
   */
  async function writeHits(
    request: BlockedRequest,
    rows: readonly BlockedHitTarget[],
  ): Promise<{ readonly ref_id: string }> {
    if (rows.length === 0) throw new Error('risk: a blocked request needs at least one hit row');
    const now = clock.now();
    const refId = request.ref_id ?? newUuidV7(now);
    const register = request.request_type === 'register';
    const userId = register ? null : (request.user_id ?? null);
    const amount = request.request_type === 'withdraw' ? (request.amount_fen ?? null) : null;
    const relatedHmac = crypto.blindIndex(request.related_phone, HMAC_CONTEXTS.phone);
    const scene = request.request_type ?? 'blocked_request';
    await db.transaction().execute(async (trx) => {
      const app = trx.withSchema('app');
      for (const ruleId of new Set(rows.map((row) => row.rule_id))) {
        await app
          .insertInto('risk_rules')
          .values({
            id: newUuidV7(now),
            app_id: request.app_id,
            rule_id: ruleId,
            scene,
            conditions: sql`'{}'::jsonb`,
            risk_action: 'block',
            status: 'active',
            version: 1,
            created_at: now,
            updated_at: now,
          })
          .onConflict((oc) => oc.columns(['app_id', 'rule_id']).doNothing())
          .execute();
      }
      await app
        .insertInto('risk_hits')
        .values(
          rows.map((row) => ({
            app_id: request.app_id,
            user_id: userId,
            rule_id: row.rule_id,
            risk_action: 'block',
            dimension: row.dimension,
            value_hmac: row.value_hmac,
            ref_type: 'blocked_request',
            ref_id: refId,
            request_type: request.request_type,
            related_phone_hmac: relatedHmac,
            related_phone_masked: maskPhone(request.related_phone),
            amount_fen: amount,
            created_at: now,
          })),
        )
        .execute();
    });
    for (const row of rows) {
      logger.info(
        {
          app_id: request.app_id,
          rule_id: row.rule_id,
          dimension: row.dimension,
          request_type: request.request_type,
          ref_id: refId,
        },
        'risk_blocked_request_hit',
      );
    }
    return { ref_id: refId };
  }

  function hitOf(violation: string, refId: string): BlocklistHit {
    return { code: 44001, data: { risk_msg_code: `blocklist.${violation}` }, ref_id: refId };
  }

  /** Phone and optional device read through trx only; the first matched entry names the code. */
  async function matchRegistrationIn(
    trx: Transaction<DB>,
    input: RegistrationBlocklistInput,
  ): Promise<RegistrationBlock | null> {
    const candidates: { dimension: BlocklistDimension; value_hmac: string }[] = [
      { dimension: 'phone', value_hmac: input.phone_hmac },
    ];
    if (input.device_hash !== undefined) {
      candidates.push({ dimension: 'device', value_hmac: input.device_hash });
    }
    const hits: BlockedHitTarget[] = [];
    let violation: string | null = null;
    for (const candidate of candidates) {
      const ruleId = blocklistRule(candidate.dimension);
      // A disabled dimension rule decides nothing (BR-ID-36); read through trx.
      if (!(await inForce(input.app_id, ruleId, trx))) continue;
      const matched = await matchOn(trx, input.app_id, candidate.dimension, candidate.value_hmac);
      if (matched === null) continue;
      violation ??= matched;
      const hit: BlockedHitTarget = { ...candidate, rule_id: ruleId };
      decidedRows.set(hit, input.app_id);
      hits.push(hit);
    }
    if (violation === null) return null;
    return { code: 44001, data: { risk_msg_code: `blocklist.${violation}` }, hits };
  }

  /**
   * recordHit / recordHits: rows decided by the caller are written as they are; of the others,
   * rows of disabled rules are dropped; none left → nothing written.
   */
  async function recordInForce(
    request: BlockedRequest,
    rows: readonly BlockedHitTarget[],
    decided = false,
  ): Promise<{ readonly ref_id: string }> {
    if (rows.length === 0) throw new Error('risk: a blocked request needs at least one hit row');
    const kept = decided ? rows : await rowsInForce(request, rows);
    if (kept.length === 0) return { ref_id: request.ref_id ?? newUuidV7(clock.now()) };
    return writeHits(request, kept);
  }

  function registerRequest(input: RegistrationBlocklistInput): BlockedRequest {
    return { app_id: input.app_id, request_type: 'register', related_phone: input.related_phone };
  }

  return Object.freeze({
    async check(input: BlocklistInput): Promise<BlocklistHit | null> {
      const valueHmac = digestOf(input);
      // A disabled dimension rule decides nothing (BR-ID-36).
      if (!(await inForce(input.app_id, blocklistRule(input.dimension)))) return null;
      const violation = await matchOn(db, input.app_id, input.dimension, valueHmac);
      if (violation === null) return null;
      const { ref_id: refId } = await writeHits(input, [
        {
          dimension: input.dimension,
          value_hmac: valueHmac,
          rule_id: blocklistRule(input.dimension),
        },
      ]);
      return hitOf(violation, refId);
    },

    async checkRegistration(
      trx: Transaction<DB>,
      input: RegistrationBlocklistInput,
    ): Promise<BlocklistHit | null> {
      // Read in the caller's transaction; the record goes through its own short transaction.
      const block = await matchRegistrationIn(trx, input);
      if (block === null) return null;
      const { ref_id: refId } = await writeHits(registerRequest(input), block.hits);
      return { code: 44001, data: block.data, ref_id: refId };
    },

    matchRegistration: matchRegistrationIn,

    async recordHit(input: RecordBlockedHit): Promise<{ readonly ref_id: string }> {
      const { decided_in_force: decided, ...request } = input;
      return recordInForce(
        request,
        [{ dimension: input.dimension, value_hmac: input.value_hmac, rule_id: input.rule_id }],
        decided === true,
      );
    },

    recordDecidedHit(input: RecordBlockedHit): Promise<{ readonly ref_id: string }> {
      return recordInForce(
        input,
        [{ dimension: input.dimension, value_hmac: input.value_hmac, rule_id: input.rule_id }],
        true,
      );
    },

    recordHits(request: BlockedRequest, hits: readonly BlockedHitTarget[]) {
      return recordInForce(request, hits);
    },

    ruleInForce(key: RiskRuleKey, executor?: Kysely<DB>): Promise<boolean> {
      return rules.isEnabled(key, executor);
    },

    async allowBlockedRegistration(
      trx: Transaction<DB>,
      input: BlockedRegistrationInput,
    ): Promise<boolean> {
      // The one-time release after a revoked appeal (BR-ID-05 细则, BR-ID-36 结案) is stored by the
      // backend appeal task; until that store exists there is no release record, so the answer
      // is the default denial. The read (and its consumption) will run on trx only.
      void trx;
      void input;
      // TODO(规划/11 §2.3): read and consume the one-time registration release in trx — blocked on the backend appeal-closure task that defines its store
      return false;
    },
  });
}
