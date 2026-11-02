// POST /admin/v1/users/{user_id}/realname-correction (adminCorrectUserRealname, CT-24q; 规划/08 BR-ID-25
// 细则「实名更正」; D10-165, D10-167, D10-181 ②, D10-185, D10-192, D10-246, D10-248, D10-250; task
// B1-27a §9). identity is the only writer of app.realname and app.realname_prior_identities.
//
// After the admin request check, the operation guard (user.realname_fix, totp step-up) and the body
// schema, first hit wins:
//   1. 20001 data.fields=[user_id] — no user of this app with that id.
//   2. 30419 data.reason, no vendor call:
//        realname_not_verified   the realname row is missing or not verified
//        account_deleting        deletion stage cooling / processing (data.stage, as 10007's)
//        account_deleted         deletion stage done (no data.stage)
//        withdrawal_in_progress  any withdrawal outside the BR-WDR-08 terminal set (hasNonTerminal)
//        reverify_pending        the account carries the flag, whatever its re-verified devices
//        identity_blacklisted    the current id_no_hmac is on an active id_no blocklist entry
//   3. 20001 data.fields=[id_no] — format (parseResidentIdNo, as realname.ts); [name] when the
//      name is empty after normalizePersonName.
//   4. 44001 — the new number is on an active id_no blocklist entry; no risk_hits, no appeal.
//   5. 30407 — under MIN_REALNAME_AGE at the Clock instant (BR-ID-26).
//   6. 30405 — the new id_no_hmac is verified on another user of this app (the user's own does not
//      count; the other account is never revealed).
//   7. vendor (createRealnameVerifier): mismatch 30406, timeout 50401, anything else 50301; nothing
//      is saved and nothing is counted against the user's daily attempts (no Redis is touched:
//      the self-service counter of realname-attempts.ts is never reserved here).
//   8. match → one transaction: lock the user row (FOR NO KEY UPDATE, the same user-level lock as
//      a withdrawal application and the payout saves; see payout-account.ts for why not FOR
//      UPDATE), judge 2 again on fresh reads (a non-terminal withdrawal that appeared meanwhile is
//      30419 withdrawal_in_progress, nothing written); when hasSucceeded, insertPriorIdentity
//      (../infra/realname-prior-identities.ts) before the overwrite; overwrite the realname row
//      (same id: name, ID number and birth date ciphertexts, id_no_hmac, provider, verified_at =
//      Clock; row_version CAS); every current payout account of the user is_current = false
//      through createPayoutAccountInvalidation (./payout-account-invalidation.ts: row_version
//      CAS, one payout_account_changes row each with limit_exempt_reason 'realname_correction',
//      operator admin:<id>; exempt rows are not counted, and without a current account the next
//      binding is a first binding, so neither counts in the monthly changes); publish
//      user.realname_corrected (user_id, old and new id_no_hmac, no plaintext); the audit row. A
//      concurrent verification of the same number on another user loses on the partial unique
//      index (23505) → 30405, everything rolled back.
// Every submission from 1 on writes one audit row user_realname_correct (admin, reason, result
// code, the new value masked; a success also the masked before and after values); a refusal's row
// is written in a short transaction of its own after any other transaction ended. No name or ID
// number in plaintext in logs, audits, events or errors.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no decorators.
import type { DB } from '@couli/db';
import { isAtLeastAge, normalizePersonName, parseResidentIdNo } from '@couli/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { AuditPort, Clock, EventBus, FieldCrypto, RootLogger } from '../../platform/index.ts';
import { maskName } from '../domain/mask-name.ts';
import { insertPriorIdentity } from '../infra/realname-prior-identities.ts';
import { REALNAME_CONTEXT } from '../infra/realname-reader.ts';
import { readReverifyAccount } from '../infra/reverify-store.ts';
import { createDeletionStageReader, type DeletionStage } from '../ports/deletion-stage.ts';
import type {
  RealnameVerificationResult,
  RealnameVerifierPort,
} from '../ports/realname-verifier.ts';
import type {
  WithdrawalNonTerminalReader,
  WithdrawalSucceededReader,
} from '../ports/withdrawal-in-flight.ts';
import { createPayoutAccountInvalidation } from './payout-account-invalidation.ts';
import { MIN_REALNAME_AGE } from './realname.ts';

/** The audit action of every submission (contract adminCorrectUserRealname). */
export const ADMIN_REALNAME_CORRECTION_ACTION = 'user_realname_correct';
/** 规划/02 §11: published on the overwrite's transaction. */
export const REALNAME_CORRECTED_EVENT = 'user.realname_corrected';
/** The partial unique index (app_id, id_no_hmac) WHERE status = 'verified' of migration 0041. */
const VERIFIED_ID_NO_KEY = 'realname_verified_id_no_hmac_key';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminRealnameCorrectionCommand {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
  readonly userId: string;
  /** As submitted; normalised here. */
  readonly name: string;
  /** As submitted; normalised here. */
  readonly idNo: string;
  readonly reason: string;
}

export interface AdminUserRealname {
  readonly user_id: string;
  readonly realname_status: 'verified';
  readonly masked_name: string;
  readonly masked_id_no: string;
  readonly verified_at: string;
}

export type AdminRealnameCorrectionRefusal =
  | {
      readonly reason: 'realname_not_verified' | 'account_deleted';
    }
  | { readonly reason: 'account_deleting'; readonly stage: 'cooling' | 'processing' }
  | { readonly reason: 'withdrawal_in_progress' | 'reverify_pending' | 'identity_blacklisted' };

export type AdminRealnameCorrectionResult =
  | { readonly code: 0; readonly data: AdminUserRealname }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
  | { readonly code: 30419; readonly data: AdminRealnameCorrectionRefusal }
  | { readonly code: 30405 | 30406 | 30407 | 44001 | 50301 | 50401 };

/**
 * BR-ID-31 ID-number dimension, read only (a console refusal records no risk_hits): true when an
 * active, unexpired id_no entry of the app matches the number. app.module binds it over risk's
 * blocklist digests (realname.id_no_hmac and risk's own blocklist.id_no context).
 */
export interface IdNoBlocklistPort {
  listed(
    handle: Kysely<DB>,
    input: { readonly appId: string; readonly idNo: string; readonly idNoHmac: string },
  ): Promise<boolean>;
}

export type CorrectionWithdrawals = WithdrawalNonTerminalReader & WithdrawalSucceededReader;

export interface AdminRealnameCorrectionOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn'>;
  readonly crypto: FieldCrypto;
  /** PRIOR_IDENTITY_FIELD_CRYPTO: the isolated store's own keys. */
  readonly priorCrypto: FieldCrypto;
  /** createRealnameVerifier(appEnv): null when no vendor is assembled (50301). */
  readonly verifier: RealnameVerifierPort | null;
  /** payout's readers of the user's withdrawals, on the caller's transaction. */
  readonly withdrawals: CorrectionWithdrawals;
  readonly blocklist: IdNoBlocklistPort;
  /** Binds the audit port to a handle (app.module: admin's createAuditWriter). */
  readonly auditOn: (handle: Kysely<DB>) => AuditPort;
  readonly events: Pick<EventBus, 'publish'>;
}

/** The verified identity the realname row holds, decrypted in memory only. */
interface Current {
  readonly id: string;
  readonly name: string;
  readonly idNo: string;
  readonly idNoHmac: string;
  readonly verifiedAt: Date;
  readonly rowVersion: number;
}

/** The normalised new values. */
interface Next {
  readonly name: string;
  readonly idNo: string;
  readonly idNoHmac: string;
  readonly birthDate: string;
}

type Judgement =
  | { readonly kind: 'refused'; readonly result: AdminRealnameCorrectionResult }
  | { readonly kind: 'open'; readonly current: Current };

/** Thrown out of the overwrite's transaction so that it rolls back. */
class Refused extends Error {
  readonly result: AdminRealnameCorrectionResult;
  constructor(result: AdminRealnameCorrectionResult) {
    super('identity: realname correction refused');
    this.name = 'Refused';
    this.result = result;
  }
}

/** BR-ID-33 身份证 of a parsed 18-character number: first 1 + 16 "*" + last 1. */
export function maskIdNo(idNo: string): string {
  return `${idNo.charAt(0)}${'*'.repeat(Math.max(0, idNo.length - 2))}${idNo.slice(-1)}`;
}

function uniqueViolationOf(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const pg = error as { code?: unknown; constraint?: unknown };
  return pg.code === '23505' && pg.constraint === constraint;
}

/** A definite vendor answer, else timeout / unavailable (malformed answers are unavailable). */
function outcomeOf(
  result: RealnameVerificationResult | undefined,
):
  | { readonly outcome: 'match' | 'mismatch'; readonly provider: string }
  | 'timeout'
  | 'unavailable' {
  if (typeof result !== 'object' || result === null) return 'unavailable';
  const { outcome, provider } = result as {
    readonly outcome?: unknown;
    readonly provider?: unknown;
  };
  if (outcome === 'timeout') return 'timeout';
  if (
    (outcome === 'match' || outcome === 'mismatch') &&
    typeof provider === 'string' &&
    /\S/.test(provider)
  ) {
    return { outcome, provider };
  }
  return 'unavailable';
}

const cipherText = (value: Uint8Array) => Buffer.from(value).toString('utf8');

export class AdminRealnameCorrection {
  readonly #options: AdminRealnameCorrectionOptions;
  readonly #stages: ReturnType<typeof createDeletionStageReader>;

  constructor(options: AdminRealnameCorrectionOptions) {
    this.#options = options;
    this.#stages = createDeletionStageReader({ db: options.db });
  }

  async correct(command: AdminRealnameCorrectionCommand): Promise<AdminRealnameCorrectionResult> {
    // The submitted values as they may appear in the audit row: masked, never in plaintext.
    const name = normalizePersonName(command.name);
    const parsed = parseResidentIdNo(command.idNo);
    const masked: Record<string, string> = {};
    if (name.length > 0) masked['new_name_masked'] = maskName(name);
    if (parsed.ok) masked['new_id_no_masked'] = maskIdNo(parsed.id_no);
    const result = await this.#decide(command, name, parsed);
    if (result.code !== 0) await this.#auditRefusal(command, result, masked);
    return result;
  }

  async #decide(
    command: AdminRealnameCorrectionCommand,
    name: string,
    parsed: ReturnType<typeof parseResidentIdNo>,
  ): Promise<AdminRealnameCorrectionResult> {
    const { db, clock, crypto, blocklist } = this.#options;
    if (!UUID.test(command.userId)) return { code: 20001, data: { fields: ['user_id'] } };

    // 1–2: read only, in a short transaction of their own (the withdrawal port reads on one).
    const judged = await db.transaction().execute((trx) => this.#judge(trx, command, false));
    if (judged.kind === 'refused') return judged.result;

    // 3: format.
    const fields: string[] = [];
    if (name.length === 0) fields.push('name');
    if (!parsed.ok) fields.push('id_no');
    if (!parsed.ok || fields.length > 0) return { code: 20001, data: { fields } };
    const next: Next = {
      name,
      idNo: parsed.id_no,
      idNoHmac: crypto.blindIndex(parsed.id_no, REALNAME_CONTEXT.idNo),
      birthDate: parsed.birth_date,
    };

    // 4: the new number blacklisted (read only: no risk_hits, no appeal).
    if (
      await blocklist.listed(db, {
        appId: command.appId,
        idNo: next.idNo,
        idNoHmac: next.idNoHmac,
      })
    ) {
      return { code: 44001 };
    }
    // 5: age at the Clock instant (BR-ID-26).
    if (!isAtLeastAge(next.birthDate, MIN_REALNAME_AGE, clock.now())) return { code: 30407 };
    // 6: verified on another user of this app (the user's own value does not count).
    if (await this.#occupiedElsewhere(db, command, next.idNoHmac)) return { code: 30405 };

    // 7: the vendor, outside every transaction and lock; never counted.
    const vendor = await this.#verify(command, next);
    if ('code' in vendor) return vendor;

    // 8: the overwrite under the user row lock.
    try {
      return await db
        .transaction()
        .execute((trx) => this.#overwrite(trx, command, next, vendor.provider));
    } catch (error) {
      // Thrown out of the transaction: everything it wrote is rolled back.
      if (error instanceof Refused) return error.result;
      if (uniqueViolationOf(error, VERIFIED_ID_NO_KEY)) return { code: 30405 };
      throw error;
    }
  }

  /** 1–2 on `trx`; with `lock`, after taking the user row lock (every value read fresh). */
  async #judge(
    trx: Transaction<DB>,
    command: AdminRealnameCorrectionCommand,
    lock: boolean,
  ): Promise<Judgement> {
    const { crypto, withdrawals, blocklist } = this.#options;
    const app = trx.withSchema('app');
    const subject = { appId: command.appId, userId: command.userId };
    const users = app
      .selectFrom('users')
      .select('id')
      .where('app_id', '=', command.appId)
      .where('id', '=', command.userId);
    const user = await (lock ? users.forNoKeyUpdate() : users).executeTakeFirst();
    if (user === undefined) {
      return { kind: 'refused', result: { code: 20001, data: { fields: ['user_id'] } } };
    }
    const refuse = (data: AdminRealnameCorrectionRefusal): Judgement => ({
      kind: 'refused',
      result: { code: 30419, data },
    });

    const row = await app
      .selectFrom('realname')
      .select(['id', 'status', 'name_cipher', 'id_no_cipher', 'id_no_hmac', 'verified_at'])
      .select('row_version')
      .where('app_id', '=', command.appId)
      .where('user_id', '=', command.userId)
      .executeTakeFirst();
    if (row?.status !== 'verified') return refuse({ reason: 'realname_not_verified' });

    const stage: DeletionStage =
      (await this.#stages.read(trx, { appId: command.appId, userIds: [command.userId] })).get(
        command.userId,
      ) ?? 'none';
    if (stage === 'cooling' || stage === 'processing') {
      return refuse({ reason: 'account_deleting', stage });
    }
    if (stage === 'done') return refuse({ reason: 'account_deleted' });

    if (await withdrawals.hasNonTerminal(trx, subject)) {
      return refuse({ reason: 'withdrawal_in_progress' });
    }

    const reverify = await readReverifyAccount(app, {
      app_id: command.appId,
      user_id: command.userId,
    });
    if (reverify?.flagged_at != null) return refuse({ reason: 'reverify_pending' });

    // realname_verified_check guarantees these on a verified row.
    if (
      row.name_cipher === null ||
      row.id_no_cipher === null ||
      row.id_no_hmac === null ||
      row.verified_at === null
    ) {
      throw new Error('identity: incomplete verified realname record');
    }
    const current: Current = {
      id: row.id,
      name: crypto.decrypt(cipherText(row.name_cipher), REALNAME_CONTEXT.name),
      idNo: crypto.decrypt(cipherText(row.id_no_cipher), REALNAME_CONTEXT.idNo),
      idNoHmac: row.id_no_hmac,
      verifiedAt: row.verified_at,
      rowVersion: row.row_version,
    };
    if (
      await blocklist.listed(trx, {
        appId: command.appId,
        idNo: current.idNo,
        idNoHmac: current.idNoHmac,
      })
    ) {
      return refuse({ reason: 'identity_blacklisted' });
    }
    return { kind: 'open', current };
  }

  async #occupiedElsewhere(
    db: Kysely<DB>,
    command: AdminRealnameCorrectionCommand,
    idNoHmac: string,
  ): Promise<boolean> {
    const row = await db
      .withSchema('app')
      .selectFrom('realname')
      .select('id')
      .where('app_id', '=', command.appId)
      .where('id_no_hmac', '=', idNoHmac)
      .where('status', '=', 'verified')
      .where('user_id', '<>', command.userId)
      .executeTakeFirst();
    return row !== undefined;
  }

  async #verify(
    command: AdminRealnameCorrectionCommand,
    next: Next,
  ): Promise<{ readonly provider: string } | { readonly code: 30406 | 50301 | 50401 }> {
    const { verifier, logger } = this.#options;
    if (verifier === null) return { code: 50301 };
    let answer: RealnameVerificationResult | undefined;
    try {
      answer = await verifier.verify({
        app_id: command.appId,
        user_id: command.userId,
        name: next.name,
        id_no: next.idNo,
      });
    } catch {
      // The rejection may carry the submitted values: never log or rethrow it.
      answer = undefined;
    }
    const outcome = outcomeOf(answer);
    if (outcome === 'timeout' || outcome === 'unavailable') {
      logger.warn(
        { app_id: command.appId, user_id: command.userId, outcome },
        'identity_admin_realname_vendor_failed',
      );
      return { code: outcome === 'timeout' ? 50401 : 50301 };
    }
    if (outcome.outcome === 'mismatch') return { code: 30406 };
    return { provider: outcome.provider };
  }

  async #overwrite(
    trx: Transaction<DB>,
    command: AdminRealnameCorrectionCommand,
    next: Next,
    provider: string,
  ): Promise<AdminRealnameCorrectionResult> {
    const { clock, crypto, priorCrypto, withdrawals, events, logger } = this.#options;
    const judged = await this.#judge(trx, command, true);
    if (judged.kind === 'refused') throw new Refused(judged.result);
    const { current } = judged;
    const app = trx.withSchema('app');
    const subject = { appId: command.appId, userId: command.userId };
    const now = clock.now();

    // 旧身份留存: before the overwrite, only when the old identity has a paid-out withdrawal.
    if (await withdrawals.hasSucceeded(trx, subject)) {
      await insertPriorIdentity(trx, priorCrypto, {
        appId: command.appId,
        userId: command.userId,
        name: current.name,
        idNo: current.idNo,
        idNoHmac: current.idNoHmac,
        verifiedAt: current.verifiedAt,
        correctedAt: now,
      });
    }

    const encrypt = (value: string, context: string) =>
      Buffer.from(crypto.encrypt(value, context), 'utf8');
    const overwritten = await app
      .updateTable('realname')
      .set({
        name_cipher: encrypt(next.name, REALNAME_CONTEXT.name),
        id_no_cipher: encrypt(next.idNo, REALNAME_CONTEXT.idNo),
        id_no_hmac: next.idNoHmac,
        birth_date_cipher: encrypt(next.birthDate, REALNAME_CONTEXT.birthDate),
        provider,
        verified_at: now,
        updated_at: now,
        row_version: sql<number>`row_version + 1`,
      })
      .where('app_id', '=', command.appId)
      .where('id', '=', current.id)
      .where('status', '=', 'verified')
      .where('row_version', '=', current.rowVersion)
      .executeTakeFirst();
    // Under the user lock nobody else writes this verified row.
    if (overwritten.numUpdatedRows !== 1n) {
      throw new Error('identity: realname row changed under the user lock');
    }

    // Every current payout account stops being current (BR-WDR-02: bind again under the new
    // identity), one exempt payout_account_changes row each (limit_exempt_reason
    // 'realname_correction'), so neither this invalidation nor the next binding (a first binding
    // without a current account) counts in the monthly changes. A CAS miss throws: all rolled back.
    const { retired } = await createPayoutAccountInvalidation().invalidate(trx, {
      appId: command.appId,
      userId: command.userId,
      operator: `admin:${command.adminId}`,
      now,
    });

    await events.publish(trx, {
      appId: command.appId,
      name: REALNAME_CORRECTED_EVENT,
      payload: {
        user_id: command.userId,
        old_id_no_hmac: current.idNoHmac,
        new_id_no_hmac: next.idNoHmac,
      },
    });

    const before = { name_masked: maskName(current.name), id_no_masked: maskIdNo(current.idNo) };
    const after = { name_masked: maskName(next.name), id_no_masked: maskIdNo(next.idNo) };
    await this.#options.auditOn(trx).append({
      appId: command.appId,
      actor: command.adminId,
      action: ADMIN_REALNAME_CORRECTION_ACTION,
      target: command.userId,
      before,
      after: {
        user_id: command.userId,
        reason: command.reason,
        result_code: 0,
        ...after,
        payout_accounts_invalidated: retired,
      },
      ip: command.ip,
    });

    logger.info(
      {
        app_id: command.appId,
        user_id: command.userId,
        admin_id: command.adminId,
        provider,
        payout_accounts_invalidated: retired,
      },
      'identity_admin_realname_corrected',
    );
    return {
      code: 0,
      data: {
        user_id: command.userId,
        realname_status: 'verified',
        masked_name: after.name_masked,
        masked_id_no: after.id_no_masked,
        verified_at: now.toISOString(),
      },
    };
  }

  /** A refused submission's audit row, in a short transaction of its own. */
  async #auditRefusal(
    command: AdminRealnameCorrectionCommand,
    result: Exclude<AdminRealnameCorrectionResult, { code: 0 }>,
    masked: Readonly<Record<string, string>>,
  ): Promise<void> {
    const detail =
      result.code === 30419
        ? { refusal_reason: result.data.reason }
        : result.code === 20001
          ? { fields: [...result.data.fields] }
          : {};
    await this.#options.db.transaction().execute((trx) =>
      this.#options.auditOn(trx).append({
        appId: command.appId,
        actor: command.adminId,
        action: ADMIN_REALNAME_CORRECTION_ACTION,
        target: command.userId,
        before: null,
        after: {
          user_id: command.userId,
          reason: command.reason,
          result_code: result.code,
          ...detail,
          ...masked,
        },
        ip: command.ip,
      }),
    );
  }
}
