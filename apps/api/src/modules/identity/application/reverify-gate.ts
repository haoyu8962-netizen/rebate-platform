// The re-verification gate of a recycled phone (规划/08 BR-WDR-01 细则「旧手机号被二次放号时的提现加验」
// 位置与返回码, BR-WDR-03 ③b, BR-ID-27; contract 10010; task B1-02zq): the account carries the flag
// and this device is not one of its re-verified devices → 10010 with the method the Reverify page
// offers. standing() and pendingData() are the one judgement GET /v1/me/reverify and the two
// submissions (reverify.ts) answer from too, so the operations never disagree with that page.
//
// withdraw.dormant_reverify_days takes no part: the switch only decides whether new flags are set,
// a flag already on the account stays in effect (D10-580 ⑤). A gate reads and writes nothing else:
// it counts no failure and reserves no place. Reads run on the caller's handle, so a caller holding
// a transaction borrows no second connection and sees its own locks.
//
// A restricted session (BR-ID-01 deletion_only, the BR-ID-31 ban whitelist) offers no self-service:
// createDeletionReverifyGate answers manual there, and only the application for deletion can be
// reached from one. Banned here is what stage ⑤ refuses as banned: banned, or appealing unless the
// processing account appeal is over a freeze (no such appeal: fail closed, as stage ⑤).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { DB } from '@couli/db';
import { accountingDate } from '@couli/domain';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, TokenPrincipal } from '../../platform/index.ts';
import { createAppealPrevStateReader, createRiskStateBatchReader } from '../../risk/index.ts';
import {
  MANUAL_REQUIREMENT,
  failuresOn,
  reverifyRequirement,
  trustedIdentitiesOf,
  type ReverifyRequirement,
  type TrustedIdentities,
} from '../domain/reverify.ts';
import { deviceHashOf } from '../infra/login-accounts.ts';
import {
  isReverifiedDevice,
  readReverifyAccount,
  type ReverifySubject,
} from '../infra/reverify-store.ts';

/** 10010's data (error-codes.yaml): providers only for oauth, fail_limit unless manual. */
export interface ReverifyPendingData {
  readonly method: ReverifyRequirement['method'];
  readonly providers?: ReverifyRequirement['providers'];
  readonly fail_limit?: number;
}

export interface ReverifyRefusal {
  readonly code: 10010;
  readonly data: ReverifyPendingData;
}

/** The account on this device: settled when no flag stands, or the device is re-verified. */
export type ReverifyStanding =
  | { readonly settled: true }
  | {
      readonly settled: false;
      readonly deviceHash: string;
      readonly trusted: TrustedIdentities;
      readonly requirement: ReverifyRequirement;
    };

export function pendingData(requirement: ReverifyRequirement): ReverifyPendingData {
  if (requirement.method === 'manual') return { method: 'manual' };
  return {
    method: requirement.method,
    ...(requirement.method === 'oauth' ? { providers: requirement.providers } : {}),
    fail_limit: requirement.fail_limit,
  };
}

/** `today` is the +08:00 day of the failure count. A flagged account needs its device row. */
export async function reverifyStanding(
  handle: Kysely<DB>,
  subject: ReverifySubject,
  deviceId: string,
  today: string,
): Promise<ReverifyStanding> {
  const app = handle.withSchema('app');
  const account = await readReverifyAccount(app, subject);
  if (account === undefined) throw new Error('identity: reverify without a user row');
  if (account.flagged_at === null) return { settled: true };
  const deviceHash = await deviceHashOf(app, subject.app_id, deviceId);
  if (deviceHash === undefined) throw new Error('identity: reverify without a device row');
  if (await isReverifiedDevice(app, subject, deviceHash)) return { settled: true };
  const trusted = trustedIdentitiesOf(account.trusted);
  return {
    settled: false,
    deviceHash,
    trusted,
    requirement: reverifyRequirement(
      trusted,
      failuresOn(today, account.fail_day, account.fail_count),
    ),
  };
}

export interface ReverifyActor {
  readonly appId: string;
  readonly userId: string;
  readonly deviceId: string;
}

export interface ReverifyGate {
  /** null: nothing pending for this account on this device. */
  check(handle: Kysely<DB>, actor: ReverifyActor): Promise<ReverifyRefusal | null>;
}

export function createReverifyGate(options: { readonly clock: Clock }): ReverifyGate {
  const { clock } = options;
  return Object.freeze({
    async check(handle: Kysely<DB>, actor: ReverifyActor): Promise<ReverifyRefusal | null> {
      const standing = await reverifyStanding(
        handle,
        { app_id: actor.appId, user_id: actor.userId },
        actor.deviceId,
        accountingDate(clock.now()),
      );
      if (standing.settled) return null;
      return { code: 10010, data: pendingData(standing.requirement) };
    },
  });
}

/** The session an application for deletion comes from. */
export interface DeletionReverifySession {
  readonly deviceId: string;
  readonly scope: TokenPrincipal['scp'];
}

export interface DeletionReverifyGate {
  check(
    trx: Transaction<DB>,
    subject: { readonly appId: string; readonly userId: string },
    session: DeletionReverifySession,
  ): Promise<ReverifyRefusal | null>;
}

/** The gate of POST /v1/me/deletion: the same judgement, manual in a restricted session. */
export function createDeletionReverifyGate(options: {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}): DeletionReverifyGate {
  const gate = createReverifyGate({ clock: options.clock });
  const risk = createRiskStateBatchReader({ db: options.db });
  const appeal = createAppealPrevStateReader();

  async function banned(
    trx: Transaction<DB>,
    subject: { readonly appId: string; readonly userId: string },
  ): Promise<boolean> {
    const rows = await risk.read(trx, { appId: subject.appId, userIds: [subject.userId] });
    const state = rows.get(subject.userId)?.state;
    if (state === 'banned') return true;
    if (state !== 'appealing') return false;
    return (await appeal.read(trx, subject)) !== 'frozen';
  }

  return Object.freeze({
    async check(
      trx: Transaction<DB>,
      subject: { readonly appId: string; readonly userId: string },
      session: DeletionReverifySession,
    ): Promise<ReverifyRefusal | null> {
      const refusal = await gate.check(trx, { ...subject, deviceId: session.deviceId });
      if (refusal === null || refusal.data.method === 'manual') return refusal;
      const restricted = session.scope !== 'full' || (await banned(trx, subject));
      return restricted ? { code: 10010, data: pendingData(MANUAL_REQUIREMENT) } : refusal;
    },
  });
}
