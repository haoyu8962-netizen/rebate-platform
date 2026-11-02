// Read-only queries of app.audit_logs for the admin console's audit search (B1-34a; contract
// adminListAuditLogs / adminGetAuditLog; 04 §3.2). Separate from the platform AuditPort (whose
// only method is append): this object never writes. Always one app_id; newest first (`at`, then
// the primary key, both descending). The actor's current name comes from admin_users (left join:
// a missing account reads as null). The derived-field filters arrive as condition plans built by
// ../domain/audit-log-view.ts from its action table, so SQL and the derivation agree.
//
// A system row (D10-552) has admin_id null and system_actor set: `l.admin_id = <id>` never matches
// it, so an actor filter or an actor-scoped read leaves it out without a condition of its own. The
// two actor columns are selected as raw SQL so this file reads the same with the generated types
// from before and after the migration.
//
// Pure module (no decorators, erasable syntax).
import type { DB } from '@couli/db';
import { sql, type Expression, type ExpressionBuilder, type Kysely, type SqlBool } from 'kysely';
import { AUDIT_TARGET_ID_MAX, type AuditCondition } from '../domain/audit-log-view.ts';

/** A stored before / after value: any JSON, null when none was recorded. */
export type AuditSnapshot = DB['audit_logs']['before'];

export interface AuditLogRow {
  readonly id: bigint;
  /** The account that acted; null on a system row. */
  readonly adminId: string | null;
  /** The system identity that acted (system:<name>); null on an account's row. */
  /** Absent or null on an account's row. */
  readonly systemActor?: string | null;
  readonly displayName: string | null;
  readonly loginName: string | null;
  readonly action: string;
  readonly target: string | null;
  readonly before: AuditSnapshot;
  readonly after: AuditSnapshot;
  readonly ip: string | null;
  readonly at: Date;
}

export interface AuditLogFilter {
  readonly appId: string;
  /** Only this account's records; undefined: every account's. */
  readonly actorId?: string;
  /** Inclusive / exclusive bounds, ISO 8601 with offset (already validated). */
  readonly from?: string;
  readonly to?: string;
  /** Inclusive upper bound on `at` (an export walk's fixed set; combines with `to`). */
  readonly upTo?: Date;
  /** Each entry is an OR of conditions, entries combine with AND; [] in an entry matches none. */
  readonly derived: readonly (readonly AuditCondition[])[];
}

export interface AuditLogStore {
  count(filter: AuditLogFilter): Promise<number>;
  /**
   * One page, newest first. With `after` (the primary key of the previous page's last row) the
   * page continues the keyset walk on (at, id) and `offset` must be 0; a cursor row that no
   * longer exists in the app is an error (the walk fails closed rather than ending early).
   */
  page(
    filter: AuditLogFilter,
    offset: number,
    limit: number,
    after?: bigint,
  ): Promise<AuditLogRow[]>;
  /** One record of the app (and of `actorId` when given); undefined when there is none. */
  byId(appId: string, id: bigint, actorId?: string): Promise<AuditLogRow | undefined>;
}

type Builder = ExpressionBuilder<DB & { l: DB['audit_logs'] }, 'l'>;

function condition(eb: Builder, plan: AuditCondition): Expression<SqlBool> {
  const action = eb('l.action', 'in', [...plan.actions]);
  switch (plan.kind) {
    case 'actions':
      return action;
    case 'targetEquals':
      return eb.and([action, eb('l.target', '=', plan.target)]);
    case 'targetIn':
      return eb.and([action, eb('l.target', 'in', [...plan.targets])]);
    case 'target': {
      const prefix = plan.prefix ?? '';
      return eb.and([
        action,
        eb('l.target', 'is not', null),
        sql<SqlBool>`starts_with(l.target, ${prefix})`,
        sql<SqlBool>`char_length(l.target) between ${prefix.length + 1} and ${
          prefix.length + AUDIT_TARGET_ID_MAX
        }`,
      ]);
    }
    case 'afterField':
      return eb.and([
        action,
        sql<SqlBool>`jsonb_typeof(l.after) = 'object'`,
        sql<SqlBool>`jsonb_typeof(l.after -> ${plan.field}::text) = 'string'`,
        sql<SqlBool>`(l.after ->> ${plan.field}::text) in (${sql.join([...plan.values])})`,
      ]);
  }
}

function where(eb: Builder, filter: AuditLogFilter): Expression<SqlBool> {
  const parts: Expression<SqlBool>[] = [eb('l.app_id', '=', filter.appId)];
  if (filter.actorId !== undefined) parts.push(eb('l.admin_id', '=', filter.actorId));
  if (filter.from !== undefined) {
    parts.push(sql<SqlBool>`l.at >= ${filter.from}::timestamptz`);
  }
  if (filter.to !== undefined) parts.push(sql<SqlBool>`l.at < ${filter.to}::timestamptz`);
  if (filter.upTo !== undefined) parts.push(eb('l.at', '<=', filter.upTo));
  for (const any of filter.derived) {
    parts.push(
      any.length === 0 ? sql<SqlBool>`false` : eb.or(any.map((plan) => condition(eb, plan))),
    );
  }
  return eb.and(parts);
}

export function createAuditLogStore(deps: { readonly db: Kysely<DB> }): AuditLogStore {
  const { db } = deps;
  /** Rows of the app matching `scope`, with the actor's names (joined after the filter). */
  const rows = (scope: (eb: Builder) => Expression<SqlBool>) =>
    db
      .selectFrom('audit_logs as l')
      .where(scope)
      .leftJoin('admin_users as u', (join) =>
        join.onRef('u.app_id', '=', 'l.app_id').onRef('u.id', '=', 'l.admin_id'),
      )
      .select([
        'l.id',
        sql<string | null>`l.admin_id`.as('admin_id'),
        sql<string | null>`l.system_actor`.as('system_actor'),
        'u.display_name',
        'u.login_name',
        'l.action',
        'l.target',
        'l.before',
        'l.after',
        'l.ip',
        'l.at',
      ]);
  type Selected = Awaited<ReturnType<ReturnType<typeof rows>['execute']>>[number];
  const toRow = (row: Selected): AuditLogRow => ({
    id: row.id,
    adminId: row.admin_id,
    systemActor: row.system_actor,
    displayName: row.display_name,
    loginName: row.login_name,
    action: row.action,
    target: row.target,
    before: row.before,
    after: row.after,
    ip: row.ip,
    at: row.at,
  });

  return {
    async count(filter) {
      const row = await db
        .selectFrom('audit_logs as l')
        .select((eb) => eb.fn.countAll<string>().as('total'))
        .where((eb) => where(eb, filter))
        .executeTakeFirstOrThrow();
      return Number(row.total);
    },

    async page(filter, offset, limit, after) {
      let cursor: { readonly at: string; readonly id: bigint } | undefined;
      if (after !== undefined) {
        // The cursor row's exact instant (microseconds kept as text; a Date would truncate).
        const anchor = await db
          .selectFrom('audit_logs as c')
          .select(
            sql<string>`to_char(c.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('at'),
          )
          .where('c.app_id', '=', filter.appId)
          .where('c.id', '=', after)
          .executeTakeFirst();
        if (anchor === undefined) throw new RangeError('audit log store: cursor row not found');
        cursor = { at: anchor.at, id: after };
      }
      const keyset = cursor;
      const found = await rows((eb) =>
        keyset === undefined
          ? where(eb, filter)
          : eb.and([
              where(eb, filter),
              sql<SqlBool>`(l.at, l.id) < (${keyset.at}::timestamptz, ${keyset.id}::bigint)`,
            ]),
      )
        .orderBy('l.at', 'desc')
        .orderBy('l.id', 'desc')
        .offset(offset)
        .limit(limit)
        .execute();
      return found.map(toRow);
    },

    async byId(appId, id, actorId) {
      const row = await rows((eb) =>
        eb.and([
          eb('l.app_id', '=', appId),
          eb('l.id', '=', id),
          ...(actorId === undefined ? [] : [eb('l.admin_id', '=', actorId)]),
        ]),
      ).executeTakeFirst();
      return row === undefined ? undefined : toRow(row);
    },
  };
}
