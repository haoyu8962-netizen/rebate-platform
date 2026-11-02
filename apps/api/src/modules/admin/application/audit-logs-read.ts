// Audit search of the admin console (B1-34a; contract adminListAuditLogs / adminGetAuditLog,
// CT-24c; 04 §6.6 audit-logs, §11.1 audit.view_all). Any signed-in account; the app is the
// authenticated principal's. Visibility is enforced here: an account holding audit.view_all (a
// super admin holds every point) sees every account's records; any other account only its own —
// the actor filter is forced to the caller, another account's actor_id is an empty page, and
// another account's record reads as unknown (20001 [id], as for a malformed or foreign id). System
// rows (D10-552) are nobody's own: only audit.view_all sees them, and no actor_id filter matches.
// Reads only: searching and reading write no audit record.
//
// Pure module (no decorators, erasable syntax).
import type { AdminPermission } from '@couli/contracts-ts';
import {
  AUDIT_VIEW_ALL,
  deriveAudit,
  permissionMatch,
  systemActorName,
  targetIdMatch,
  targetTypeMatch,
  type AuditCondition,
  type ConfigPermissions,
} from '../domain/audit-log-view.ts';
import type { AuditLogIdCodec } from '../infra/audit-log-id.ts';
import type { AuditLogRow, AuditLogStore, AuditSnapshot } from '../infra/audit-log-store.ts';
import type { AdminProfiles } from '../infra/admin-profiles.ts';

/** The authenticated caller (from the admin request check). */
export interface AuditCaller {
  readonly appId: string;
  readonly adminId: string;
  readonly isSuper: boolean;
}

/** Query parameters, already validated against the contract (page ≥ 1, page_size 1–200). */
export interface AuditQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly actorId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly permission?: string;
  readonly from?: string;
  readonly to?: string;
  /**
   * Export walk only (not an HTTP parameter): records at or before this instant, so the set is
   * fixed for the whole walk; combines with `to` (the earlier bound wins).
   */
  readonly upTo?: Date;
  /**
   * Export walk only: the `id` of the previous page's last item; the page continues the keyset
   * walk on (at, id) and `page` no longer offsets. A value this codec did not issue is an error.
   */
  readonly after?: string;
}

export interface AuditLogItemView {
  readonly id: string;
  /** null on a system row. */
  readonly actorId: string | null;
  /** Only system rows carry this and systemActor (contract: account rows leave both out). */
  readonly actorKind?: 'system';
  readonly systemActor?: string;
  readonly actorName: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly permission: AdminPermission | null;
  readonly ip: string | null;
  readonly at: Date;
}

export interface AuditLogDetailView extends AuditLogItemView {
  readonly before: AuditSnapshot;
  readonly after: AuditSnapshot;
}

export interface AuditLogsPage {
  readonly items: AuditLogItemView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface AuditLogsReader {
  list(caller: AuditCaller, query: AuditQuery): Promise<AuditLogsPage>;
  /** undefined: malformed, altered, unknown, foreign or not visible to the caller (all 20001). */
  get(caller: AuditCaller, id: string): Promise<AuditLogDetailView | undefined>;
}

/** Shape of an admin id; any other `actor_id` names no account (the column is a uuid). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 3339 date-time (the contract's `format: date-time`): date, time, fraction, offset. */
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Microseconds since the epoch of an RFC 3339 instant, as PostgreSQL's timestamptz reads it
 * (fraction rounded to the microsecond, half to even); undefined when it is not one. Integer
 * arithmetic throughout: a Date would drop everything below the millisecond.
 */
function epochMicros(text: string): bigint | undefined {
  const match = DATE_TIME.exec(text);
  if (match === null) return undefined;
  const [, date, time, fraction = '', offset] = match;
  const seconds = Date.parse(`${date}T${time}${offset!.toUpperCase()}`);
  if (Number.isNaN(seconds)) return undefined;
  let micros = BigInt(fraction.padEnd(6, '0').slice(0, 6));
  const rest = fraction.slice(6);
  if (rest !== '') {
    const half = '5'.padEnd(rest.length, '0');
    if (rest > half || (rest === half && micros % 2n === 1n)) micros += 1n;
  }
  return BigInt(seconds) * 1000n + micros;
}

/**
 * `from` later than `to` (both given), compared to the microsecond: the contract's 20001
 * [from, to]. Equal instants are not inverted (an empty window, not an error).
 */
export function auditRangeInvalid(from: string | undefined, to: string | undefined): boolean {
  if (from === undefined || to === undefined) return false;
  const start = epochMicros(from);
  const end = epochMicros(to);
  if (start === undefined || end === undefined) return Date.parse(from) > Date.parse(to);
  return start > end;
}

export function createAuditLogsReader(deps: {
  readonly store: AuditLogStore;
  readonly profiles: Pick<AdminProfiles, 'permissionKeys'>;
  readonly ids: () => AuditLogIdCodec;
  readonly configPermissions: ConfigPermissions;
}): AuditLogsReader {
  const { store, profiles, configPermissions } = deps;

  const viewsAll = async (caller: AuditCaller): Promise<boolean> =>
    caller.isSuper ||
    (await profiles.permissionKeys(caller.appId, caller.adminId)).includes(AUDIT_VIEW_ALL);

  const item = (row: AuditLogRow): AuditLogItemView => {
    const derived = deriveAudit(row, configPermissions);
    const name =
      row.displayName !== null && row.displayName !== '' ? row.displayName : row.loginName;
    return {
      id: deps.ids().encode(row.id),
      actorId: row.adminId,
      ...(row.systemActor === null || row.systemActor === undefined
        ? { actorName: name }
        : {
            actorKind: 'system' as const,
            systemActor: row.systemActor,
            actorName: systemActorName(row.systemActor),
          }),
      action: row.action,
      targetType: derived.targetType,
      targetId: derived.targetId,
      permission: derived.permission,
      ip: row.ip,
      at: row.at,
    };
  };

  return {
    async list(caller, query) {
      const all = await viewsAll(caller);
      const empty = { items: [], page: query.page, pageSize: query.pageSize, total: 0 };
      // A non-UUID actor_id names no account: the empty page, never a uuid cast error.
      if (query.actorId !== undefined && !UUID.test(query.actorId)) return empty;
      let actorId = query.actorId?.toLowerCase();
      if (!all) {
        if (actorId !== undefined && actorId !== caller.adminId.toLowerCase()) return empty;
        actorId = caller.adminId;
      }
      const derived: (readonly AuditCondition[])[] = [];
      if (query.targetType !== undefined) derived.push(targetTypeMatch(query.targetType));
      if (query.targetId !== undefined) derived.push(targetIdMatch(query.targetId));
      if (query.permission !== undefined) {
        derived.push(permissionMatch(query.permission, configPermissions));
      }
      // A filter that can match no row answers the empty page without a query.
      if (derived.some((any) => any.length === 0)) return empty;
      if (query.upTo !== undefined && Number.isNaN(query.upTo.getTime())) {
        throw new RangeError('audit logs: upper bound must be a valid instant');
      }
      const after = query.after === undefined ? undefined : deps.ids().decode(query.after);
      if (query.after !== undefined && after === undefined) {
        throw new RangeError('audit logs: cursor is invalid');
      }
      const filter = {
        appId: caller.appId,
        ...(actorId === undefined ? {} : { actorId }),
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        ...(query.upTo === undefined ? {} : { upTo: query.upTo }),
        derived,
      };
      const total = await store.count(filter);
      const rows =
        after === undefined
          ? await store.page(filter, (query.page - 1) * query.pageSize, query.pageSize)
          : await store.page(filter, 0, query.pageSize, after);
      return { items: rows.map(item), page: query.page, pageSize: query.pageSize, total };
    },

    async get(caller, id) {
      const key = deps.ids().decode(id);
      if (key === undefined) return undefined;
      const all = await viewsAll(caller);
      const row = await store.byId(caller.appId, key, all ? undefined : caller.adminId);
      if (row === undefined) return undefined;
      return { ...item(row), before: row.before, after: row.after };
    },
  };
}
