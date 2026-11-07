// B2-04zi: only synthetic setup and observations; the path under test is the assembled worker.
// Expected money is supplied by each test, never obtained from the adjustment planner.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { addFen } from '@couli/money';
import { sql, type Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { seedVersion, version } from '../../commission/snapshot/fixtures.ts';
import * as workerPorts from '../../risk/freeze-expiry/kit.ts';
import {
  BILL_AT,
  SYNCED,
  settled,
  withWorker,
  type App,
  type Worker,
} from '../settlement-records/kit.ts';

export { databaseFixture } from '../credit/kit.ts';
export { TIMEOUT, settled, touched, SETTLED_LATER, capture } from '../settlement-records/kit.ts';
export type { App, Worker } from '../settlement-records/kit.ts';
export type SyncedOrder = ReturnType<Worker['order']>;

// settlement-records/kit.ts 的 w.order(app) 使用会员自己的归属码，受益人角色为 share。
export const MEMBER_ROLE = 'share';

/** Observe the existing fixture's pino destination, without replacing application services. */
export async function withSync(
  db: Kysely<DB>,
  test: (w: Worker, logs: Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
  const original = workerPorts.ports;
  const logs: Record<string, unknown>[] = [];
  const spy = vi.spyOn(workerPorts, 'ports').mockImplementation(async () => {
    const p = await original();
    // The fixture already stores each complete pino line here.
    const push = p.lines.push.bind(p.lines);
    p.lines.push = (...lines: string[]) => {
      for (const line of lines) logs.push(JSON.parse(line) as Record<string, unknown>);
      return push(...lines);
    };
    return p;
  });
  try {
    await withWorker(db, (w) => test(w, logs));
  } finally {
    spy.mockRestore();
  }
}

/** Real sync → monthly bill → R5. A frozen member still has an open first-credit obligation. */
export async function credited(
  db: Kysely<DB>,
  w: Worker,
  options: { app?: App; n?: bigint; reserveBp?: number; held?: boolean } = {},
) {
  // Each independent app's initial record must predate its bill, including multi-app tests.
  w.clock.set(SYNCED);
  const app = options.app ?? (await w.app());
  const n = options.n ?? 1000n;
  if (options.reserveBp !== undefined) {
    // Published rules are insert-only for couli_app. Select a later applicable version, never
    // update an existing rule or an order's immutable attribution snapshot.
    await seedVersion(
      db,
      app.appId,
      version({
        effective_from: new Date('2026-10-02T00:00:00+08:00'),
        reserves: [
          { platform: 'taobao', reserve_bp: 0 },
          { platform: 'jd', reserve_bp: 0 },
          { platform: 'pdd', reserve_bp: options.reserveBp },
        ],
      }),
    );
  }
  await w.setConfig(app, 'credit.enabled.pdd', true);
  const o = w.order(app, { est_commission_fen: n, commission_fen: n });
  await o.sync(settled(n));
  if (options.held === true) await risk(db, w, app, 'frozen');
  w.clock.set(BILL_AT);
  await w.bill(app);
  await w.confirmAndExecute(app);
  expect(await o.row()).toMatchObject({ rebate_status: 'CREDITED', booked_n_fen: n });
  return { app, o, read: observations(db, app, o) };
}

export function observations(db: Kysely<DB>, app: App, o: SyncedOrder) {
  const orderRef = `pdd:${o.subOrderId}`;
  const vouchers = () =>
    db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .select(sql<string>`to_char(accounting_date, 'YYYY-MM-DD')`.as('accounting_day'))
      .where('app_id', '=', app.appId)
      .where('order_key', '=', orderRef)
      .orderBy('uniq_key')
      .execute();
  const lines = () =>
    db
      .selectFrom('ledger_entries as e')
      .innerJoin('ledger_vouchers as v', (j) =>
        j.onRef('v.id', '=', 'e.voucher_id').onRef('v.app_id', '=', 'e.app_id'),
      )
      .innerJoin('ledger_accounts as a', (j) =>
        j.onRef('a.id', '=', 'e.account_id').onRef('a.app_id', '=', 'e.app_id'),
      )
      .select([
        'v.uniq_key',
        'a.subject',
        'a.owner_id',
        'e.amount_fen',
        'e.sub_account',
        'e.ledger_type',
        'e.sub_type',
        'e.booked_at',
      ])
      .where('v.app_id', '=', app.appId)
      .where('v.order_key', '=', orderRef)
      .orderBy('e.id')
      .execute();
  const history = async () =>
    db
      .selectFrom('order_status_history')
      .selectAll()
      .where('app_id', '=', app.appId)
      .where('order_id', '=', (await o.row()).order_id)
      .where('field', '=', 'rebate')
      .where('from_status', '=', 'CREDITED')
      .orderBy('id')
      .execute();
  const obligations = async () =>
    db
      .selectFrom('beneficiary_credits')
      .selectAll()
      .where('app_id', '=', app.appId)
      .where('order_id', '=', (await o.row()).order_id)
      .orderBy('beneficiary_credit_id')
      .execute();
  const candidates = async () =>
    db
      .selectFrom('settle_adjustments')
      .selectAll()
      .where('app_id', '=', app.appId)
      .where('order_id', '=', (await o.row()).order_id)
      .execute();
  const balance = () =>
    db
      .selectFrom('account_balances as b')
      .innerJoin('ledger_accounts as a', (j) =>
        j.onRef('a.app_id', '=', 'b.app_id').onRef('a.id', '=', 'b.account_id'),
      )
      .select(['b.available_fen', 'b.frozen_fen'])
      .where('b.app_id', '=', app.appId)
      .where('a.owner_id', '=', app.userId)
      .where('a.owner_type', '=', 'user')
      .executeTakeFirstOrThrow();
  const events = async () =>
    db
      .selectFrom('commission_split_beneficiary_events')
      .selectAll()
      .where('app_id', '=', app.appId)
      .where('order_id', '=', (await o.row()).order_id)
      .orderBy('event_seq')
      .execute();
  async function money() {
    const row = await o.row();
    return {
      vouchers: await vouchers(),
      lines: await lines(),
      balance: await balance(),
      history: await history(),
      obligations: await obligations(),
      candidates: await candidates(),
      booked: [row.booked_base_fen, row.booked_n_fen],
      status: row.rebate_status,
    };
  }
  async function balanced() {
    const all = await lines();
    const sums = new Map<string, bigint>();
    for (const line of all)
      sums.set(line.uniq_key, addFen(sums.get(line.uniq_key) ?? 0n, line.amount_fen));
    expect(sums.size).toBeGreaterThan(0);
    expect([...sums.values()]).toEqual([...sums].map(() => 0n));
    expect([...sums.keys()].sort()).toEqual((await vouchers()).map((v) => v.uniq_key).sort());
  }
  async function adjustment(
    seq: number,
    userDebit: bigint,
    platformDebit: bigint,
    userSubject = 'USER_BALANCE',
  ) {
    const suffix = `:ADJ:${seq}`;
    const actual = (await lines()).filter((line) => line.uniq_key.endsWith(suffix));
    const expected: string[] = [];
    for (const [part, subject, owner, debit] of [
      [
        `${app.userId}:${MEMBER_ROLE}`,
        userSubject,
        userSubject === 'USER_BALANCE' ? app.userId : 'platform',
        userDebit,
      ],
      ['PLATFORM', 'COMMISSION_REVENUE', 'platform', platformDebit],
    ] as const) {
      if (debit === 0n) continue;
      expected.push(
        `${orderRef}:${part}${suffix}|${subject}|${owner}|${debit}`,
        `${orderRef}:${part}${suffix}|UNION_RECEIVABLE:pdd|platform|${-debit}`,
      );
    }
    expect(
      actual.map((l) => `${l.uniq_key}|${l.subject}|${l.owner_id}|${l.amount_fen}`).sort(),
    ).toEqual(expected.sort());
    expect(actual.map((l) => [l.ledger_type, l.sub_type, l.sub_account])).toEqual(
      expected.map(() => ['SETTLE_ADJUST', 'SETTLE_DIFF', 'available']),
    );
    expect(
      (await vouchers()).filter((v) => v.uniq_key.endsWith(suffix)).map((v) => v.voucher_kind),
    ).toEqual(expected.filter((_, i) => i % 2 === 0).map(() => 'SETTLE_ADJUST'));
    await balanced();
  }
  return {
    orderRef,
    vouchers,
    lines,
    history,
    obligations,
    candidates,
    balance,
    events,
    money,
    balanced,
    adjustment,
  };
}

export async function risk(
  db: Kysely<DB>,
  w: Worker,
  app: App,
  state: 'normal' | 'frozen' | 'appealing' | 'banned',
) {
  const values = {
    state,
    reason_category: state === 'normal' ? null : 'other',
    changed_at: w.clock.now(),
  };
  await db
    .insertInto('user_risk_state')
    .values({
      app_id: app.appId,
      user_id: app.userId,
      ...values,
      changed_by: 'fixture',
      reason: null,
      frozen_until: null,
    })
    .onConflict((oc) => oc.column('user_id').doUpdateSet(values))
    .execute();
}

/** Historical ledger state only. No direct balance writes. */
export async function moveUserFunds(
  db: Kysely<DB>,
  w: Worker,
  app: App,
  o: SyncedOrder,
  mode: 'freeze' | 'past-clawback',
) {
  const ledger = createLedger({ clock: w.clock });
  await db.transaction().execute(async (trx) => {
    const [account] = await ledger.lockBalances(trx, { appId: app.appId, userIds: [app.userId] });
    expect(account).toBeDefined();
    const historical = mode === 'past-clawback';
    const type = historical ? 'CLAWBACK' : 'WITHDRAW_FREEZE';
    await ledger.post(trx, {
      appId: app.appId,
      uniqKey: `fixture:${randomUUID()}`,
      bizType: type,
      bizId: randomUUID(),
      operator: 'system',
      memo: null,
      orderKey: historical ? `pdd:${o.subOrderId}` : null,
      beneficiaryUserId: historical ? app.userId : null,
      role: historical ? MEMBER_ROLE : null,
      voucherKind: type,
      entries: [
        {
          account: { ownerType: 'user', accountId: account!.account_id },
          sub_account: 'available',
          amount_fen: 500n,
          ledger_type: type,
          sub_type: historical ? 'PART_REFUND' : null,
          income_type: null,
        },
        {
          account: historical
            ? { ownerType: 'platform', subject: 'COMMISSION_REVENUE' }
            : { ownerType: 'user', accountId: account!.account_id },
          sub_account: historical ? 'available' : 'frozen',
          amount_fen: -500n,
          ledger_type: type,
          sub_type: historical ? 'PART_REFUND' : null,
          income_type: null,
        },
      ],
    });
  });
}
