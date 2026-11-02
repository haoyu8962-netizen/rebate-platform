// The self-service re-verification of a recycled phone (规划/08 BR-WDR-01 细则「旧手机号被二次放号时的
// 提现加验」; contract getReverify, reverifyByIdNumber, reverifyByOauth; B1-02zp; D10-149, D10-161).
// Stages ① ② ③, the session scope, the ban and the version gate ran before these.
//
// Both submissions, in this order:
//   1. no flag, or this device already re-verified → passed; nothing compared, counted or written.
//   2. the way is not among the identities frozen at flagging → 10010 with the current method, not
//      counted (a real name completed or a provider bound after the flag does not count).
//   3. a failure place is reserved (infra/reverify-store.ts); none left → 10010 manual.
//   4. the comparison. Different → 20005, the place stays. Same → settlePassed. No comparison ran
//      (20004, 50305, 50001, a thrown error) → the place is given back.
// By ID number the only comparison is against the stored blind index (BR-ID-25: no vendor, no
// SMS). A flag with realname true and no completed real name has nothing to equal, which is a
// mismatch. The ID number stays in memory: it never reaches a log, an error or a response.
// Third party: the attempt (purpose=reverify, this user, device and provider) is consumed after the
// reservation, so a locked account burns no attempt; then the exchange as at login. The identity
// must be this account's binding of a provider in the frozen identities. No step_up_token.
//
// Nothing here holds a transaction across the exchange: every step commits on its own, so the
// reservation is visible to a concurrent request before the comparison.
//
// An account that entered deletion in between (B1-02zy): the store writes nothing. No place left
// answers 10010 manual as above; a comparison that passed still answers 0, only without the record
// and without the passed log.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { accountingDate, parseResidentIdNo } from '@couli/domain';
import type { Kysely } from 'kysely';
import type { Clock, FieldCrypto, RootLogger, TokenPrincipal } from '../../platform/index.ts';
import {
  MANUAL_REQUIREMENT,
  REVERIFY_FAIL_LIMIT,
  type ReverifyRequirement,
} from '../domain/reverify.ts';
import { replaceAppleRefreshToken } from '../infra/oauth-accounts.ts';
import { REALNAME_CONTEXT } from '../infra/realname-reader.ts';
import {
  boundUnionId,
  releaseFailure,
  reserveFailure,
  settlePassed,
  verifiedIdNoHmac,
  type FailureReservation,
  type ReverifySubject,
} from '../infra/reverify-store.ts';
import type { OauthAttemptService } from './oauth-attempts.ts';
import {
  pendingData,
  reverifyStanding,
  type ReverifyPendingData,
  type ReverifyStanding,
} from './reverify-gate.ts';
import { credentialsOf, type ThirdPartyIdentity, type ThirdPartyIdentityPort } from './step-up.ts';

export type ReverifyResult =
  | { readonly code: 0 }
  | { readonly code: 10010; readonly data: ReverifyPendingData }
  | { readonly code: 10403 | 20004 | 50001 }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
  | {
      readonly code: 20005;
      readonly data: { readonly fail_limit: number; readonly fail_remaining: number };
    }
  | { readonly code: 50305; readonly data: { readonly provider: Schema<'LoginProvider'> } };

export interface ReverifyService {
  status(principal: TokenPrincipal): Promise<Schema<'ReverifyStatusData'>>;
  byIdNumber(principal: TokenPrincipal, idNo: string): Promise<ReverifyResult>;
  byOauth(
    principal: TokenPrincipal,
    device: { readonly appId: string; readonly deviceId: string },
    body: Schema<'ReverifyByOauthRequest'>,
  ): Promise<ReverifyResult>;
}

export interface ReverifyOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly logger: Pick<RootLogger, 'info' | 'warn'>;
  readonly attempts: OauthAttemptService;
  readonly thirdPartyIdentity?: ThirdPartyIdentityPort;
}

const PASSED: ReverifyResult = Object.freeze({ code: 0 });

function pending(requirement: ReverifyRequirement): ReverifyResult {
  return { code: 10010, data: pendingData(requirement) };
}

function mismatch(reservation: FailureReservation): ReverifyResult {
  return {
    code: 20005,
    data: {
      fail_limit: REVERIFY_FAIL_LIMIT,
      fail_remaining: Math.max(REVERIFY_FAIL_LIMIT - reservation.count, 0),
    },
  };
}

export function createReverifyService(options: ReverifyOptions): ReverifyService {
  const { db, clock, crypto, logger, attempts, thirdPartyIdentity } = options;

  const subjectOf = (principal: TokenPrincipal): ReverifySubject => ({
    app_id: principal.app_id,
    user_id: principal.uid,
  });

  function standing(principal: TokenPrincipal): Promise<ReverifyStanding> {
    return reverifyStanding(
      db,
      subjectOf(principal),
      principal.device_id,
      accountingDate(clock.now()),
    );
  }

  /** Gives the place back; a failure only logs (the count stays stricter). */
  async function release(subject: ReverifySubject, reservation: FailureReservation) {
    try {
      await releaseFailure(db, subject, reservation, clock.now());
    } catch {
      logger.warn(
        { app_id: subject.app_id, user_id: subject.user_id },
        'identity_reverify_release_failed',
      );
    }
  }

  function reserve(subject: ReverifySubject): Promise<FailureReservation | null> {
    const now = clock.now();
    return reserveFailure(db, subject, accountingDate(now), now);
  }

  function logPassed(subject: ReverifySubject, method: 'id_number' | 'oauth'): void {
    logger.info(
      { app_id: subject.app_id, user_id: subject.user_id, method },
      'identity_reverify_passed',
    );
  }

  /** The port's answer: an identity, or the code that ends the request. */
  async function exchange(
    body: Schema<'ReverifyByOauthRequest'>,
    nonce: string,
  ): Promise<ThirdPartyIdentity | ReverifyResult> {
    const unavailable: ReverifyResult = { code: 50305, data: { provider: body.provider } };
    if (thirdPartyIdentity === undefined) return unavailable;
    let answer: Awaited<ReturnType<ThirdPartyIdentityPort['exchange']>>;
    try {
      answer = await thirdPartyIdentity.exchange({ ...credentialsOf(body), nonce });
    } catch {
      // A provider failure is «unavailable»; its error may carry credentials and is never logged.
      return unavailable;
    }
    if (typeof answer !== 'object' || answer === null) return unavailable;
    if ('invalid' in answer) return { code: 20004 };
    if ('unavailable' in answer) return unavailable;
    if (typeof answer.union_id !== 'string' || answer.union_id.length === 0) return unavailable;
    return answer;
  }

  const service: ReverifyService = {
    async status(principal) {
      const current = await standing(principal);
      if (current.settled) {
        return {
          required: false,
          method: null,
          providers: [],
          fail_limit: null,
          fail_remaining: null,
        };
      }
      const { requirement } = current;
      return {
        required: true,
        method: requirement.method,
        providers: [...requirement.providers],
        fail_limit: requirement.fail_limit,
        fail_remaining: requirement.fail_remaining,
      };
    },

    async byIdNumber(principal, idNo) {
      const parsed = parseResidentIdNo(idNo);
      if (!parsed.ok) return { code: 20001, data: { fields: ['id_no'] } };
      const current = await standing(principal);
      if (current.settled) return PASSED;
      if (!current.trusted.realname) return pending(current.requirement);
      const subject = subjectOf(principal);
      const stored = await verifiedIdNoHmac(db, subject);
      const submitted = crypto.blindIndex(parsed.id_no, REALNAME_CONTEXT.idNo);
      const reservation = await reserve(subject);
      if (reservation === null) return pending(MANUAL_REQUIREMENT);
      if (stored !== submitted) return mismatch(reservation);
      const settled = await settlePassed(db, subject, {
        deviceHash: current.deviceHash,
        now: clock.now(),
      });
      if (settled) logPassed(subject, 'id_number');
      return PASSED;
    },

    async byOauth(principal, device, body) {
      // The token and the signing device must be of one app (BR-ID-07).
      if (principal.app_id !== device.appId) return { code: 10403 };
      const current = await standing(principal);
      if (current.settled) return PASSED;
      const { provider } = body;
      if (!current.trusted.providers.includes(provider)) return pending(current.requirement);
      const subject = subjectOf(principal);
      const reservation = await reserve(subject);
      if (reservation === null) return pending(MANUAL_REQUIREMENT);
      let compared = false;
      try {
        const consumed = await attempts.consume({
          app_id: principal.app_id,
          provider,
          purpose: 'reverify',
          device_id: device.deviceId,
          uid: principal.uid,
          attempt_id: body.attempt_id,
        });
        if (consumed.code !== 0) return { code: consumed.code };
        const identity = await exchange(body, consumed.data.nonce);
        if ('code' in identity) return identity;
        const bound = await boundUnionId(db, subject, provider);
        if (bound !== identity.union_id) {
          compared = true;
          return mismatch(reservation);
        }
        const refreshToken = provider === 'apple' ? identity.apple_refresh_token : undefined;
        const now = clock.now();
        const settled = await settlePassed(db, subject, {
          deviceHash: current.deviceHash,
          now,
          ...(refreshToken === undefined
            ? {}
            : {
                alongside: (trx) =>
                  replaceAppleRefreshToken(
                    trx,
                    {
                      ...subject,
                      union_id: identity.union_id,
                      refresh_token: refreshToken,
                    },
                    { clock, crypto },
                  ),
              }),
        });
        compared = true;
        if (settled) logPassed(subject, 'oauth');
        return PASSED;
      } finally {
        if (!compared) await release(subject, reservation);
      }
    },
  };
  return Object.freeze(service);
}
