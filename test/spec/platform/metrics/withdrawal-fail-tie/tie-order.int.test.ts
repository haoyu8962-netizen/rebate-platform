// B2-09zk (FU-B209ZJ-TIE-ORDER): fills the S1 of B2-09zj's rule-test review r6 — W5 / W6 sharing one
// updated_at are ordered by id ascending (BR-WDR-24 第二项「按 W5 / W6 迁移时间排序，连续 3 次 W6」;
// 编排裁定 D10-1203: couli_withdrawals_w6_streak orders the app's W5 / W6 by (updated_at, id)
// ascending, cuts them into runs of consecutive W6 at each W5 and takes the longest run whose last W6
// has updated_at ∈ (now − 24h, now] of the injected clock, counted whole). B2-09zj's tests only ever
// use distinct instants, so a reader breaking ties by id descending (or by insertion order, or by
// created_at) passed them; these two cases tell the orders apart.
// W6 = FAILED with manual_resolution empty; W5 = PAID_API with manual_resolution empty and no
// transfer attempt with result fail; the transition instant is withdrawals.updated_at (D10-1186).
// The withdrawals of the tie are written here with fixed ids (fail-harness's insertOutcome draws a
// random id), in the same shape as insertOutcome's W5 / W6; they are inserted larger id first, and
// the smaller id gets the later created_at, so neither insertion order nor created_at gives the id
// order. B2-09zj's kit under ../withdrawal-fail/ is imported read only, not changed.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { readPayoutWithdrawalFail } from '../../../../../apps/api/src/modules/payout/index.ts';
import { insertUser } from '../../fund-metrics/kit.ts';
import { readOnlyUrl } from '../kit.ts';
import { HOUR_MS, NOW, clockAt, shift } from '../water-level/water-harness.ts';
import {
  expectCounts,
  insertOutcome,
  minutesFromNow,
  valuesOf,
  type FailHandles,
} from '../withdrawal-fail/fail-harness.ts';

async function open() {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  const payout = createDb({ connectionString: database.urlFor('couli_payout'), max: 2 });
  const readOnly = createDb({ connectionString: readOnlyUrl(database), max: 2 });
  const handles: FailHandles = { db, payout };
  return {
    handles,
    db,
    readOnly,
    async close() {
      await destroyDb(readOnly);
      await destroyDb(payout);
      await destroyDb(db);
      await database.drop();
    },
  };
}

/**
 * One W5 or W6 (alipay) with a fixed id, satisfying every CHECK, shaped like fail-harness's
 * insertOutcome: W5 = PAID_API, paid_at = updated_at = `at`, one transfer attempt with result
 * success; W6 = FAILED, one transfer attempt with result fail at `at`; manual_resolution empty and
 * needs_manual false for both.
 */
async function insertWithId(
  h: FailHandles,
  row: {
    readonly id: string;
    readonly appId: string;
    readonly outcome: 'W5' | 'W6';
    readonly at: string;
    readonly createdAt: string;
  },
): Promise<void> {
  const user = await insertUser(h.db, row.appId);
  const outBizNo = row.id.replaceAll('-', '');
  const w5 = row.outcome === 'W5';
  await sql`INSERT INTO app.withdrawals
      (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
       payee_name, payee_account_cipher, payee_hmac, status, out_biz_no, payout_channel, paid_at,
       manual_entry_by, manual_confirm_by, reject_reason_code, needs_manual, manual_resolution,
       hold_reason, hold_at, created_at, updated_at)
    VALUES (${row.id}::uuid, ${row.appId}, ${user}, ${100_000n}, ${0n}, ${0n}, ${100_000n},
      'SERVICE_FEE', 'alipay', 'synthetic', ${Buffer.from('synthetic-cipher')}, ${'a'.repeat(64)},
      ${w5 ? 'PAID_API' : 'FAILED'}, ${outBizNo}, 'alipay', ${w5 ? row.at : null}::timestamptz,
      NULL, NULL, NULL, false, NULL, NULL, NULL,
      ${row.createdAt}::timestamptz, ${row.at}::timestamptz)`.execute(h.db);
  await sql`INSERT INTO app.payout_attempts
      (id, app_id, withdrawal_id, kind, request, result, at)
    VALUES (${randomUUID()}, ${row.appId}, ${row.id}::uuid,
      'transfer', ${JSON.stringify({ out_biz_no: outBizNo })}::jsonb,
      ${w5 ? 'success' : 'fail'}, ${row.at}::timestamptz)`.execute(h.payout);
}

/** The ids of the app's W5 / W6 at `at`, in PostgreSQL's own uuid order. */
async function idsAt(db: FailHandles['db'], appId: string, at: string): Promise<string[]> {
  const result = await sql<{ id: string }>`SELECT id::text AS id FROM app.withdrawals
    WHERE app_id = ${appId} AND updated_at = ${at}::timestamptz ORDER BY id ASC`.execute(db);
  return result.rows.map((r) => r.id);
}

/**
 * Seeds one app: W6 at NOW − 120 min and NOW − 90 min (random ids, distinct instants), then a W5 and
 * a W6 both with updated_at NOW − 60 min and the given fixed ids, the larger id inserted first and
 * created_at ordered against the ids. Checks that PostgreSQL itself orders the two ids as given.
 */
async function seedTie(
  t: Awaited<ReturnType<typeof open>>,
  appId: string,
  tie: { readonly w5Id: string; readonly w6Id: string },
): Promise<void> {
  await insertOutcome(t.handles, { appId, outcome: 'W6', at: minutesFromNow(-120) });
  await insertOutcome(t.handles, { appId, outcome: 'W6', at: minutesFromNow(-90) });
  const at = minutesFromNow(-60);
  const rows = [
    { id: tie.w5Id, appId, outcome: 'W5' as const, at },
    { id: tie.w6Id, appId, outcome: 'W6' as const, at },
  ].sort((x, y) => (x.id < y.id ? 1 : -1));
  // rows[0] has the larger id: inserted first and created earlier (3 h before), the smaller id an
  // hour later (2 h before).
  await insertWithId(t.handles, { ...rows[0]!, createdAt: shift(at, -3 * HOUR_MS) });
  await insertWithId(t.handles, { ...rows[1]!, createdAt: shift(at, -2 * HOUR_MS) });
  expect(await idsAt(t.db, appId, at), 'the tie in uuid order').toEqual([rows[1]!.id, rows[0]!.id]);
}

it('[AC-B2-09zk#1] 同一 updated_at 的 W5 / W6 按 id 升序成段（D10-1203）：窗口内先两笔 W6（NOW−120min、NOW−90min），再在 NOW−60min 同一时刻落 W5 与 W6、W5 的 id 小于 W6 的 id（先插 id 大的、id 小的建单更晚）→ 按 (updated_at, id) 升序为 W6 W6 W5 W6，最长连续 2（不是 3）', async () => {
  const t = await open();
  try {
    const appId = 'fail_tie_w5_first';
    await seedTie(t, appId, {
      w5Id: '10000000-0000-4000-8000-000000000001',
      w6Id: 'e0000000-0000-4000-8000-000000000002',
    });

    const values = await readPayoutWithdrawalFail(t.readOnly, clockAt(NOW));
    expectCounts(values, `at ${NOW}`);
    expect(valuesOf(values, appId).w6Streak, 'W6 W6 W5 W6: the longest run is 2').toBe(2);
    expect(valuesOf(values, appId), 'W6 3, W5 + W6 4 today, run 2').toEqual({
      w6Today: 3,
      w5w6Today: 4,
      w6Streak: 2,
    });
  } finally {
    await t.close();
  }
}, 120_000);

it('[AC-B2-09zk#2] 同一 updated_at 的 W5 / W6 按 id 升序成段（D10-1203）：同样排列，但 W6 的 id 小于 W5 的 id（先插 id 大的、id 小的建单更晚）→ 按 (updated_at, id) 升序为 W6 W6 W6 W5，最长连续 3（不是 2）', async () => {
  const t = await open();
  try {
    const appId = 'fail_tie_w6_first';
    await seedTie(t, appId, {
      w5Id: 'e0000000-0000-4000-8000-000000000004',
      w6Id: '10000000-0000-4000-8000-000000000003',
    });

    const values = await readPayoutWithdrawalFail(t.readOnly, clockAt(NOW));
    expectCounts(values, `at ${NOW}`);
    expect(valuesOf(values, appId).w6Streak, 'W6 W6 W6 W5: the longest run is 3').toBe(3);
    expect(valuesOf(values, appId), 'W6 3, W5 + W6 4 today, run 3').toEqual({
      w6Today: 3,
      w5w6Today: 4,
      w6Streak: 3,
    });
  } finally {
    await t.close();
  }
}, 120_000);
