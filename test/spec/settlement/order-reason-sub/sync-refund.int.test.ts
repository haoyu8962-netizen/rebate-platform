// B2-04zze rule tests: an order sync that voids an uncredited order as PLATFORM_INVALID (R6, reason
// REFUND, written by settlement's rebate port onUpdated) also writes the REFUND sub-reason by the
// platform status the order had before it went invalid (orchestrator D10-862 ②: 确认收货前 PAID /
// DEPOSIT_PAID → IN_SALE，已结算 → AFTER_SETTLE，确认收货后、结算前 → 不写; ③ 京东、拼多多一律不写;
// 08 BR-TEXT-05: 人工选过的不被自动覆盖，子原因只改说明，不改金额、父编码与状态迁移; 子原因必须属于当前父编码).
// The B2-04j rebate fixture is reused read-only: one order per fixture, commission's valuation port
// a double, the sync change and status source written by hand.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture, noMoney, type OrderPatch } from '../rebate/kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

interface InvalidCase {
  /** rebate_status before the sync (an uncredited state). */
  readonly state: 'UNATTRIBUTED' | 'ESTIMATED' | 'WAITING';
  /** platform_status before the sync (change.from_status). */
  readonly from: 'PAID' | 'DEPOSIT_PAID' | 'RECEIVED' | 'SETTLED';
  /** platform_status the sync wrote (P7 keeps SETTLED). */
  readonly to: 'INVALID' | 'SETTLED';
  readonly rule: string | null;
}

const CASES: readonly (readonly [InvalidCase, string | null])[] = [
  [{ state: 'ESTIMATED', from: 'PAID', to: 'INVALID', rule: 'P6' }, 'IN_SALE'],
  [{ state: 'UNATTRIBUTED', from: 'PAID', to: 'INVALID', rule: 'P6' }, 'IN_SALE'],
  [{ state: 'ESTIMATED', from: 'DEPOSIT_PAID', to: 'INVALID', rule: null }, 'IN_SALE'],
  [{ state: 'WAITING', from: 'RECEIVED', to: 'INVALID', rule: 'P6' }, null],
  [{ state: 'WAITING', from: 'SETTLED', to: 'SETTLED', rule: 'P7' }, 'AFTER_SETTLE'],
];

/** One PLATFORM_INVALID sync on a fresh order; returns the voided row. */
async function invalidate(platform: string, c: InvalidCase, patch: OrderPatch = {}) {
  const f = await fixture(db, {
    platform,
    rebate_status: c.state,
    platform_status: c.to,
    ...patch,
  });
  await f.update(
    { from_status: c.from, to_status: c.to, rule: c.rule },
    { event: 'PLATFORM_INVALID', raw_status: 'synthetic-invalid' },
  );
  const row = await f.read();
  // Unchanged by this task: R6 to VOID with reason REFUND, one history row, one event, no money.
  expect(row, `${platform} ${c.state} ${c.from}`).toMatchObject({
    rebate_status: 'VOID',
    reason: 'REFUND',
    platform_status: c.to,
  });
  expect((await f.history()).map((r) => [r.from_status, r.event, r.to_status])).toEqual([
    [c.state, 'PLATFORM_INVALID', 'VOID'],
  ]);
  expect(f.publish).toHaveBeenCalledTimes(1);
  await noMoney(db, f);
  return row;
}

it('[AC-B2-04zze#24] 淘宝入账前订单同步失效（原因码 REFUND）：失效前未确认收货（PAID / DEPOSIT_PAID）→ IN_SALE；确认收货后、结算前（RECEIVED）→ 不写；已结算（SETTLED，P7）→ AFTER_SETTLE', async () => {
  const subs: (string | null)[] = [];
  for (const [c] of CASES) {
    const row = await invalidate('taobao', c);
    expect(row.reason_sub_manual).toBe(false);
    subs.push(row.reason_sub);
  }
  expect(subs).toEqual(CASES.map(([, sub]) => sub));
}, 180_000);

it('[AC-B2-04zze#25] 京东、拼多多入账前订单同步失效：无论失效前状态，子原因一律不写（null）；同样的淘宝单（PAID → INVALID）写 IN_SALE', async () => {
  for (const platform of ['jd', 'pdd']) {
    for (const [c] of CASES) {
      const row = await invalidate(platform, c);
      expect(row.reason_sub, `${platform} ${c.from}`).toBeNull();
    }
  }
  const [paid] = CASES[0]!;
  expect((await invalidate('taobao', paid)).reason_sub).toBe('IN_SALE');
}, 180_000);

it('[AC-B2-04zze#26] 人工选过子原因的淘宝单（reason_sub_manual=true）同步失效：原因码照写 REFUND，人工子原因（AFTER_SETTLE，或人工选的「无」= null）不被覆盖；未人工选的同类单写 IN_SALE', async () => {
  const [paid] = CASES[0]!;
  const picked = await invalidate('taobao', paid, {
    reason_sub_manual: true,
    reason_sub: 'AFTER_SETTLE',
  });
  expect(picked).toMatchObject({ reason_sub: 'AFTER_SETTLE', reason_sub_manual: true });
  const none = await invalidate('taobao', paid, { reason_sub_manual: true, reason_sub: null });
  expect(none).toMatchObject({ reason_sub: null, reason_sub_manual: true });
  const auto = await invalidate('taobao', paid);
  expect(auto).toMatchObject({ reason_sub: 'IN_SALE', reason_sub_manual: false });
}, 180_000);

it('[AC-B2-04zze#27] 子原因必须属于当前父编码：订单上残留的 PUNISH 子原因（非人工 FAKE_TRADE）在同步失效写 REFUND 时不留下——未收货失效改写为 IN_SALE，收货后结算前失效为 null', async () => {
  const [paid] = CASES[0]!;
  const [received] = CASES[3]!;
  const stale = { reason_sub: 'FAKE_TRADE' } as const;
  expect((await invalidate('taobao', paid, stale)).reason_sub).toBe('IN_SALE');
  expect((await invalidate('taobao', received, stale)).reason_sub).toBeNull();
}, 180_000);
