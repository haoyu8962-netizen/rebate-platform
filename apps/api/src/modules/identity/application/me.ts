// GET /v1/me (04 §6.1; task B1-02z): the current user's view, read-only, by the token's app_id and
// uid only. Cross-module ports are assembled by app.module.
//
// - identity_level from the database (BR-ID-01): phone when users.phone_hmac is set, else member;
//   realname when the phone is bound and app.realname is verified; realname_status from the
//   realname table (none without a row, BR-ID-25; read through the stage ⑨ reader).
// - invite_code null when inviter_unavailable(self) (BR-INV-18, BR-INV-02; task B1-11k): the
//   domain's inviterUnavailable over the current facts — risk_state read fresh, the deletion stage
//   from this module's deletion-stage reader (B1-15c: the later of the deletion request and
//   users.status, so cooling, processing / deleting and done all hide the code), phone_hmac, and a
//   verified real name under 18 at the Clock's instant (BR-INV-19; unverified counts as adult).
//   inviter_bound = parent_id set.
// - invite_backfill per BR-INV-07 (a)(b)(c) and growth.invite_bind.enabled (BR-INV-21); the
//   deadline is the domain's inviteBackfillDeadline, open while withinBackfill (now < deadline);
//   deadline_at is that deadline when eligible, else null.
// - balance through MeBalancePort (ledger, B2; zero default assembled by app.module).
// - union_bindings taobao then pdd through MeUnionBindingsPort (linking's binding projection).
// - need_reconsent per BR-ID-12: the user-level current state of privacy or agreement is not
//   accepted, or its version is below legal.privacy.version / legal.agreement.version.
// - risk: risk's readRiskState snapshot. prev_risk_state (CT-26e, 04 §6.1, BR-ID-36 细则) only
//   when the state is appealing: the prev_risk_state of the caller's processing account appeal
//   (at most one, unique index appeals_processing_target_key), read-only from app.appeals (risk
//   is its single writer; never written here); null otherwise, and null when there is no
//   processing account appeal (a value outside frozen / banned is a broken row and also null).
import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { RiskStateService } from '../../risk/index.ts';
import type { SmsConfigReader } from './sms-codes.ts';
import {
  inviteBackfillDeadline,
  inviterUnavailable,
  isAtLeastAge,
  withinBackfill,
} from '@couli/domain';
import { currentStates } from '../domain/login.ts';
import { DEFAULT_AVATAR } from '../domain/registration.ts';
import { userConsentRecords } from '../infra/consent-records.ts';
import type { RealnameStatusReader } from './identity-level.ts';
import type { RealnameReader } from '../infra/realname-reader.ts';
import { meUser, hasDirectChildren } from '../infra/me-reads.ts';
import { createDeletionStageReader } from '../ports/deletion-stage.ts';
import type { InviteBackfillActivityPort, MeSubject } from '../ports/invite-backfill-activity.ts';
export type { InviteBackfillActivityPort, MeSubject } from '../ports/invite-backfill-activity.ts';

export type Me = components['schemas']['Me'];
export type MeBalance = components['schemas']['MeBalance'];
export type MeUnionBindingStatus = components['schemas']['UnionBindingState']['status'];
export type MeUnionPlatform = 'taobao' | 'pdd';

/** The single-balance summary (ADD-06); ledger owns it. */
export interface MeBalancePort {
  balanceOf(subject: MeSubject): Promise<MeBalance>;
}

/** linking's read-only binding projection (BR-ID-17 细则「授权管理页」); no row → unbound. */
export interface MeUnionBindingsPort {
  statusOf(subject: MeSubject, platform: MeUnionPlatform): Promise<MeUnionBindingStatus>;
}

export interface MeServiceOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly config: SmsConfigReader;
  readonly logger: Pick<RootLogger, 'warn'>;
  readonly risk: Pick<RiskStateService, 'readRiskState'>;
  readonly balance: MeBalancePort;
  readonly unionBindings: MeUnionBindingsPort;
  readonly activity: InviteBackfillActivityPort;
  /**
   * app.realname status, uncached (the stage ⑨ reader), plus the verified birth date for the age
   * check (B1-13d's reader). The name and birth date never reach the response or the logs.
   */
  readonly realname: RealnameStatusReader & Pick<RealnameReader, 'verified'>;
}

export interface MeService {
  read(subject: MeSubject): Promise<Me>;
}

/** BR-INV-19: a verified user under this age cannot invite. */
const INVITER_MIN_AGE = 18;

/** Ports assembled outside identity; risk uses the same instance as the request guard. */
export type MeReadPorts = Pick<MeServiceOptions, 'risk' | 'balance' | 'unionBindings' | 'activity'>;

/** The penalty before the caller's processing account appeal (read-only; risk writes app.appeals). */
export async function accountAppealPrevState(
  db: Kysely<DB>,
  subject: MeSubject,
): Promise<'frozen' | 'banned' | null> {
  const row = await db
    .withSchema('app')
    .selectFrom('appeals')
    .select('prev_risk_state')
    .where('app_id', '=', subject.appId)
    .where('user_id', '=', subject.userId)
    .where('target_type', '=', 'account')
    .where('target_id', '=', subject.userId)
    .where('status', '=', 'processing')
    .limit(1)
    .executeTakeFirst();
  const value = row?.prev_risk_state ?? null;
  return value === 'frozen' || value === 'banned' ? value : null;
}

function configuredNumber(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`identity: invalid ${key}`);
  }
  return value;
}

export function createMeService(options: MeServiceOptions): MeService {
  const { clock, config, logger, risk, balance, unionBindings, activity, realname } = options;
  const db = options.db.withSchema('app');
  // Same module: the reader runs on options.db (GET /v1/me opens no transaction).
  const deletionStages = createDeletionStageReader({ db: options.db });
  return {
    async read(subject) {
      const user = await meUser(db, subject);
      let avatarUrl = user.avatar;
      if (avatarUrl === DEFAULT_AVATAR) {
        const configuredAvatar = await config.configValue(subject.appId, 'me.default_avatar_url');
        const value = configuredAvatar?.value;
        if (
          typeof value !== 'string' ||
          !/^https:\/\//i.test(value) ||
          !URL.canParse(value) ||
          new URL(value).hostname === ''
        ) {
          // Do not log the configured value or any user fields, including on invalid URLs.
          logger.warn({ config_key: 'me.default_avatar_url' }, 'identity_default_avatar_invalid');
          throw new Error('identity: invalid me.default_avatar_url');
        }
        avatarUrl = value;
      }
      const [hoursConfig, bindConfig, privacyConfig, agreementConfig] = await Promise.all(
        [
          'invite.backfill_hours',
          'growth.invite_bind.enabled',
          'legal.privacy.version',
          'legal.agreement.version',
        ].map((key) => config.configValue(subject.appId, key)),
      );
      const hours =
        hoursConfig == null ? 168 : configuredNumber(hoursConfig.value, 'invite.backfill_hours');
      const bindValue = bindConfig?.value ?? true;
      if (bindValue !== true && bindValue !== false && bindValue !== 'on' && bindValue !== 'off') {
        throw new Error('identity: invalid growth.invite_bind.enabled');
      }
      const deadline = inviteBackfillDeadline(user.created_at, hours);
      const now = clock.now();
      const [snapshot, records, summary, taobao, pdd, realnameStatus, stages] = await Promise.all([
        // Fresh: the invitation view follows the risk state at the call (BR-INV-02), never a cache.
        risk.readRiskState({ app_id: subject.appId, user_id: subject.userId }, { fresh: true }),
        userConsentRecords(db, subject.appId, subject.userId),
        balance.balanceOf(subject),
        unionBindings.statusOf(subject, 'taobao'),
        unionBindings.statusOf(subject, 'pdd'),
        realname.read(db, { app_id: subject.appId, user_id: subject.userId }),
        deletionStages.read(options.db, { appId: subject.appId, userIds: [subject.userId] }),
      ]);
      let eligible =
        user.parent_id === null &&
        !user.self_bind_used &&
        withinBackfill(now, deadline) &&
        bindValue !== false &&
        bindValue !== 'off';
      if (eligible) {
        const [orders, claims, children] = await Promise.all([
          activity.orderCount(subject),
          activity.hasClaims(subject),
          hasDirectChildren(db, subject),
        ]);
        eligible = orders === 0 && !claims && !children;
      }
      const phoneBound = user.phone_hmac !== null;
      const verifiedRealname =
        realnameStatus === 'verified'
          ? await realname.verified(db, { app_id: subject.appId, user_id: subject.userId })
          : null;
      const stage = stages.get(subject.userId) ?? 'none';
      const deletionStatus = stage === 'none' ? null : stage;
      const prevRiskState =
        snapshot.state === 'appealing' ? await accountAppealPrevState(db, subject) : null;
      const cannotInvite = inviterUnavailable({
        risk_state: snapshot.state,
        deletion_status: deletionStatus,
        phone_bound: phoneBound,
        verified_minor:
          verifiedRealname !== null &&
          !isAtLeastAge(verifiedRealname.birth_date, INVITER_MIN_AGE, now),
      });
      const current = currentStates(records);
      const needReconsent = (
        [
          ['privacy', privacyConfig],
          ['agreement', agreementConfig],
        ] as const
      ).some(([type, item]) => {
        const version = item == null ? null : configuredNumber(item.value, `legal.${type}.version`);
        const state = current.get(type);
        return state?.accepted !== true || (version !== null && state.version < version);
      });
      return {
        user_id: subject.userId,
        nickname: user.nickname,
        avatar_url: avatarUrl,
        invite_code: cannotInvite ? null : user.invite_code,
        inviter_bound: user.parent_id !== null,
        invite_backfill: { eligible, deadline_at: eligible ? deadline.toISOString() : null },
        identity_level: !phoneBound
          ? 'member'
          : realnameStatus === 'verified'
            ? 'realname'
            : 'phone',
        phone_bound: phoneBound,
        balance: summary,
        union_bindings: [
          { platform: 'taobao', status: taobao },
          { platform: 'pdd', status: pdd },
        ],
        realname_status: realnameStatus,
        need_reconsent: needReconsent,
        risk: {
          state: snapshot.state,
          reason_category: snapshot.reason_category,
          frozen_until: snapshot.frozen_until?.toISOString() ?? null,
          prev_risk_state: prevRiskState,
        },
      };
    },
  };
}
