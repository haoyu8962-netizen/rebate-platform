// B2-02zc: the migration itself (D10-2224 B ①). recon_diffs_unresolved_internal_key is a partial
// unique index (app_id, type, ref_id) WHERE type = 'ledger_mismatch' AND status IN ('open',
// 'processing'), named in its own migration (located by file-name suffix); in the database a second
// unresolved ledger_mismatch of the same app and ref_id is refused with 23505 whatever its period,
// a concluded one is accepted, and other types, apps and refs are not affected. Applied over
// existing duplicates (two unresolved tickets of one ref, one hold each; open / open and
// open / processing, each group in its own scratch database) the migration fails with 23505 on
// that index and changes no business row (it never concludes or rewrites tickets). Applied over an
// unresolved ticket without duplicate and its live hold it succeeds, the index is there and valid,
// and the ticket and the hold are unchanged field by field (it never releases holds).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import {
  AT,
  harness,
  indexes,
  insert,
  ready,
  recon,
  sqlState,
  type Row,
} from '../../db/settlement/ledger-owned/kit.ts';
import {
  CONCLUDED,
  INDEX,
  UNRESOLVED,
  preIndexDdl,
  scratchDatabase,
  unresolvedMigrationFile,
  unresolvedMigrationSource,
  type Scratch,
} from './kit.ts';

const h = harness(createTestDatabase);

/** A scratch database holding app.recon_diffs and app.withdraw_holds as right before the migration. */
async function preIndexDatabase(): Promise<Scratch> {
  const ddl = preIndexDdl();
  const scratch = await scratchDatabase();
  try {
    await sql`CREATE SCHEMA app`.execute(scratch.db);
    for (const statement of ddl) await sql.raw(statement).execute(scratch.db);
    expect(
      (await indexes(scratch.db, 'recon_diffs')).map((index) => index.name),
      '迁移前的库没有该索引',
    ).not.toContain(INDEX);
  } catch (error) {
    await scratch.drop();
    throw error;
  }
  return scratch;
}

/** Inserts a ledger_mismatch ticket and one live hold (released_at null) sourced from it. */
async function seedTicketWithHold(db: Kysely<DB>, diff: Row, group: string): Promise<void> {
  expect(
    await sqlState(insert(db, 'recon_diffs', diff)),
    `${group}：差错单 ${String(diff['status'])}`,
  ).toBe('ok');
  expect(
    await sqlState(
      insert(db, 'withdraw_holds', {
        id: randomUUID(),
        app_id: diff['app_id'],
        user_id: randomUUID(),
        reason: 'ledger_mismatch',
        source_ref: `recon_diff:${String(diff['id'])}`,
        created_by: 'system',
        created_at: AT,
        hold_until: null,
        released_at: null,
        released_by: null,
      }),
    ),
    `${group}：冻结`,
  ).toBe('ok');
}

/** Every ticket and every hold of the scratch database, row by row. */
async function businessRows(db: Kysely<DB>) {
  return {
    diffs: await db.selectFrom('recon_diffs').selectAll().orderBy('id').execute(),
    holds: await db.selectFrom('withdraw_holds').selectAll().orderBy('id').execute(),
  };
}

/** Runs the migration text in one transaction; the error it raised, or null when it committed. */
async function applyMigration(db: Kysely<DB>, migration: string): Promise<unknown> {
  return db
    .transaction()
    .execute((trx) => sql.raw(migration).execute(trx))
    .then(
      () => null,
      (error: unknown) => error,
    );
}

it('[AC-B2-02zc#9] 迁移（按后缀定位）显式建唯一索引 recon_diffs_unresolved_internal_key：键 (app_id, type, ref_id)、有效、非约束，谓词只含 ledger_mismatch 与 open / processing', async () => {
  await ready(h.app);
  const source = unresolvedMigrationSource();
  expect(source).toMatch(
    new RegExp(
      `\\bCREATE\\s+UNIQUE\\s+INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${INDEX}\\s+ON\\s+(?:ONLY\\s+)?app\\.recon_diffs\\b`,
      'i',
    ),
  );
  const found = (await indexes(h.app, 'recon_diffs')).filter((index) => index.name === INDEX);
  expect(found, `${INDEX} 存在`).toHaveLength(1);
  const index = found[0]!;
  expect(index).toMatchObject({
    keys: ['app_id', 'type', 'ref_id'],
    unique: true,
    valid: true,
    constraint_backed: false,
  });
  const predicate = index.predicate ?? '';
  const literals = [...predicate.matchAll(/'([^']*)'/gu)].map((match) => match[1]).sort();
  expect(literals, predicate).toEqual(['ledger_mismatch', 'open', 'processing']);
  const words = new Set(
    (
      predicate
        .replace(/'[^']*'/gu, '')
        .toLowerCase()
        .match(/[a-z_]+/gu) ?? []
    ).filter((word) => !['text', 'and', 'any', 'array', 'in'].includes(word)),
  );
  expect([...words].sort(), predicate).toEqual(['status', 'type']);
});

it('[AC-B2-02zc#10] 库内直接 INSERT：同 app 同 ref_id 已有未结 ledger_mismatch 时，第二张 open / processing（任何 period）23505；第二张已结案可插；首张结案后可再开；对外类型、别的 app、别的 ref 不受影响', async () => {
  await ready(h.app);
  const refId = `01:${randomUUID()}`;
  const first = recon({ ref_type: 'ledger_account', ref_id: refId, period: '2032-06-15' });
  expect(await sqlState(insert(h.app, 'recon_diffs', first))).toBe('ok');
  const another = (period: string, values: Row = {}): Row => ({
    ...first,
    id: randomUUID(),
    period,
    ...values,
  });

  for (const status of UNRESOLVED) {
    expect(
      await sqlState(insert(h.app, 'recon_diffs', another('2032-06-16', { status }))),
      `第二张 ${status}`,
    ).toBe('23505');
  }
  for (const [offset, status] of CONCLUDED.entries()) {
    const period = `2032-06-${String(16 + offset)}`;
    expect(
      await sqlState(insert(h.app, 'recon_diffs', another(period, { status, closed_at: AT }))),
      `第二张 ${status}`,
    ).toBe('ok');
  }

  // processing is unresolved too; once concluded, the same ref may be opened again.
  const move = (status: string, closedAt: string | null) =>
    sqlState(
      sql`UPDATE app.recon_diffs SET status = ${status}, closed_at = ${closedAt}::timestamptz
        WHERE id = ${first['id']}`.execute(h.app),
    );
  expect(await move('processing', null)).toBe('ok');
  expect(await sqlState(insert(h.app, 'recon_diffs', another('2032-06-20')))).toBe('23505');
  expect(await move('closed', AT)).toBe('ok');
  const reopened = another('2032-06-20');
  expect(await sqlState(insert(h.app, 'recon_diffs', reopened))).toBe('ok');
  expect(await sqlState(insert(h.app, 'recon_diffs', another('2032-06-21')))).toBe('23505');
  expect(await move('open', null), '已结案的旧单改回未结与新单冲突').toBe('23505');

  for (const values of [
    { type: 'union_mismatch', source: 'R1' },
    { type: 'channel_mismatch', source: 'R2' },
    { app_id: `other-${randomUUID()}` },
    { ref_id: `01:${randomUUID()}` },
    { ref_id: `07:${refId.slice(3)}` },
  ]) {
    expect(
      await sqlState(insert(h.app, 'recon_diffs', another('2032-06-22', values))),
      JSON.stringify(values),
    ).toBe('ok');
  }

  const stored = await sql<{ status: string; period: string }>`
    SELECT status, period FROM app.recon_diffs
    WHERE app_id = ${first['app_id']} AND type = 'ledger_mismatch' AND ref_id = ${refId}
    ORDER BY period`.execute(h.app);
  expect(stored.rows).toEqual([
    { status: 'closed', period: '2032-06-15' },
    { status: 'adjusted', period: '2032-06-16' },
    { status: 'written_off', period: '2032-06-17' },
    { status: 'closed', period: '2032-06-18' },
    { status: 'open', period: '2032-06-20' },
  ]);
});

it('[AC-B2-02zc#12] 迁移遇存量重复：无该索引的库里已有同 app、同 ref_id、不同 period 的两张未结 ledger_mismatch 及各自一条冻结，open / open 与 open / processing 两组各用独立的临时库 → 每组执行迁移文件原文都得 23505（建该索引失败），回滚后两张单与两条冻结逐行不变、索引不存在（迁移不自动结案、不改写业务数据）', async () => {
  const migration = unresolvedMigrationFile();
  for (const secondStatus of UNRESOLVED) {
    const group = `open / ${secondStatus}`;
    const scratch = await preIndexDatabase();
    try {
      const db = scratch.db;
      const refId = `01:${randomUUID()}`;
      const first = recon({
        ref_type: 'ledger_account',
        ref_id: refId,
        period: '2032-06-15',
        status: 'open',
        dedupe_key: `R3:2032-06-15:${refId}`,
      });
      const second = recon({
        app_id: first['app_id'],
        ref_type: 'ledger_account',
        ref_id: refId,
        period: '2032-06-16',
        status: secondStatus,
        dedupe_key: `R3:2032-06-16:${refId}`,
      });
      for (const diff of [first, second]) await seedTicketWithHold(db, diff, group);
      const before = await businessRows(db);
      expect(before.diffs, group).toHaveLength(2);
      expect(before.holds, group).toHaveLength(2);
      expect(before.diffs.map((diff) => diff.status).sort(), group).toEqual(
        ['open', secondStatus].sort(),
      );

      const failure = await applyMigration(db, migration);
      expect(failure, `${group}：存量重复时迁移须失败`).not.toBeNull();
      expect((failure as { code?: unknown }).code, `${group}：${String(failure)}`).toBe('23505');
      expect(String((failure as { message?: unknown }).message), group).toContain(INDEX);

      expect(await businessRows(db), `${group}：回滚后两张单与两条冻结逐行不变`).toEqual(before);
      expect(
        (await indexes(db, 'recon_diffs')).map((index) => index.name),
        `${group}：回滚后索引不存在`,
      ).not.toContain(INDEX);
    } finally {
      await scratch.drop();
    }
  }
}, 120_000);

it('[AC-B2-02zc#13] 迁移遇无重复存量：无该索引的库里只有一张未结 ledger_mismatch 与其一条生效冻结（released_at 为空）→ 执行迁移文件原文成功，索引存在、唯一、有效；差错单与冻结逐字段与迁移前相同（迁移不解除冻结、不改写差错单）', async () => {
  const migration = unresolvedMigrationFile();
  const scratch = await preIndexDatabase();
  try {
    const db = scratch.db;
    const refId = `01:${randomUUID()}`;
    const diff = recon({
      ref_type: 'ledger_account',
      ref_id: refId,
      period: '2032-06-15',
      status: 'open',
      dedupe_key: `R3:2032-06-15:${refId}`,
    });
    await seedTicketWithHold(db, diff, '无重复');
    const before = await businessRows(db);
    expect(before.diffs).toHaveLength(1);
    expect(before.holds).toHaveLength(1);
    expect(before.holds[0]!.released_at, '迁移前冻结生效').toBeNull();

    const failure = await applyMigration(db, migration);
    expect(failure, `无重复存量时迁移须成功：${String(failure)}`).toBeNull();

    const found = (await indexes(db, 'recon_diffs')).filter((index) => index.name === INDEX);
    expect(found, '迁移后索引存在').toHaveLength(1);
    expect(found[0]).toMatchObject({ unique: true, valid: true });
    expect(await businessRows(db), '差错单与冻结逐字段与迁移前相同').toEqual(before);
  } finally {
    await scratch.drop();
  }
}, 60_000);
