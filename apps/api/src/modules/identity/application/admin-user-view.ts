import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Selectable } from 'kysely';
import type { AdminActor } from '../../platform/index.ts';
import { maskPhone } from '../domain/mask-phone.ts';

/** Internal read result; decrypted phone must never be returned as a user view. */
export interface AdminUserViewSource {
  readonly user: Readonly<
    Pick<
      Selectable<DB['users']>,
      | 'id'
      | 'nickname'
      | 'level'
      | 'invite_code'
      | 'parent_id'
      | 'register_method'
      | 'registered_channel'
      | 'created_at'
    >
  >;
  readonly phone: string | null;
  readonly risk: Readonly<Schema<'AdminUserRiskState'>>;
  readonly unionBindings: readonly Readonly<Schema<'AdminUserUnionBinding'>>[];
}

/** Read capability for the later list/detail routes; appId comes from the admin actor. */
export interface AdminUserViewReader {
  read(input: {
    readonly appId: string;
    readonly userId: string;
  }): Promise<AdminUserViewSource | null>;
}

/** specs/permissions.yaml: holding any one of these shows risk.reason. */
const RISK_REASON_POINTS = ['risk.freeze', 'risk.ban', 'risk.blocklist', 'risk.appeal'] as const;

/**
 * adminGetUser / adminLookupUser (D10-1048 ①; BR-TEXT-08 internal note): risk.reason is null for an
 * account holding none of the risk points; every other field, union_bindings[].reason included, is
 * untouched. Points that could not be read count as none. Only narrows the answer, never lets in.
 */
export function blankAdminUserDetail(
  detail: Schema<'AdminUserDetail'>,
  access: Pick<AdminActor, 'isSuper' | 'permissions'>,
): Schema<'AdminUserDetail'> {
  if (access.isSuper || RISK_REASON_POINTS.some((point) => access.permissions?.includes(point))) {
    return detail;
  }
  return { ...detail, risk: { ...detail.risk, reason: null } };
}

/** Both permitted view shapes whitelist fields; neither permits plaintext, even for a super. */
export function projectAdminUser(
  source: AdminUserViewSource,
  view: 'list',
): Schema<'AdminUserListItem'>;
export function projectAdminUser(
  source: AdminUserViewSource,
  view: 'detail',
): Schema<'AdminUserDetail'>;
export function projectAdminUser(
  source: AdminUserViewSource,
  view: 'list' | 'detail',
): Schema<'AdminUserListItem'> | Schema<'AdminUserDetail'> {
  const { user, risk } = source;
  // Fields are named one by one at every level: nothing of the source row is spread, so a
  // column added to the read (a cipher, relation_id, a real name) never reaches the console.
  const phoneMasked = source.phone === null ? null : maskPhone(source.phone);
  const level = user.level as Schema<'AdminUserLevel'>;
  const createdAt = user.created_at.toISOString();
  if (view === 'list') {
    return {
      user_id: user.id,
      nickname: user.nickname,
      phone_masked: phoneMasked,
      level,
      risk_state: risk.state,
      created_at: createdAt,
    };
  }
  return {
    user_id: user.id,
    nickname: user.nickname,
    phone_masked: phoneMasked,
    invite_code: user.invite_code,
    inviter_user_id: user.parent_id,
    level,
    register_method: user.register_method,
    registered_channel: user.registered_channel,
    created_at: createdAt,
    risk: {
      state: risk.state,
      reason_category: risk.reason_category,
      reason: risk.reason,
      frozen_until: risk.frozen_until,
      changed_by: risk.changed_by,
      changed_at: risk.changed_at,
      row_version: risk.row_version,
    },
    union_bindings: source.unionBindings.map((binding) => ({
      platform: binding.platform,
      status: binding.status,
      blocked_reason: binding.blocked_reason,
      bound_at: binding.bound_at,
      released_at: binding.released_at,
      cooldown_until: binding.cooldown_until,
      reason: binding.reason,
      row_version: binding.row_version,
    })),
  };
}
