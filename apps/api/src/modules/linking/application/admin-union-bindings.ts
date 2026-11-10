// F1-07c: the console's union authorization management (BR-ID-20; OPS-11; 04 §6.6 / §11.2):
// POST /admin/v1/users/{user_id}/union-bindings/{platform}/reset | disable | enable.
// The controller has checked the admin account, the permission point and its totp step-up
// (platform's AdminOperationGuard); the route schema has checked reason (1–200) and
// expected_row_version (a non-negative integer). Here, in one transaction:
// - platform: only those with user authorization (taobao, pdd); another (jd) → 20001 [platform].
//   reset is Taobao's only (BR-ID-20, owner 2026-10-18: other unions have no re-authorization and
//   no way to undo a filing): reset of any other platform → 20001 [platform], before anything else;
// - the user lock (binding-lock.ts, the same one the ban / unban ports and the user's own
//   authorization take) on (console app, user_id): no such user in this app → 20001 [user_id];
// - after the lock, the user's risk state and bindings of the platform. The current binding is the
//   unreleased one (else a stored `unbound` row); none (only released rows, or no row) → 30154;
// - enable of a banned user → 30154 whatever the binding (ruling ①; a ban comes back by unban);
// - expected_row_version against the current binding's row_version → 20902 resource
//   union_binding;
// - the state rule: reset and disable accept active / invalid only, enable blocked(admin_disable)
//   only; anything else → 30154 (no data). reset → released (released_at = now, cooldown_until =
//   now + bind.rebind_cooldown_days, default 30); disable → blocked(admin_disable); enable → on
//   Taobao invalid (the user authorizes again), on another union active at once, written in two
//   steps blocked → invalid → active on the same transaction (binding-risk.ts restoreSteps: only
//   existing edges). canTransitionBinding (the generated union-binding transition(), CT-10a: reset
//   U9, disable U8, enable U7 then on another union U4) judges every step, each written by a
//   compare-and-set on the row_version read (or just written); an enable that ends active
//   resolves the user's 30151 rows of the platform as any activation does; reason is stored on
//   the row;
// - one audit row (union_binding_<action>, before / after status and the reason) on the same
//   transaction, through admin's audit writer bound to it.
// After the commit a reset clears the user's cached converted links (BR-AI-04 细则「转链缓存」);
// a cache failure is logged, the reset stands (the open answers 30101 from the binding before any
// cached jump is read).
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Selectable } from 'kysely';
import type { AuditPort, Clock, RootLogger } from '../../platform/index.ts';
import { canTransitionBinding } from '../domain/binding-status-transitions.ts';
import { resolveBindingConflictsOnActive } from '../infra/binding-conflicts.ts';
import type { LinkingConfigReader } from '../ports.ts';
import { lockBindingUser, userBannedOn } from './binding-lock.ts';
import { restoreSteps } from './binding-risk.ts';
import { UNRELEASED } from './union-auth-reads.ts';

export type AdminBindingAction = 'reset' | 'disable' | 'enable';
export type AdminUnionBinding = Schema<'AdminUserUnionBinding'>;
type BindingRow = Selectable<DB['union_bindings']>;

/** Platforms with user authorization (BR-ID-17); the others have no binding. */
const AUTHORIZED_PLATFORMS: ReadonlySet<string> = new Set(['taobao', 'pdd']);
/** BR-ID-20: 重置授权 (unfiling in the console) exists for Taobao only. */
const RESETTABLE_PLATFORMS: ReadonlySet<string> = new Set(['taobao']);
const COOLDOWN_KEY = 'bind.rebind_cooldown_days';
/** BR-ID-20 / §8 ADD-01 default when the app has not configured it. */
const DEFAULT_COOLDOWN_DAYS = 30;
const MAX_COOLDOWN_DAYS = 3650;
const DAY_MS = 86_400_000;

export class AdminUnionBindingFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`linking: invalid ${fields.join(', ')}`);
    this.name = 'AdminUnionBindingFieldsError';
    this.fields = fields;
  }
}

/** 20902 data.resource=union_binding. */
export class AdminUnionBindingConflictError extends Error {
  constructor() {
    super('linking: union binding version conflict');
    this.name = 'AdminUnionBindingConflictError';
  }
}

/** 30154: the binding's current status does not allow the action. */
export class AdminUnionBindingNotAllowedError extends Error {
  constructor() {
    super('linking: union binding status does not allow the action');
    this.name = 'AdminUnionBindingNotAllowedError';
  }
}

export interface AdminUnionBindingCommand {
  readonly action: AdminBindingAction;
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
  readonly userId: string;
  readonly platform: string;
  readonly reason: string;
  readonly expectedRowVersion: number;
}

export interface AdminUnionBindingsStore {
  /** Runs `work` in one transaction with the audit port and config reader bound to it. */
  transaction<T>(
    work: (trx: Kysely<DB>, audit: AuditPort, config: LinkingConfigReader) => Promise<T>,
  ): Promise<T>;
}

export interface AdminUnionBindingsOptions {
  readonly store: AdminUnionBindingsStore;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'warn'>;
  /** Clears the user's cached converted links; absent (no Redis) nothing is cached. */
  readonly purgeUserLinks?: (appId: string, userId: string) => Promise<void>;
}

interface Target {
  readonly status: 'released' | 'blocked' | 'invalid' | 'active';
  readonly blockedReason: 'admin_disable' | null;
}

function allowed(action: AdminBindingAction, row: BindingRow): boolean {
  if (action === 'enable')
    return row.status === 'blocked' && row.blocked_reason === 'admin_disable';
  return row.status === 'active' || row.status === 'invalid';
}

/** The statuses written in order; enable on a union other than Taobao goes through invalid. */
function stepsOf(action: AdminBindingAction, platform: string): readonly Target[] {
  if (action === 'reset') return [{ status: 'released', blockedReason: null }];
  if (action === 'disable') return [{ status: 'blocked', blockedReason: 'admin_disable' }];
  return restoreSteps(platform).map((status) => ({ status, blockedReason: null }));
}

function cooldownDays(item: { readonly value: unknown } | null): number {
  if (item === null) return DEFAULT_COOLDOWN_DAYS;
  const value = item.value;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_COOLDOWN_DAYS
  ) {
    // A configuration fault is a server fault (50001): never guessed.
    throw new Error(`linking: ${COOLDOWN_KEY} is not a whole number of days`);
  }
  return value;
}

/** `instant` plus `ms` as a new Date (the Clock's instant is never modified). */
function later(instant: Date, ms: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + ms);
  return result;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function adminBindingView(row: BindingRow): AdminUnionBinding {
  return {
    platform: row.platform as AdminUnionBinding['platform'],
    status: row.status as AdminUnionBinding['status'],
    blocked_reason: row.blocked_reason as AdminUnionBinding['blocked_reason'],
    bound_at: iso(row.bound_at),
    released_at: iso(row.released_at),
    cooldown_until: iso(row.cooldown_until),
    reason: row.reason,
    row_version: row.row_version,
  };
}

export class AdminUnionBindings {
  readonly #store: AdminUnionBindingsStore;
  readonly #clock: Clock;
  readonly #logger: Pick<RootLogger, 'warn'>;
  readonly #purge: ((appId: string, userId: string) => Promise<void>) | undefined;

  constructor(options: AdminUnionBindingsOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#purge = options.purgeUserLinks;
  }

  async apply(command: AdminUnionBindingCommand): Promise<AdminUnionBinding> {
    const { action, appId, userId, platform } = command;
    if (
      !AUTHORIZED_PLATFORMS.has(platform) ||
      (action === 'reset' && !RESETTABLE_PLATFORMS.has(platform))
    ) {
      throw new AdminUnionBindingFieldsError(['platform']);
    }
    const row = await this.#store.transaction(async (trx, audit, config) => {
      if (!(await lockBindingUser(trx, appId, userId))) {
        throw new AdminUnionBindingFieldsError(['user_id']);
      }
      const banned = await userBannedOn(trx, appId, userId);
      const rows = await trx
        .selectFrom('union_bindings')
        .selectAll()
        .where('app_id', '=', appId)
        .where('user_id', '=', userId)
        .where('platform', '=', platform)
        .execute();
      const current =
        rows.find((r) => UNRELEASED.includes(r.status)) ?? rows.find((r) => r.status === 'unbound');
      if (current === undefined) throw new AdminUnionBindingNotAllowedError();
      if (action === 'enable' && banned) throw new AdminUnionBindingNotAllowedError();
      if (current.row_version !== command.expectedRowVersion) {
        throw new AdminUnionBindingConflictError();
      }
      if (!allowed(action, current)) throw new AdminUnionBindingNotAllowedError();
      const now = this.#clock.now();
      const release =
        action === 'reset'
          ? {
              released_at: now,
              cooldown_until: later(
                now,
                cooldownDays(await config.configValue(appId, COOLDOWN_KEY)) * DAY_MS,
              ),
            }
          : {};
      let updated: BindingRow = current;
      for (const [index, target] of stepsOf(action, platform).entries()) {
        if (!canTransitionBinding(updated.status, target.status)) {
          throw new Error(
            `union_bindings: illegal status transition ${updated.status} → ${target.status}`,
          );
        }
        const written = await trx
          .updateTable('union_bindings')
          .set((eb) => ({
            status: target.status,
            blocked_reason: target.blockedReason,
            reason: command.reason,
            ...release,
            updated_at: now,
            row_version: eb('row_version', '+', 1),
          }))
          .where('id', '=', updated.id)
          .where('app_id', '=', appId)
          .where('user_id', '=', userId)
          .where('status', '=', updated.status)
          .where('row_version', '=', updated.row_version)
          .returningAll()
          .executeTakeFirst();
        if (written === undefined) {
          // First step: a writer without the user lock (the inspection) moved the row first.
          if (index === 0) throw new AdminUnionBindingConflictError();
          // A later step: this transaction holds the row's lock since its first step.
          throw new Error('linking: union binding changed between the steps of one write');
        }
        updated = written;
      }
      // A binding that has just become active resolves the user's 30151 rows (BR-ID-18).
      if (updated.status === 'active') {
        await resolveBindingConflictsOnActive(trx, appId, userId, platform, now);
      }
      await audit.append({
        appId,
        actor: command.adminId,
        action: `union_binding_${action}`,
        target: userId,
        before: {
          user_id: userId,
          platform,
          status: current.status,
          blocked_reason: current.blocked_reason,
          row_version: current.row_version,
        },
        after: {
          user_id: userId,
          platform,
          status: updated.status,
          blocked_reason: updated.blocked_reason,
          row_version: updated.row_version,
          released_at: iso(updated.released_at),
          cooldown_until: iso(updated.cooldown_until),
          reason: command.reason,
        },
        ip: command.ip,
      });
      return updated;
    });
    if (action === 'reset' && this.#purge !== undefined) {
      try {
        await this.#purge(appId, userId);
      } catch (error) {
        this.#logger.warn(
          {
            event: 'linking.admin.jump_cache_purge_failed',
            app_id: appId,
            platform,
            reason: error instanceof Error ? error.name : 'unknown',
          },
          'linking: converted-link cache not cleared after a reset',
        );
      }
    }
    return adminBindingView(row);
  }
}
