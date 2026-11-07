// B2-04zza: app_id isolation (ADR-0001 §4). Two apps in one database, each with a CREDITED order
// in the same shape — self held at credit then banned (open first_credit obligation), the rights
// success waiting for the union (WAIT_COMMISSION). The union's new record answers app A's order
// only: app A is posted as R10 with its obligation forfeited and its rights record closed; app B's
// rows (vouchers, balances, order, obligation, beneficiary events, rights record, pending row,
// history, events) stay exactly as they were. order_keys and users are keyed without app_id in the
// schema, so the two apps cannot share a sub-order id or a user id; the orders are otherwise alike.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { LATER, TIMEOUT, databaseFixture, harness, people } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zza#14] 两个 App 各有一单同形订单（本人入账时冻结后封禁、维权等佣金）：联盟新结算记录 600 只回应 App A → A 按 R10 记账、义务没收、维权记录关闭；App B 的凭证、余额、订单、义务、forfeited 事件、维权记录、待处理行一律不变',
  async () => {
    const a = await harness(p.db);
    const b = await harness(p.db);
    expect(a.appId).not.toBe(b.appId);
    const spec = { people: people({ self: 'frozen' }) };
    const left = await a.waiting(spec, (seeded) => a.setState(seeded, 'self', 'banned'));
    const right = await b.waiting(spec, (seeded) => b.setState(seeded, 'self', 'banned'));
    const keys = await a.orderVoucherKeys(left.o);
    const untouched = await b.everything();

    a.clock.set(LATER);
    b.clock.set(LATER);
    const { result } = await a.arrive(left.o, { settleAfter: 600n, newSeq: 3 });

    expect(result).toMatchObject({ outcome: 'settle_adjusted', transition: 'R10' });
    await a.expectAdjusted(left.o, keys, 3, {
      users: { direct: 34n, indirect: 17n },
      platform: -76n,
    });
    expect(await a.orderObligations(left.o)).toEqual([
      expect.objectContaining({ status: 'forfeited', closed_by: 'R10' }),
    ]);
    await a.expectAnswered(left.o, left.waitingId);

    expect(await b.everything()).toEqual(untouched);
    expect(await b.onlyRights(right.o)).toMatchObject({
      id: right.waitingId,
      status: 'WAIT_COMMISSION',
    });
    expect(await b.orderObligations(right.o)).toEqual([
      expect.objectContaining({ kind: 'first_credit', status: 'open' }),
    ]);
    expect(b.heldAlerts()).toEqual([]);
  },
  TIMEOUT,
);
