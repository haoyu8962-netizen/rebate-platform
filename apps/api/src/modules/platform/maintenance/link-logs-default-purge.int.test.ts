// CT-13l implementation-side integration tests of app.purge_expired_link_logs_default and the
// link_logs-only append-only guard app.reject_link_logs_update_delete()
// (db/migrations/0145_link-logs-default-purge.sql; orchestrator rulings D10-1802, D10-1825): the
// trigger moved to the new function while the shared app.reject_update_delete() and every other
// table's trigger stay as they were; business roles still cannot delete or rewrite link_logs rows,
// with or without the purge's transaction-local setting, and that setting never outlives the call;
// the purge takes no table lock on app.link_logs or app.users and blocks no writer; a failing copy
// rolls back as a whole; what REPEATABLE READ readers see.
// Business roles only (couli_migrator is not offered to tests): the owner's side of the trigger
// (23001 without the setting, for rows not expired, for day partitions, for UPDATE, and after the
// purge returned in the same transaction) was measured on PG 18 as couli_migrator and is reported
// with the task; here it is held through the catalogue (which function the triggers run) and the
// setting's value after the call.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase, type TestDbRole } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

const APP = 'couli';
/** 2026-10-09 04:00 (+08:00); cutoff 2026-07-11 00:00 (+08:00) = 2026-07-10T16:00:00Z. */
const NOW = '2026-10-08T20:00:00.000Z';
const EXPIRED = '2026-07-10T15:59:59.999Z';
const CUTOFF = '2026-07-10T16:00:00.000Z';
const FIXTURE_AT = '2026-01-04T00:00:00.000Z';
/** Far enough that every decided claim item is past the evidence retention. */
const FAR = '2100-01-01T00:00:00.000Z';
/** The transaction-local setting the purge sets for its own DELETE (0145). */
const PURGE_SETTING = 'couli.link_logs_default_purge_before';
/** md5 of app.reject_update_delete()'s body as created by 0003 (measured on PG 18 before 0145). */
const SHARED_GUARD_MD5 = '232d9773355d37e98dd7d9984bbc96e1';

interface World {
  readonly database: TestDatabase;
  readonly maint: Kysely<DB>;
  readonly app: Kysely<DB>;
  readonly readonly: Kysely<DB>;
  readonly payout: Kysely<DB>;
}

async function withWorld(scenario: (world: World) => Promise<void>): Promise<void> {
  const database = await createTestDatabase();
  const world: World = {
    database,
    maint: createDb({ connectionString: database.urlFor('couli_maint'), max: 2 }),
    app: createDb({ connectionString: database.urlFor('couli_app'), max: 2 }),
    readonly: createDb({ connectionString: database.urlFor('couli_readonly'), max: 2 }),
    payout: createDb({ connectionString: database.urlFor('couli_payout'), max: 1 }),
  };
  try {
    await scenario(world);
  } finally {
    await Promise.all(
      [world.maint, world.app, world.readonly, world.payout].map((db) =>
        destroyDb(db).catch(() => undefined),
      ),
    );
    await database.drop();
  }
}

function failure(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return `failed ${typeof code === 'string' ? code : String(error)}`;
}

/** One call as `db` (its own statement): the deleted count, or `failed <SQLSTATE>`. */
async function purge(db: Kysely<DB>, now: string = NOW): Promise<bigint | string> {
  try {
    const result = await sql<{ deleted: bigint }>`
      SELECT app.purge_expired_link_logs_default(${now}::timestamptz) AS deleted
    `.execute(db);
    return result.rows[0]?.deleted ?? 'no row';
  } catch (error) {
    return failure(error);
  }
}

/** A purge call and how long it took. */
async function timedPurge(db: Kysely<DB>): Promise<{ result: bigint | string; ms: number }> {
  const t0 = performance.now();
  const result = await purge(db);
  return { result, ms: performance.now() - t0 };
}

/**
 * A transaction of `role` on its own connection that runs `hold`, then stays open until
 * `release()`. `ready` resolves 'ok' once `hold` is done (or `failed <code>`).
 */
function holder(
  database: TestDatabase,
  role: TestDbRole,
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

/** A link_logs row as couli_app (with a fixed id when given); returns its id as text. */
async function insertLog(
  app: Kysely<DB>,
  createdAt: string,
  scene: string,
  id?: string,
): Promise<string> {
  const result =
    id === undefined
      ? await sql<{ id: string }>`
          INSERT INTO app.link_logs (app_id, event, result_code, raw_item_id, scene, created_at)
          VALUES (${APP}, 'convert', 0, 'item-1', ${scene}, ${createdAt}::timestamptz)
          RETURNING id::text AS id
        `.execute(app)
      : await sql<{ id: string }>`
          INSERT INTO app.link_logs (id, app_id, event, result_code, raw_item_id, scene, created_at)
          OVERRIDING SYSTEM VALUE
          VALUES (${id}::bigint, ${APP}, 'open', 0, 'item-2', ${scene}, ${createdAt}::timestamptz)
          RETURNING id::text AS id
        `.execute(app);
  return result.rows[0]!.id;
}

/** A user, a claim and one pending claim item referencing `ids`; returns the item id. */
async function seedReference(app: Kysely<DB>, ids: readonly string[]): Promise<string> {
  const userId = randomUUID();
  await sql`
    INSERT INTO app.users (id, app_id, nickname, avatar, invite_code, attr_code, level,
                           register_method, status, created_at, updated_at)
    VALUES (${userId}::uuid, ${APP}, 'u', 'fixture', ${randomUUID()}, ${randomUUID()}, 'L1',
            'sms', 'normal', ${FIXTURE_AT}::timestamptz, ${FIXTURE_AT}::timestamptz)
  `.execute(app);
  const claimId = randomUUID();
  await sql`
    INSERT INTO app.claims (id, app_id, user_id, platform, order_no, order_no_type, paid_date,
                            evidence_level, status, created_at, updated_at)
    VALUES (${claimId}::uuid, ${APP}, ${userId}::uuid, 'jd', ${`parent-${claimId}`}, 'parent',
            '2026-01-05', 'weak', 'manual_review', ${FIXTURE_AT}::timestamptz,
            ${FIXTURE_AT}::timestamptz)
  `.execute(app);
  const itemId = randomUUID();
  const orderId = randomUUID();
  await sql`
    INSERT INTO app.order_keys (platform, sub_order_id, order_id, app_id, attr_at)
    VALUES ('jd', ${`child-${orderId}`}, ${orderId}::uuid, ${APP}, ${FIXTURE_AT}::timestamptz)
  `.execute(app);
  await sql`
    INSERT INTO app.claim_items (id, app_id, claim_id, applicant_user_id, platform, sub_order_id,
                                 order_id, evidence, evidence_link_log_ids, created_at, updated_at)
    VALUES (${itemId}::uuid, ${APP}, ${claimId}::uuid, ${userId}::uuid, 'jd',
            ${`child-${orderId}`}, ${orderId}::uuid, 'weak', ${[...ids]}::bigint[],
            ${FIXTURE_AT}::timestamptz, ${FIXTURE_AT}::timestamptz)
  `.execute(app);
  return itemId;
}

/** Decides the item long ago, so the evidence purge at FAR removes its evidence rows. */
async function decideLongAgo(app: Kysely<DB>, itemId: string): Promise<void> {
  await sql`
    UPDATE app.claim_items
    SET decision = 'approved', decided_at = '2020-01-01T00:00:00Z'::timestamptz,
        updated_at = '2020-01-01T00:00:00Z'::timestamptz, row_version = row_version + 1
    WHERE id = ${itemId}::uuid
  `.execute(app);
}

/** Every row of the DEFAULT partition itself (couli_readonly may read it), by id. */
async function defaultRows(readonly: Kysely<DB>): Promise<Array<Record<string, unknown>>> {
  return readonly.transaction().execute(async (trx) => {
    await sql`SET LOCAL TIME ZONE 'UTC'`.execute(trx);
    const result = await sql<{ row: Record<string, unknown> }>`
      SELECT to_jsonb(l) AS row FROM ONLY app.link_logs_default l ORDER BY l.id, l.created_at
    `.execute(trx);
    return result.rows.map((r) => r.row);
  });
}

async function defaultIds(readonly: Kysely<DB>): Promise<string[]> {
  const result = await sql<{ id: string }>`
    SELECT id::text AS id FROM ONLY app.link_logs_default ORDER BY id
  `.execute(readonly);
  return result.rows.map((r) => r.id);
}

async function evidence(maint: Kysely<DB>): Promise<Array<{ id: string; scene: string | null }>> {
  const result = await sql<{ id: string; scene: string | null }>`
    SELECT id::text AS id, scene FROM app.link_log_evidence ORDER BY id
  `.execute(maint);
  return result.rows;
}

/** Every non-internal trigger of schema app: table, name, enabled state and definition. */
async function triggerDefinitions(readonly: Kysely<DB>): Promise<string[]> {
  const result = await sql<{ line: string }>`
    SELECT c.oid::regclass::text || ' | ' || t.tgname || ' | ' || t.tgenabled::text || ' | '
           || pg_get_triggerdef(t.oid) AS line
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND NOT t.tgisinternal
    ORDER BY 1
  `.execute(readonly);
  return result.rows.map((r) => r.line);
}

/** The value of the purge's setting in `db`'s current transaction ('<unset>' when undefined). */
async function purgeSetting(db: Kysely<DB>): Promise<string> {
  const result = await sql<{ value: string | null }>`
    SELECT current_setting(${PURGE_SETTING}::text, true) AS value
  `.execute(db);
  return result.rows[0]?.value ?? '<unset>';
}

/** Sets the purge's setting transaction-locally, as anyone can. */
async function forgeSetting(db: Kysely<DB>, value: string): Promise<void> {
  await sql`SELECT set_config(${PURGE_SETTING}::text, ${value}::text, true)`.execute(db);
}

/** Runs `statement` in a savepoint of `trx`: 'ok' or `failed <SQLSTATE>`, the transaction goes on. */
async function attempt(trx: Kysely<DB>, statement: ReturnType<typeof sql>): Promise<string> {
  await sql`SAVEPOINT attempt`.execute(trx);
  try {
    await statement.execute(trx);
    await sql`RELEASE SAVEPOINT attempt`.execute(trx);
    return 'ok';
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT attempt`.execute(trx);
    return failure(error);
  }
}

it('[AC-CT-13l#4] link_logs_append_only（父表与各分区的克隆）改跑专用函数 reject_link_logs_update_delete；公用 reject_update_delete 一字未动，audit_logs 等其他表的触发器定义在清理前后逐字相同、都还跑公用函数', async () => {
  await withWorld(async ({ maint, app, readonly }) => {
    expect(
      await sql`SELECT app.ensure_day_partition('link_logs'::text, '2026-10-09'::date)`
        .execute(maint)
        .then(() => 'ok'),
    ).toBe('ok');
    const guards = await sql<{ rel: string; fn: string; enabled: string; clone: boolean }>`
      SELECT t.tgrelid::regclass::text AS rel, t.tgfoid::regprocedure::text AS fn,
             t.tgenabled::text AS enabled, t.tgparentid <> 0 AS clone
      FROM pg_trigger t
      WHERE t.tgname = 'link_logs_append_only'
      ORDER BY 1
    `.execute(readonly);
    const fn = 'app.reject_link_logs_update_delete()';
    expect(guards.rows).toEqual([
      { rel: 'app.link_logs', fn, enabled: 'O', clone: false },
      { rel: 'app.link_logs_default', fn, enabled: 'O', clone: true },
      { rel: 'app.link_logs_p20261009', fn, enabled: 'O', clone: true },
    ]);
    const users = await sql<{ rel: string }>`
      SELECT DISTINCT t.tgrelid::regclass::text AS rel FROM pg_trigger t
      WHERE t.tgfoid = to_regprocedure(${fn}::text) ORDER BY 1
    `.execute(readonly);
    expect(users.rows.map((r) => r.rel)).toEqual([
      'app.link_logs',
      'app.link_logs_default',
      'app.link_logs_p20261009',
    ]);
    const shared = await sql<{ body: string }>`
      SELECT md5(prosrc) AS body FROM pg_proc WHERE oid = 'app.reject_update_delete()'::regprocedure
    `.execute(readonly);
    expect(shared.rows).toEqual([{ body: SHARED_GUARD_MD5 }]);

    const before = await triggerDefinitions(readonly);
    expect(before).toContain(
      'app.audit_logs | audit_logs_append_only | O | CREATE TRIGGER audit_logs_append_only ' +
        'BEFORE DELETE OR UPDATE ON app.audit_logs FOR EACH ROW EXECUTE FUNCTION ' +
        'app.reject_update_delete()',
    );
    const others = before.filter((line) => !line.startsWith('app.link_logs'));
    expect(
      others.filter((line) => line.endsWith('app.reject_update_delete()')).length,
    ).toBeGreaterThan(10);
    expect(others.filter((line) => line.includes('reject_link_logs_update_delete'))).toEqual([]);

    await insertLog(app, EXPIRED, 'expired');
    expect(await purge(maint)).toBe(1n);
    expect(await triggerDefinitions(readonly)).toEqual(before);
  });
}, 60_000);

it('[AC-CT-13l#5] 业务角色（应用、维护、只读、打款）删改 link_logs 与 link_logs_default 一律被拒（42501，到不了触发器），自己伪造清理标记也一样；行一条不少', async () => {
  await withWorld(async ({ app, maint, readonly, payout }) => {
    const expired = await insertLog(app, EXPIRED, 'expired');
    const statements = [
      sql`DELETE FROM app.link_logs WHERE id = ${expired}::bigint`,
      sql`DELETE FROM app.link_logs_default WHERE id = ${expired}::bigint`,
      sql`UPDATE app.link_logs SET scene = 'x' WHERE id = ${expired}::bigint`,
      sql`UPDATE app.link_logs_default SET scene = 'x' WHERE id = ${expired}::bigint`,
    ];
    for (const db of [app, maint, readonly, payout]) {
      const outcomes = await db.transaction().execute(async (trx) => {
        const out: string[] = [];
        for (const statement of statements) out.push(await attempt(trx, statement));
        await forgeSetting(trx, '2100-01-01 00:00:00+00');
        for (const statement of statements) out.push(await attempt(trx, statement));
        return out;
      });
      expect(outcomes).toEqual(Array(8).fill('failed 42501'));
    }
    expect(await defaultIds(readonly)).toEqual([expired]);
  });
}, 60_000);

it('[AC-CT-13l#5] 清理标记不出清理函数：维护角色在显式事务里调用后（调用前是否自己设过都一样）同一事务里标记已清空，事务结束后也不在', async () => {
  await withWorld(async ({ app, maint }) => {
    await insertLog(app, EXPIRED, 'first');
    const plain = await maint.transaction().execute(async (trx) => {
      const before = await purgeSetting(trx);
      const deleted = await purge(trx);
      return { before, deleted, after: await purgeSetting(trx) };
    });
    expect(plain).toEqual({ before: '<unset>', deleted: 1n, after: '' });

    await insertLog(app, EXPIRED, 'second');
    const forged = await maint.transaction().execute(async (trx) => {
      await forgeSetting(trx, '2100-01-01 00:00:00+00');
      const deleted = await purge(trx);
      return { deleted, after: await purgeSetting(trx) };
    });
    expect(forged).toEqual({ deleted: 1n, after: '' });
    const outside = await purgeSetting(maint);
    expect(['', '<unset>']).toContain(outside);
  });
}, 60_000);

it('[AC-CT-13l#6] 清理事务（调用已返回、尚未提交）对 app.link_logs 与 app.users 不持 RowExclusive 以上的表锁；期间另一会话往 link_logs（DEFAULT 与日分区）和 users 插入立即完成', async () => {
  await withWorld(async ({ database, maint, app, readonly }) => {
    expect(
      await sql`SELECT app.ensure_day_partition('link_logs'::text, '2026-10-09'::date)`
        .execute(maint)
        .then(() => 'ok'),
    ).toBe('ok');
    const expired = await insertLog(app, EXPIRED, 'expired');
    await seedReference(app, [expired]);
    await insertLog(app, '2026-03-01T00:00:00Z', 'loose');
    let pid = 0;
    let deleted: bigint | string = 'not run';
    let setting = '';
    const purging = holder(database, 'couli_maint', async (trx) => {
      const backend = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      pid = backend.rows[0]!.pid;
      deleted = await purge(trx);
      setting = await purgeSetting(trx);
    });
    try {
      expect(await purging.ready).toBe('ok');
      expect({ deleted, setting }).toEqual({ deleted: 2n, setting: '' });
      const locks = await sql<{ rel: string; mode: string }>`
        SELECT l.relation::regclass::text AS rel, l.mode
        FROM pg_locks l
        WHERE l.pid = ${pid}::int AND l.locktype = 'relation'
          AND l.relation IN ('app.link_logs'::regclass, 'app.users'::regclass,
                             'app.link_logs_default'::regclass)
        ORDER BY 1, 2
      `.execute(readonly);
      // The purge did run in that transaction: it holds the DEFAULT partition's row-write lock.
      expect(locks.rows).toContainEqual({ rel: 'app.link_logs_default', mode: 'RowExclusiveLock' });
      const weak = ['AccessShareLock', 'RowShareLock', 'RowExclusiveLock'];
      expect(
        locks.rows.filter((l) => l.rel !== 'app.link_logs_default' && !weak.includes(l.mode)),
      ).toEqual([]);

      const t0 = performance.now();
      const parts = await sql<{ part: string }>`
        INSERT INTO app.link_logs (app_id, event, result_code, created_at)
        VALUES (${APP}, 'open', 0, '2097-01-01T00:00:00Z'::timestamptz),
               (${APP}, 'open', 0, '2026-10-09T06:00:00+08:00'::timestamptz),
               (${APP}, 'open', 0, ${EXPIRED}::timestamptz)
        RETURNING tableoid::regclass::text AS part
      `.execute(app);
      await sql`
        INSERT INTO app.users (id, app_id, nickname, avatar, invite_code, attr_code, level,
                               register_method, status, created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${APP}, 'u', 'fixture', ${randomUUID()}, ${randomUUID()},
                'L1', 'sms', 'normal', ${FIXTURE_AT}::timestamptz, ${FIXTURE_AT}::timestamptz)
      `.execute(app);
      expect(performance.now() - t0).toBeLessThan(2_000);
      expect(parts.rows.map((r) => r.part)).toEqual([
        'app.link_logs_default',
        'app.link_logs_p20261009',
        'app.link_logs_default',
      ]);
    } finally {
      purging.release();
      await purging.done;
    }
    expect((await evidence(maint)).map((r) => r.id)).toEqual([expired]);
  });
}, 60_000);

it('[AC-CT-13l#6] 另一会话持 ROW EXCLUSIVE（未提交的插入）时清理照常完成、不等锁', async () => {
  await withWorld(async ({ database, maint, app, readonly }) => {
    const expired = await insertLog(app, EXPIRED, 'expired');
    const kept = await insertLog(app, CUTOFF, 'kept');
    const writing = holder(database, 'couli_app', async (trx) => {
      await sql`
        INSERT INTO app.link_logs (app_id, event, result_code, created_at)
        VALUES (${APP}, 'open', 0, '2097-01-01T00:00:00Z'::timestamptz)
      `.execute(trx);
    });
    try {
      expect(await writing.ready).toBe('ok');
      const call = await timedPurge(maint);
      expect(call.result).toBe(1n);
      expect(call.ms).toBeLessThan(2_000);
    } finally {
      writing.release();
      await writing.done;
    }
    const ids = await defaultIds(readonly);
    expect(ids).toContain(kept);
    expect(ids).not.toContain(expired);
  });
}, 60_000);

it('[AC-CT-13l#5] 复制那步失败（证据行被未提交的证据清理锁住，等锁 5 秒超时 55P03，与 drop_expired_day_partitions 同值）：整体回滚，DEFAULT 行一条不少、证据不变；锁放开后同一调用复制并删除', async () => {
  await withWorld(async ({ database, maint, app, readonly }) => {
    const id = await insertLog(app, EXPIRED, 'first');
    const item = await seedReference(app, [id]);
    expect(await purge(maint)).toBe(1n);
    expect(await evidence(maint)).toEqual([{ id, scene: 'first' }]);
    await decideLongAgo(app, item);

    // The same id again in DEFAULT, still referenced, plus an unreferenced expired row.
    expect(await insertLog(app, '2026-03-03T00:00:00Z', 'second', id)).toBe(id);
    const loose = await insertLog(app, '2026-03-04T00:00:00Z', 'loose');
    const rowsBefore = await defaultRows(readonly);

    const purging = holder(database, 'couli_maint', async (trx) => {
      await sql`SELECT app.purge_expired_link_log_evidence(${FAR}::timestamptz)`.execute(trx);
    });
    try {
      expect(await purging.ready).toBe('ok');
      const first = await timedPurge(maint);
      expect(first.result).toBe('failed 55P03');
      expect(first.ms).toBeGreaterThanOrEqual(4_000);
      expect(first.ms).toBeLessThan(10_000);
      expect(await defaultRows(readonly)).toEqual(rowsBefore);
      expect(await evidence(maint)).toEqual([{ id, scene: 'first' }]);
    } finally {
      purging.release();
      await purging.done;
    }

    expect(await evidence(maint)).toEqual([]);
    expect(await purge(maint)).toBe(2n);
    expect(await evidence(maint)).toEqual([{ id, scene: 'second' }]);
    expect(await defaultIds(readonly)).not.toContain(loose);
  });
}, 60_000);

/**
 * The call as the worker's section P makes it (D10-1826): a short transaction that sets
 * statement_timeout locally, then the purge; the deleted count or `failed <SQLSTATE>`.
 */
async function boundedPurge(db: Kysely<DB>, timeout: string): Promise<bigint | string> {
  try {
    return await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('statement_timeout', ${timeout}::text, true)`.execute(trx);
      const result = await sql<{ deleted: bigint }>`
        SELECT app.purge_expired_link_logs_default(${NOW}::timestamptz) AS deleted
      `.execute(trx);
      return result.rows[0]?.deleted ?? 'no row';
    });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Prepares a DEFAULT row whose copy has to wait: an evidence row of id `id` exists (an earlier
 * purge copied it), its item is decided long ago, and the same id is back in DEFAULT. Returns a
 * holder whose uncommitted evidence purge deletes that evidence row, so the next copy of `id` waits
 * for it.
 */
async function copyMustWait(
  world: World,
  label: string,
): Promise<{ id: string; hold: ReturnType<typeof holder> }> {
  const { database, maint, app } = world;
  const id = await insertLog(app, EXPIRED, `${label}-first`);
  const item = await seedReference(app, [id]);
  expect(await purge(maint)).toBe(1n);
  await decideLongAgo(app, item);
  expect(await insertLog(app, '2026-03-03T00:00:00Z', `${label}-second`, id)).toBe(id);
  const hold = holder(database, 'couli_maint', async (trx) => {
    await sql`SELECT app.purge_expired_link_log_evidence(${FAR}::timestamptz)`.execute(trx);
  });
  expect(await hold.ready).toBe('ok');
  return { id, hold };
}

it('[AC-CT-13l#8] 第 P 节的短事务（set_config statement_timeout 后调用）撞超时 57014：整体回滚，DEFAULT 行与证据表都一条不变；放开后同样的调用（60s）完成', async () => {
  await withWorld(async (world) => {
    const { maint, app, readonly } = world;
    const { id, hold } = await copyMustWait(world, 'timeout');
    const loose = await insertLog(app, '2026-03-04T00:00:00Z', 'loose');
    const rowsBefore = await defaultRows(readonly);
    const evidenceBefore = await evidence(maint);
    try {
      // 1s is shorter than the copy's 5s lock wait: the statement timeout ends the call.
      const t0 = performance.now();
      expect(await boundedPurge(maint, '1s')).toBe('failed 57014');
      expect(performance.now() - t0).toBeLessThan(4_000);
      expect(await defaultRows(readonly)).toEqual(rowsBefore);
      expect(await evidence(maint)).toEqual(evidenceBefore);
    } finally {
      hold.release();
      await hold.done;
    }
    expect(await boundedPurge(maint, '60s')).toBe(2n);
    expect(await evidence(maint)).toEqual([{ id, scene: 'timeout-second' }]);
    expect(await defaultIds(readonly)).not.toContain(loose);
  });
}, 60_000);

it('[AC-CT-13l#9] 复制之后、删除之前才提交的认领引用：该过期行这一轮不删（证据表还没有它的副本），下一轮复制后再删；其余过期行照删', async () => {
  await withWorld(async (world) => {
    const { maint, app, readonly } = world;
    // The copy of `id` waits for the holder; its INSERT … SELECT already has its snapshot, so a
    // reference committed meanwhile is invisible to the copy but visible to the later DELETE.
    const { id, hold } = await copyMustWait(world, 'late');
    const late = await insertLog(app, '2026-03-05T00:00:00Z', 'late-reference');
    const loose = await insertLog(app, '2026-03-06T00:00:00Z', 'loose');
    let call: Promise<bigint | string> | undefined;
    try {
      call = purge(maint);
      // Wait until the call is blocked in the copy (a not granted lock of a couli_maint backend).
      let waiting = false;
      for (let i = 0; i < 40 && !waiting; i += 1) {
        const waits = await sql<{ n: number }>`
          SELECT count(*)::int AS n
          FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE a.usename = 'couli_maint' AND NOT l.granted
        `.execute(readonly);
        waiting = (waits.rows[0]?.n ?? 0) > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(waiting).toBe(true);
      await seedReference(app, [late]);
    } finally {
      hold.release();
      await hold.done;
    }
    // `id` (copied) and `loose` go; `late` stays: referenced, but no evidence copy yet.
    expect(await call).toBe(2n);
    const ids = await defaultIds(readonly);
    expect(ids).toContain(late);
    expect(ids).not.toContain(loose);
    expect(ids).not.toContain(id);
    expect((await evidence(maint)).map((r) => r.id)).toEqual([id]);

    expect(await purge(maint)).toBe(1n);
    expect(await defaultIds(readonly)).not.toContain(late);
    expect(await evidence(maint)).toEqual([
      { id, scene: 'late-second' },
      { id: late, scene: 'late-reference' },
    ]);
  });
}, 60_000);

/**
 * A REPEATABLE READ transaction of couli_app: `first` runs as its first statement (it takes the
 * snapshot), then the transaction waits for `go` and reads the given ids through the parent.
 */
function repeatableReader(
  database: TestDatabase,
  first: (trx: Kysely<DB>) => Promise<unknown>,
  ids: readonly string[],
): { ready: Promise<string>; go: () => void; seen: Promise<string[] | string> } {
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  let go: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    go = resolve;
  });
  let signal: (value: string) => void = () => undefined;
  const ready = new Promise<string>((resolve) => {
    signal = resolve;
  });
  const seen = db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      await first(trx);
      signal('ok');
      await started;
      const result = await sql<{ id: string }>`
        SELECT id::text AS id FROM app.link_logs WHERE id = ANY (${[...ids]}::bigint[]) ORDER BY id
      `.execute(trx);
      return result.rows.map((r) => r.id);
    })
    .catch((error: unknown) => {
      signal(failure(error));
      return failure(error);
    })
    .finally(() => destroyDb(db).catch(() => undefined));
  return { ready, go, seen };
}

it.each([
  ['还没碰过 link_logs（快照由读 claim_items 建立）', 'claim_items'],
  ['清理前已读过 link_logs', 'link_logs'],
] as const)(
  '[AC-CT-13l#7] REPEATABLE READ：快照早于清理提交、%s 的事务，清理照常完成（不等锁），之后按 id 仍读得到 DEFAULT 留下的行（被删的行它也还看得到）',
  async (_label, table) => {
    await withWorld(async ({ database, maint, app, readonly }) => {
      const expired = await insertLog(app, EXPIRED, 'expired');
      const kept = await insertLog(app, CUTOFF, 'kept');
      const reader = repeatableReader(
        database,
        (trx) => sql`SELECT count(*) FROM ${sql.table(`app.${table}`)}`.execute(trx),
        [expired, kept],
      );
      expect(await reader.ready).toBe('ok');
      // Inserted after the reader's snapshot: invisible to it, which proves the snapshot is older.
      const marker = await insertLog(app, '2097-03-03T00:00:00Z', 'marker');
      const call = await timedPurge(maint);
      expect(call.result).toBe(1n);
      expect(call.ms).toBeLessThan(2_000);
      expect(await defaultIds(readonly)).toEqual([kept, marker]);
      reader.go();
      expect(await reader.seen).toEqual([expired, kept]);
    });
  },
  60_000,
);
