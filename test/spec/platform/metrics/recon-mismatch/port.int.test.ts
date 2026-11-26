import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { readChannelMismatchOpen } from '../../../../../apps/api/src/modules/ledger/index.ts';
import { readSettleBillMismatch } from '../../../../../apps/api/src/modules/settlement/index.ts';
import { readOnlyUrl } from '../kit.ts';

async function open() {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  const readOnly = createDb({ connectionString: readOnlyUrl(database), max: 2 });
  return {
    db,
    readOnly,
    async close() {
      await destroyDb(readOnly);
      await destroyDb(db);
      await database.drop();
    },
  };
}

type DiffOptions = {
  type?: 'channel_mismatch' | 'ledger_mismatch' | 'union_mismatch';
  status?: 'open' | 'processing' | 'adjusted' | 'written_off' | 'closed';
  source?: 'R1' | 'R2' | 'R3' | 'R4';
  period?: string;
  refType?: string;
  refId?: string;
};

async function insertDiff(db: Kysely<DB>, appId: string, options: DiffOptions = {}) {
  const id = randomUUID();
  const {
    type = 'channel_mismatch',
    status = 'open',
    source = 'R2',
    period = '2025-12-31',
    refType = 'withdrawal',
    refId = id,
  } = options;
  const at = '2026-01-01T00:00:00Z';
  const closedAt = status === 'open' || status === 'processing' ? null : at;
  await sql`INSERT INTO app.recon_diffs
    (id, app_id, type, source, period, ref_type, ref_id, expected_fen, actual_fen,
     diff_fen, status, closed_at, dedupe_key, created_at, updated_at)
    VALUES (${id}, ${appId}, ${type}, ${source}, ${period}, ${refType}, ${refId},
      101, 100, 1, ${status}, ${closedAt}::timestamptz, ${`fixture:${id}`},
      ${at}::timestamptz, ${at}::timestamptz)`.execute(db);
}

it('[AC-B2-09zn#14] 只读会话按 app_id 统计 open 和 processing 的通道差错单，按行计数且表内容不变', async () => {
  const { db, readOnly, close } = await open();
  try {
    await insertDiff(db, 'mixed', { refId: 'one-withdrawal' });
    await insertDiff(db, 'mixed', {
      status: 'processing',
      period: '2025-11-30',
      refId: 'one-withdrawal',
    });
    await insertDiff(db, 'mixed', { refType: 'channel_order_id', refId: 'channel-line-17' });
    await insertDiff(db, 'mixed', { source: 'R3' });
    await insertDiff(db, 'other', { status: 'processing', source: 'R1', refType: 'voucher' });
    for (const status of ['adjusted', 'written_off', 'closed'] as const) {
      await insertDiff(db, 'mixed', { status });
      await insertDiff(db, 'resolved_only', { status });
    }
    for (const type of ['ledger_mismatch', 'union_mismatch'] as const) {
      await insertDiff(db, 'mixed', { type });
      await insertDiff(db, 'other_types_only', { type, status: 'processing' });
    }

    const rows = () => sql`SELECT to_jsonb(d) FROM app.recon_diffs d ORDER BY id`.execute(db);
    const before = await rows();
    expect(await readChannelMismatchOpen(readOnly)).toEqual({ open: { mixed: 4, other: 1 } });
    expect((await rows()).rows).toEqual(before.rows);
  } finally {
    await close();
  }
}, 60_000);

async function insertBill(
  db: Kysely<DB>,
  appId: string,
  billId: string,
  generatedAt: string | null,
  mismatchCount: number | null,
) {
  await sql`INSERT INTO app.settle_bills
    (app_id, bill_id, generation_started_at, generated_at, amount_mismatch_count)
    VALUES (${appId}, ${billId}, '2025-11-01T00:00:00Z'::timestamptz,
      ${generatedAt}::timestamptz, ${mismatchCount})`.execute(db);
}

it('[AC-B2-09zn#15] 只读会话逐 app 选已出账的最大 bill_id，最新计数为 NULL 时不回退，零值保留，出账时间向下取整为秒', async () => {
  const { db, readOnly, close } = await open();
  try {
    const generatedAt = '2026-01-01T00:00:00.987Z';
    // The older period finished later, so sorting by completion time picks the wrong bill.
    await insertBill(db, 'latest', '2025-10', '2026-01-03T00:00:00Z', 90);
    await insertBill(db, 'latest', '2025-12', generatedAt, 2);
    await insertBill(db, 'latest', '2026-01', null, 15);

    await insertBill(db, 'zero', '2025-11', '2025-12-01T00:00:00.999Z', 0);
    await insertBill(db, 'null_latest', '2025-11', '2025-12-02T00:00:00Z', 5);
    await insertBill(db, 'null_latest', '2025-12', '2026-01-02T00:00:00Z', null);
    await insertBill(db, 'unfinished_only', '2026-02', null, null);

    const rows = sql`SELECT to_jsonb(b) FROM app.settle_bills b ORDER BY app_id, bill_id`;
    const before = await rows.execute(db);
    const snapshot = await readSettleBillMismatch(readOnly);
    expect(snapshot).toEqual({
      bills: {
        latest: { amountMismatch: 2, generatedAtSeconds: 1_767_225_600 },
        zero: { amountMismatch: 0, generatedAtSeconds: 1_764_547_200 },
      },
    });
    const seconds = Math.floor(Date.parse(generatedAt) / 1000);
    expect(snapshot.bills['latest']?.generatedAtSeconds).toBe(seconds);
    expect((await rows.execute(db)).rows).toEqual(before.rows);
  } finally {
    await close();
  }
}, 60_000);
