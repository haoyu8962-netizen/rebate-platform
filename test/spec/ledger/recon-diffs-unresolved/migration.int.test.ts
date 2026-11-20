// B2-02zc: the migration itself (D10-2224 B ①). recon_diffs_unresolved_internal_key is a partial
// unique index (app_id, type, ref_id) WHERE type = 'ledger_mismatch' AND status IN ('open',
// 'processing'), named in its own migration (located by file-name suffix); in the database a second
// unresolved ledger_mismatch of the same app and ref_id is refused with 23505 whatever its period,
// a concluded one is accepted, and other types, apps and refs are not affected.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
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
import { CONCLUDED, INDEX, UNRESOLVED, unresolvedMigrationSource } from './kit.ts';

const h = harness(createTestDatabase);

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
