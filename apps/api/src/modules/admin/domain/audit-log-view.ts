// Read-side view of an audit record (B1-34a; contract adminListAuditLogs / adminGetAuditLog,
// CT-24c; 04 §3.2 audit_logs, §11.1 audit.view_all). audit_logs stores only `action` and a free
// `target` string; `target_type`, `target_id` and `permission` are derived here, on read, from one
// table keyed by the action (the target's prefix confirms the object type). What cannot be derived
// is null and never matches a filter on that field (contract).
//
// Pure functions and data: no Nest, no data access. The SQL side (../infra/audit-log-store.ts)
// turns the `*Match` plans below into conditions, so a filter matches exactly the rows whose
// derived value equals it; both are built from the same RULES table.
//
// Permission rules:
//   - fixed: the point the writing module guards the action with (null where the action is not
//     guarded by exactly one point: commission.rule.* and union.* registration, kill switches
//     whose change several points allow, sign-in events);
//   - after: one string field of the stored `after` object picks the point (user_risk_state_change
//     after.action, user_pii_reveal after.field, export_unmasked after.resource);
//   - config key: config_item_change / _rollback read the content module's configuration registry
//     (key → its one point) handed in by the caller; an unregistered key is null (no prefix
//     guessing).
// Unknown actions derive nothing (all three null).
//
// System rows (D10-552): order_auto_hold has no account and no permission point; the Chinese name
// of a system identity comes from SYSTEM_ACTOR_NAMES, which mirrors enum audit_system_actor (the
// generated enum carries the values only).
import { admin_permission, type AdminPermission, type AuditSystemActor } from '@couli/contracts-ts';

/** Contract bounds of the derived fields (AdminAuditLogListItem). */
export const AUDIT_TARGET_TYPE_MAX = 64;
export const AUDIT_TARGET_ID_MAX = 128;
/** The admin point that widens the search to every account's records (04 §11.1). */
export const AUDIT_VIEW_ALL = 'audit.view_all';
/** The audit action of the risk engine's automatic hold (BR-FUND-06), target `orders:<order_id>`. */
export const ORDER_AUTO_HOLD_ACTION = 'order_auto_hold';

/** Chinese names of contracts/enums/admin.yaml audit_system_actor; a new value must be added here. */
const SYSTEM_ACTOR_NAMES: Readonly<Record<AuditSystemActor, string>> = Object.freeze({
  'system:risk': '系统（风控）',
});

/** The enum's Chinese name of a stored system_actor; null for a value the enum does not have. */
export function systemActorName(systemActor: string): string | null {
  return Object.hasOwn(SYSTEM_ACTOR_NAMES, systemActor)
    ? SYSTEM_ACTOR_NAMES[systemActor as AuditSystemActor]
    : null;
}

/** Configuration key → the one admin point that guards changing it (content's registry). */
export type ConfigPermissions = ReadonlyMap<string, string>;

type PermissionRule =
  | { readonly kind: 'fixed'; readonly permission: AdminPermission | null }
  | {
      readonly kind: 'after';
      readonly field: string;
      readonly values: Readonly<Record<string, AdminPermission>>;
    }
  | { readonly kind: 'configKey' };

interface ActionRule {
  readonly action: string;
  readonly targetType: string;
  /** Stored target is `<prefix><id>`; null: the stored target is the id itself. */
  readonly prefix: string | null;
  readonly permission: PermissionRule;
}

const fixed = (permission: AdminPermission | null): PermissionRule => ({
  kind: 'fixed',
  permission,
});
const NONE = fixed(null);

function rules(
  actions: readonly string[],
  targetType: string,
  prefix: string | null,
  permission: PermissionRule,
): ActionRule[] {
  return actions.map((action) => ({ action, targetType, prefix, permission }));
}

const RULES: readonly ActionRule[] = Object.freeze([
  // admin (admin-login.ts ADMIN_AUTH_AUDIT, bootstrap.ts): the account itself, no point.
  ...rules(
    [
      'admin.login',
      'admin.login_locked',
      'admin.initial_password_changed',
      'admin.totp_bound',
      'admin.logout',
      'admin.bootstrap_super',
    ],
    'admin_user',
    'admin_users:',
    NONE,
  ),
  // risk (admin-risk-state.ts): target user_id; after.action is ban / unban / freeze / unfreeze.
  ...rules(['user_risk_state_change'], 'user', null, {
    kind: 'after',
    field: 'action',
    values: { ban: 'risk.ban', unban: 'risk.ban', freeze: 'risk.freeze', unfreeze: 'risk.freeze' },
  }),
  // identity (admin-user-reveal.ts): target user_id; after.field names the revealed field.
  ...rules(['user_pii_reveal'], 'user', null, {
    kind: 'after',
    field: 'field',
    values: { phone: 'pii.reveal_phone' },
  }),
  // linking (admin-union-bindings.ts): target user_id; reset / disable / enable.
  ...rules(['union_binding_reset'], 'user', null, fixed('union.binding_reset')),
  ...rules(
    ['union_binding_disable', 'union_binding_enable'],
    'user',
    null,
    fixed('union.binding_disable'),
  ),
  // content (config-item-admin.ts, kill-switch-admin.ts): target is the key.
  ...rules(['config_item_change', 'config_item_rollback'], 'config_item', null, {
    kind: 'configKey',
  }),
  ...rules(['kill_switch_change'], 'switch', null, NONE),
  ...rules(['page_preview_token_issue'], 'page', 'pages:', fixed('content.page')),
  // commission (rule-publication.ts): target rule_version_id / trial_id.
  ...rules(
    ['commission.rule.draft', 'commission.rule.publish', 'commission.rule.revoke'],
    'commission_rule_version',
    null,
    NONE,
  ),
  ...rules(['commission.rule.trial'], 'commission_rule_trial', null, NONE),
  // union (pids/service.ts).
  ...rules(
    ['union.account.register', 'union.account.sync_start'],
    'union_account',
    'union_accounts:',
    NONE,
  ),
  ...rules(
    [
      'union.pid.register',
      'union.pid.confirm_hjy_ignore',
      'union.pid.activate',
      'union.pid.retire',
    ],
    'union_pid',
    'union_pids:',
    NONE,
  ),
  // settlement's rebate port through infra/system-audit.ts (B1-34p): a system row, no point.
  ...rules([ORDER_AUTO_HOLD_ACTION], 'order', 'orders:', NONE),
  // Registered ahead of their writers (B1-10k claim review; B1-34e / B1-34f exports).
  ...rules(
    ['claim_item_approve', 'claim_item_reject'],
    'claim_item',
    'claim_items:',
    fixed('order.claim'),
  ),
  ...rules(
    ['export_create', 'export_download', 'export_retry', 'export_cancel', 'export_generated'],
    'export_task',
    'export_tasks:',
    fixed('export'),
  ),
  ...rules(['export_unmasked'], 'export_task', 'export_tasks:', {
    kind: 'after',
    field: 'resource',
    values: { users: 'pii.reveal_phone', tax_withdrawals: 'tax.export_full' },
  }),
]);

const BY_ACTION: ReadonlyMap<string, ActionRule> = new Map(
  RULES.map((rule) => [rule.action, rule]),
);
const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(admin_permission);

/** The derived columns of one stored record. */
export interface AuditDerived {
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly permission: AdminPermission | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Length in Unicode code points, as PG char_length and the contract's maxLength count. */
function codePoints(text: string): number {
  return Array.from(text).length;
}

function idOf(rule: ActionRule, target: string | null): string | null {
  if (target === null) return null;
  let id = target;
  if (rule.prefix !== null) {
    if (!target.startsWith(rule.prefix)) return null;
    id = target.slice(rule.prefix.length);
  }
  const length = codePoints(id);
  return length >= 1 && length <= AUDIT_TARGET_ID_MAX ? id : null;
}

function permissionOf(
  rule: ActionRule,
  target: string | null,
  after: unknown,
  config: ConfigPermissions,
): AdminPermission | null {
  const spec = rule.permission;
  switch (spec.kind) {
    case 'fixed':
      return spec.permission;
    case 'after': {
      if (!isPlainObject(after)) return null;
      const value = after[spec.field];
      if (typeof value !== 'string' || !Object.hasOwn(spec.values, value)) return null;
      return spec.values[value]!;
    }
    case 'configKey': {
      const permission = target === null ? undefined : config.get(target);
      return permission !== undefined && KNOWN_PERMISSIONS.has(permission)
        ? (permission as AdminPermission)
        : null;
    }
  }
}

/** Derives target_type / target_id / permission of a stored record; null where it cannot. */
export function deriveAudit(
  record: { readonly action: string; readonly target: string | null; readonly after: unknown },
  config: ConfigPermissions,
): AuditDerived {
  const rule = BY_ACTION.get(record.action);
  if (rule === undefined) return { targetType: null, targetId: null, permission: null };
  const targetId = idOf(rule, record.target);
  return {
    targetType: targetId === null ? null : rule.targetType,
    targetId,
    permission: permissionOf(rule, record.target, record.after, config),
  };
}

// ---- Filter plans: each is an OR of conditions; an empty list matches no row. ----

/**
 * One SQL condition over (action, target, after):
 *   - target: action in `actions` and the stored target is the id under `prefix` (null: bare),
 *     with the id 1–AUDIT_TARGET_ID_MAX characters long (the same bounds as idOf);
 *   - targetEquals: action in `actions` and target = `target`;
 *   - actions: action in `actions`;
 *   - afterField: action in `actions`, after is an object whose `field` is a string in `values`;
 *   - targetIn: action in `actions` and target in `targets`.
 */
export type AuditCondition =
  | { readonly kind: 'target'; readonly actions: readonly string[]; readonly prefix: string | null }
  | { readonly kind: 'targetEquals'; readonly actions: readonly string[]; readonly target: string }
  | { readonly kind: 'actions'; readonly actions: readonly string[] }
  | {
      readonly kind: 'afterField';
      readonly actions: readonly string[];
      readonly field: string;
      readonly values: readonly string[];
    }
  | {
      readonly kind: 'targetIn';
      readonly actions: readonly string[];
      readonly targets: readonly string[];
    };

function grouped<K>(
  entries: readonly ActionRule[],
  keyOf: (rule: ActionRule) => K,
): Map<K, string[]> {
  const groups = new Map<K, string[]>();
  for (const rule of entries) {
    const key = keyOf(rule);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [rule.action]);
    else list.push(rule.action);
  }
  return groups;
}

/** Rows whose derived target_type equals `targetType` (exact). */
export function targetTypeMatch(targetType: string): AuditCondition[] {
  const matching = RULES.filter((rule) => rule.targetType === targetType);
  return [...grouped(matching, (rule) => rule.prefix)].map(([prefix, actions]) => ({
    kind: 'target' as const,
    actions,
    prefix,
  }));
}

/** Rows whose derived target_id equals `targetId` (exact; 1–128 characters by the contract). */
export function targetIdMatch(targetId: string): AuditCondition[] {
  const length = codePoints(targetId);
  if (length < 1 || length > AUDIT_TARGET_ID_MAX) return [];
  return [...grouped(RULES, (rule) => rule.prefix)].map(([prefix, actions]) => ({
    kind: 'targetEquals' as const,
    actions,
    target: `${prefix ?? ''}${targetId}`,
  }));
}

/** Rows whose derived permission equals `permission`; an unknown point matches nothing. */
export function permissionMatch(permission: string, config: ConfigPermissions): AuditCondition[] {
  if (!KNOWN_PERMISSIONS.has(permission)) return [];
  const conditions: AuditCondition[] = [];
  const fixedActions = RULES.filter(
    (rule) => rule.permission.kind === 'fixed' && rule.permission.permission === permission,
  ).map((rule) => rule.action);
  if (fixedActions.length > 0) conditions.push({ kind: 'actions', actions: fixedActions });
  for (const rule of RULES) {
    const spec = rule.permission;
    if (spec.kind !== 'after') continue;
    const values = Object.keys(spec.values).filter((value) => spec.values[value] === permission);
    if (values.length > 0) {
      conditions.push({ kind: 'afterField', actions: [rule.action], field: spec.field, values });
    }
  }
  const configActions = RULES.filter((rule) => rule.permission.kind === 'configKey').map(
    (rule) => rule.action,
  );
  const keys = [...config].filter(([, value]) => value === permission).map(([key]) => key);
  if (configActions.length > 0 && keys.length > 0) {
    conditions.push({ kind: 'targetIn', actions: configActions, targets: keys });
  }
  return conditions;
}
