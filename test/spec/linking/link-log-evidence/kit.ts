// Helpers of the CT-13m rule tests (link_log_evidence). Basis: BR-ATTR-14 默认值（被工单引用的记录在分区
// 删除前复制到 link_log_evidence）; BR-ID-30 正文（每日 04:00（+08:00）删除任务，删除条件按运行当日 00:00
// （+08:00）截断）and ② (link_log_evidence 工单关闭后 180 天); 规划/04 第 438 行 (link_logs /
// link_log_evidence 同一组字段); orchestrator rulings D10-1624 / D10-1625.
//
// Contract the tests hold the implementation to (SQL objects are created by the implementation's
// migration, never by these tests):
// - `app.link_log_evidence`: every column of app.link_logs with the same type. A copied row equals
//   its link_logs row column by column. One row per copied link_logs row (unique on its key).
// - Copy: `app.drop_expired_day_partitions('link_logs', p_now)` (I1b, unchanged signature and
//   result) copies, in the same transaction and before each DROP, every row of the partitions it
//   drops whose id appears in some `app.claim_items.evidence_link_log_ids` (whatever the item's
//   decision); unreferenced rows are not copied. When the copy fails the call fails: nothing is
//   dropped and nothing is copied. References committed while the call waits for its table lock
//   count.
// - Purge: `app.purge_expired_link_log_evidence(p_now timestamptz)` (name suggested by D10-1625; the
//   result is not checked) deletes an evidence row exactly when no claim_items row references its
//   id, or every referencing item has decided_at and the latest decided_at < 00:00 (+08:00) of
//   p_now's +08:00 calendar day − 180 days. The session TimeZone changes nothing.
// - Grants: couli_app and couli_readonly may SELECT the evidence table and nothing else; couli_maint
//   executes both functions; no other role executes any function named *link_log_evidence*.
// - linking's createLinkLogMomentReader (B1-10j) answers ids found only in the evidence table too.
//
// Every helper that touches a new object reports a rejection as a value (`failed <SQLSTATE>`), so a
// scenario on a database without the migration fails on its assertions. Only *.int.test.ts files
// may import @couli/db/testing: they pass createTestDatabase in.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export type Role = 'couli_app' | 'couli_payout' | 'couli_readonly' | 'couli_maint';

/** The part of `TestDatabase` (@couli/db/testing) these helpers use. */
export interface Database {
  urlFor(role: Role): string;
  drop(): Promise<void>;
}

export interface World {
  readonly database: Database;
  readonly maint: Kysely<DB>;
  readonly app: Kysely<DB>;
  readonly payout: Kysely<DB>;
  readonly readonly: Kysely<DB>;
}

/** The App of every row unless a test says otherwise. */
export const APP = 'couli';

/** Fixed instant for created_at / updated_at of fixture rows that no rule looks at. */
const FIXTURE_AT = '2026-01-04T00:00:00.000Z';

/** A fresh database with one pool per business role, dropped afterwards. */
export async function withWorld(
  create: () => Promise<Database>,
  scenario: (world: World) => Promise<void>,
): Promise<void> {
  const database = await create();
  const world: World = {
    database,
    maint: createDb({ connectionString: database.urlFor('couli_maint'), max: 2 }),
    app: createDb({ connectionString: database.urlFor('couli_app'), max: 2 }),
    payout: createDb({ connectionString: database.urlFor('couli_payout'), max: 1 }),
    readonly: createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 }),
  };
  try {
    await scenario(world);
  } finally {
    await Promise.all(
      [world.maint, world.app, world.payout, world.readonly].map((db) =>
        destroyDb(db).catch(() => undefined),
      ),
    );
    await database.drop();
  }
}

/** A rejection as `failed <SQLSTATE>` (or the error text when it carries no code). */
export function failure(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return `failed ${typeof code === 'string' ? code : String(error)}`;
}

/** `ok`, or `failed <SQLSTATE>`. */
export async function outcome(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    return failure(error);
  }
}

/** app.ensure_day_partition('link_logs', day) for each 'YYYY-MM-DD'; names or `failed <code>`. */
export async function ensureDays(maint: Kysely<DB>, days: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const day of days) {
    try {
      const result = await sql<{ name: string | null }>`
        SELECT app.ensure_day_partition('link_logs'::text, ${day}::date) AS name
      `.execute(maint);
      out.push(result.rows[0]?.name ?? 'NULL result');
    } catch (error) {
      out.push(failure(error));
    }
  }
  return out;
}

/** app.drop_expired_day_partitions('link_logs', now) as `db`; the names or `failed <code>`. */
export async function dropDays(db: Kysely<DB>, now: string): Promise<string[] | string> {
  try {
    const result = await sql<{ names: string[] | null }>`
      SELECT app.drop_expired_day_partitions('link_logs'::text, ${now}::timestamptz) AS names
    `.execute(db);
    const names = result.rows[0]?.names;
    if (names === undefined) return 'no row';
    if (names === null) return 'NULL result';
    return names;
  } catch (error) {
    return failure(error);
  }
}

/** app.purge_expired_link_log_evidence(now) as `db`: `ok` or `failed <code>`. */
export async function purge(db: Kysely<DB>, now: string): Promise<string> {
  return outcome(sql`SELECT app.purge_expired_link_log_evidence(${now}::timestamptz)`.execute(db));
}

/** purge() inside a transaction whose session TimeZone is `zone`. */
export async function purgeInZone(db: Kysely<DB>, zone: string, now: string): Promise<string> {
  return outcome(
    db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('TimeZone', ${zone}, true)`.execute(trx);
      await sql`SELECT app.purge_expired_link_log_evidence(${now}::timestamptz)`.execute(trx);
    }),
  );
}

/** Names of the children of app.link_logs, ordered. */
export async function partitionNames(db: Kysely<DB>): Promise<string[]> {
  const result = await sql<{ name: string }>`
    SELECT c.relname::text AS name
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'app.link_logs'::regclass
    ORDER BY c.relname COLLATE "C"
  `.execute(db);
  return result.rows.map((r) => r.name);
}

let seq = 0;

/** A users row of `appId` as couli_app; returns its id. */
export async function seedUser(app: Kysely<DB>, appId: string = APP): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO app.users (id, app_id, nickname, avatar, invite_code, attr_code, level,
                           register_method, status, created_at, updated_at)
    VALUES (${id}::uuid, ${appId}, '证据用户', 'fixture', ${randomUUID()}, ${randomUUID()}, 'L1',
            'sms', 'normal', ${FIXTURE_AT}::timestamptz, ${FIXTURE_AT}::timestamptz)
  `.execute(app);
  return id;
}

export interface LogOptions {
  readonly appId?: string;
  readonly scene?: string;
}

/** A link_logs row with only the required columns (scene optional); returns its id as text. */
export async function insertLog(
  app: Kysely<DB>,
  createdAt: string,
  options: LogOptions = {},
): Promise<string> {
  seq += 1;
  const result = await sql<{ id: string }>`
    INSERT INTO app.link_logs (app_id, event, result_code, raw_item_id, scene, created_at)
    VALUES (${options.appId ?? APP}, 'convert', 0, ${`item-${String(seq)}`},
            ${options.scene ?? null}::text, ${createdAt}::timestamptz)
    RETURNING id::text AS id
  `.execute(app);
  return result.rows[0]?.id ?? 'no row';
}

/** A link_logs row with EVERY column set to a non-default value; returns its id as text. */
export async function insertFullLog(
  app: Kysely<DB>,
  createdAt: string,
  users: { readonly userId: string; readonly openerId: string },
): Promise<string> {
  seq += 1;
  const result = await sql<{ id: string }>`
    INSERT INTO app.link_logs (
      app_id, link_id, event, user_id, opener_user_id, platform, product_key, raw_item_id,
      shop_id, scene, pid_scene, spm, pid, relation_id, client, cache_hit, expired,
      quoted_price_fen, no_rebate, no_rebate_reason, agent_session_id, agent_message_id,
      prompt_version, model, result_code, latency_ms, created_at)
    VALUES (
      ${APP}, ${randomUUID()}::uuid, 'open', ${users.userId}::uuid, ${users.openerId}::uuid, 'jd',
      ${`jd_${String(seq)}`}, ${`raw-${String(seq)}`}, 'shop-7', 'search', 'agent', 'a.b.c.d',
      'pid-9', 'rel-3', 'ios', true, true, 1234567, true, 'union_blocked',
      ${randomUUID()}::uuid, ${randomUUID()}::uuid, 'prompt-v4', 'model-x', 30153, 87,
      ${createdAt}::timestamptz)
    RETURNING id::text AS id
  `.execute(app);
  return result.rows[0]?.id ?? 'no row';
}

/**
 * A link_logs row with the given id (OVERRIDING SYSTEM VALUE) and created_at, as couli_app; returns
 * the partition it landed in or `failed <code>`.
 */
export async function insertLogWithId(
  app: Kysely<DB>,
  id: string,
  createdAt: string,
  rawItemId: string,
): Promise<string> {
  try {
    const result = await sql<{ part: string }>`
      INSERT INTO app.link_logs (id, app_id, event, result_code, raw_item_id, scene, created_at)
      OVERRIDING SYSTEM VALUE
      VALUES (${id}::bigint, ${APP}, 'open', 30101, ${rawItemId}, 'share', ${createdAt}::timestamptz)
      RETURNING tableoid::regclass::text AS part
    `.execute(app);
    return result.rows[0]?.part ?? 'no row';
  } catch (error) {
    return failure(error);
  }
}

/** One link_logs row as jsonb (timestamps rendered under UTC), or undefined. */
export async function linkLogRow(
  db: Kysely<DB>,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL TIME ZONE 'UTC'`.execute(trx);
    const result = await sql<{ row: Record<string, unknown> }>`
      SELECT to_jsonb(l) AS row FROM app.link_logs l WHERE l.id = ${id}::bigint
    `.execute(trx);
    return result.rows[0]?.row;
  });
}

/** Ids (text) of every link_logs row, ascending. */
export async function linkLogIds(db: Kysely<DB>): Promise<string[]> {
  const result = await sql<{ id: string }>`
    SELECT id::text AS id FROM app.link_logs ORDER BY id, created_at
  `.execute(db);
  return result.rows.map((r) => r.id);
}

/** Every evidence row as jsonb (timestamps under UTC), by id; or `failed <code>`. */
export async function evidenceRows(
  db: Kysely<DB>,
): Promise<Array<Record<string, unknown>> | string> {
  try {
    return await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL TIME ZONE 'UTC'`.execute(trx);
      const result = await sql<{ row: Record<string, unknown> }>`
        SELECT to_jsonb(e) AS row FROM app.link_log_evidence e ORDER BY e.id, e.created_at
      `.execute(trx);
      return result.rows.map((r) => r.row);
    });
  } catch (error) {
    return failure(error);
  }
}

/** Ids (text) of every evidence row, ascending; or `failed <code>`. */
export async function evidenceIds(db: Kysely<DB>): Promise<string[] | string> {
  try {
    const result = await sql<{ id: string }>`
      SELECT id::text AS id FROM app.link_log_evidence ORDER BY id, created_at
    `.execute(db);
    return result.rows.map((r) => r.id);
  } catch (error) {
    return failure(error);
  }
}

/** The evidence rows restricted to the columns of `like` (a link_logs row), or the failure text. */
export function asLinkLogs(
  rows: Array<Record<string, unknown>> | string,
  like: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> | string {
  if (typeof rows === 'string') return rows;
  const keys = Object.keys(like ?? {});
  return rows.map((row) => Object.fromEntries(keys.map((key) => [key, row[key]])));
}

/** name and type of each column of app.<table> in column order (none when it does not exist). */
export async function columnsOf(
  db: Kysely<DB>,
  table: string,
): Promise<Array<{ name: string; type: string }>> {
  const result = await sql<{ name: string; type: string }>`
    SELECT a.attname::text AS name, format_type(a.atttypid, a.atttypmod) AS type
    FROM pg_attribute a
    WHERE a.attrelid = to_regclass(${`app.${table}`}::text) AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `.execute(db);
  return result.rows.map((r) => ({ name: r.name, type: r.type }));
}

export interface Claim {
  readonly id: string;
  readonly appId: string;
  readonly userId: string;
}

/** A claims row of `userId` (platform jd) as couli_app. */
export async function seedClaim(
  app: Kysely<DB>,
  userId: string,
  appId: string = APP,
): Promise<Claim> {
  const id = randomUUID();
  await sql`
    INSERT INTO app.claims (id, app_id, user_id, platform, order_no, order_no_type, paid_date,
                            evidence_level, status, created_at, updated_at)
    VALUES (${id}::uuid, ${appId}, ${userId}::uuid, 'jd', ${`parent-${id}`}, 'parent',
            '2026-01-05', 'weak', 'manual_review', ${FIXTURE_AT}::timestamptz,
            ${FIXTURE_AT}::timestamptz)
  `.execute(app);
  return { id, appId, userId };
}

/**
 * A claim_items row of `claim` referencing `ids` (link_logs ids as text) with its own order key;
 * decided (approved) at `decidedAt`, or pending when null. Returns its id.
 */
export async function seedItem(
  db: Kysely<DB>,
  claim: Claim,
  ids: readonly string[],
  decidedAt: string | null,
): Promise<string> {
  const id = randomUUID();
  const orderId = randomUUID();
  const subOrderId = `child-${orderId}`;
  await sql`
    INSERT INTO app.order_keys (platform, sub_order_id, order_id, app_id, attr_at)
    VALUES ('jd', ${subOrderId}, ${orderId}::uuid, ${claim.appId}, ${FIXTURE_AT}::timestamptz)
  `.execute(db);
  await sql`
    INSERT INTO app.claim_items (id, app_id, claim_id, applicant_user_id, platform, sub_order_id,
                                 order_id, evidence, evidence_link_log_ids, decision, reject_reason,
                                 decided_at, created_at, updated_at)
    VALUES (${id}::uuid, ${claim.appId}, ${claim.id}::uuid, ${claim.userId}::uuid, 'jd',
            ${subOrderId}, ${orderId}::uuid, ${ids.length === 0 ? 'none' : 'weak'}::text,
            ${[...ids]}::bigint[], ${decidedAt === null ? null : 'approved'}::text, NULL,
            ${decidedAt}::timestamptz, ${FIXTURE_AT}::timestamptz, ${FIXTURE_AT}::timestamptz)
  `.execute(db);
  return id;
}

/** Decides (approves) a pending item at `at`, as couli_app. */
export async function decideItem(app: Kysely<DB>, itemId: string, at: string): Promise<void> {
  await sql`
    UPDATE app.claim_items
    SET decision = 'approved', decided_at = ${at}::timestamptz, updated_at = ${at}::timestamptz,
        row_version = row_version + 1
    WHERE id = ${itemId}::uuid
  `.execute(app);
}

/** Drops every link_logs reference of an item (evidence none), as couli_app. */
export async function unreferenceItem(app: Kysely<DB>, itemId: string): Promise<void> {
  await sql`
    UPDATE app.claim_items
    SET evidence = 'none', evidence_link_log_ids = '{}'::bigint[], row_version = row_version + 1
    WHERE id = ${itemId}::uuid
  `.execute(app);
}

/**
 * A transaction on its own connection of `role` that runs `hold` and stays open until release().
 * `ready` resolves `ok` once `hold` succeeded, or `failed <code>` when it failed (then the
 * transaction is rolled back and `done` follows).
 */
export function holder(
  database: Database,
  role: Role,
  hold: (trx: Kysely<DB>) => Promise<unknown>,
): { ready: Promise<string>; release: () => void; done: Promise<void> } {
  const db = createDb({ connectionString: database.urlFor(role), max: 1 });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal: (value: string) => void = () => undefined;
  const ready = new Promise<string>((resolve) => {
    signal = resolve;
  });
  const done = db
    .transaction()
    .execute(async (trx) => {
      await hold(trx);
      signal('ok');
      await released;
    })
    .catch((error: unknown) => {
      signal(failure(error));
    })
    .finally(() => destroyDb(db).catch(() => undefined));
  return { ready, release, done: done.then(() => undefined) };
}

/** Waits (≤ 3 s) until a couli_maint session of this database waits for a lock. */
export async function maintWaits(observer: Kysely<DB>): Promise<boolean> {
  for (let i = 0; i < 150; i += 1) {
    const r = await sql<{ n: string }>`
      SELECT count(*)::text AS n
      FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND a.usename = 'couli_maint'
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `.execute(observer);
    if (r.rows[0]?.n !== '0') return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}
