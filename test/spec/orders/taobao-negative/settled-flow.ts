// B1-04zw: a Taobao order through the real adapter over a fake transport, then the real pipeline,
// update step and commission snapshot on the test database. The rows are raw upstream rows, so the
// amounts the pipeline sees are the adapter's. All values are synthetic.
//
// The path is the one where a settled amount can reach the snapshot: the first import of a paid row
// stays unattributed, then the settled row attributes it (P5). A first import writes no
// settle_commission_fen (pipeline-port.ts), and an order attributed earlier already has its snapshot.
//
// specs/order-status-map has no taobao.csv yet, so raw_status is swapped for the labels of the
// attribution fixture's status map: tk_status mapping is not what these tests look at.
import { randomBytes } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import type { CallCtx, UnionOrder } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  beneficiaries as threeParties,
  seedVersion,
  version,
} from '../../commission/snapshot/fixtures.ts';
import { ctx, listed, num, onePage, row, setup, win } from '../../union/taobao-orders/kit.ts';
import { at, scenario, type SnapshotPort } from '../commission-snapshot/db-kit.ts';

// Same public runtime import as commission-snapshot/real-kit.ts: avoid pulling Nest controllers
// into the test project's erasable-syntax-only type graph.
const { createCommissionSnapshot, createInMemoryBeneficiaryResolver } = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  createCommissionSnapshot: typeof import('../../../../apps/api/src/modules/commission/application/snapshot.ts').createCommissionSnapshot;
  createInMemoryBeneficiaryResolver: typeof import('../../../../apps/api/src/modules/commission/infra/in-memory-beneficiary-resolver.ts').createInMemoryBeneficiaryResolver;
};

/** What the order sync passes (fetchWindow): the run these tests stand for. */
const COLLECT: CallCtx = { ...ctx, rowErrors: 'collect' };

const RELATION_ID = '3200000001';

/** Times inside the attribution fixture's world (its clock is 2026-10-17T17:30:00Z). */
const COMMON_ROW = {
  relation_id: num(RELATION_ID),
  tk_create_time: '2026-10-15 10:00:01',
  tk_paid_time: '2026-10-15 10:00:05',
  tb_paid_time: '2026-10-15 10:00:05',
  click_time: '2026-10-15 09:58:00',
};

const PAID_ROW = {
  ...COMMON_ROW,
  tk_status: num('12'),
  tk_earning_time: '--',
  pub_share_fee: '0.00',
  modified_time: '2026-10-15 10:10:00',
};

const SETTLED_ROW = {
  ...COMMON_ROW,
  tk_status: num('3'),
  tk_earning_time: '2026-10-17 11:00:00',
  modified_time: '2026-10-17 11:05:00',
};

/** A 19-digit trade id of its own: order_keys is global across apps. */
function tradeId(): string {
  return `${2_900_000_000_000_000_000n + BigInt(`0x${randomBytes(7).toString('hex')}`)}`;
}

/** One row through the real adapter, the way the order sync reads it. */
async function throughAdapter(input: Record<string, unknown>, payloadId: string) {
  const { adapter } = setup(onePage([input], payloadId));
  const page = await listed(adapter.listOrders(win, {}, COLLECT));
  expect(page.items).toHaveLength(1);
  return page.items[0]!;
}

/** A paid order of the estimate 7.99 yuan, imported with no binding for its relation_id yet. */
export async function paidUnattributed(db: Kysely<DB>) {
  const trade_id = tradeId();
  const paid = await throughAdapter(row({ ...PAID_ROW, trade_id }), '70801');
  const f = await scenario(db, { ...paid, platform: 'taobao', raw_status: 'paid' });
  return { ...f, trade_id };
}

export type PaidFlow = Awaited<ReturnType<typeof paidUnattributed>>;

/** The relation_id is now bound to the fixture's user: the next update attributes the order. */
export function bindMember(f: PaidFlow): void {
  f.findBindings.mockResolvedValue([
    {
      user_id: f.userId,
      bound_at: at('2026-10-10T01:02:03.000Z'),
      released_at: null,
      cooldown_until: null,
    },
  ]);
}

/** The settled row of the same order with `fee` as pub_share_fee, as the pipeline receives it. */
export async function settledIncoming(f: PaidFlow, fee: string): Promise<UnionOrder> {
  const input = row({ ...SETTLED_ROW, trade_id: f.trade_id, pub_share_fee: fee });
  const settled = await throughAdapter(input, '70802');
  return f.next({ ...settled, raw_status: 'settled' });
}

/**
 * The real snapshot on a published version that covers taobao (real-kit's realPort is pdd only).
 * The order has all three parties, at the fixture version's ratios 5000 / 1000 / 500.
 */
export async function taobaoPort(db: Kysely<DB>, f: PaidFlow) {
  await seedVersion(db, f.ctx.app_id, version());
  const parties = threeParties(f.userId);
  const beneficiaries = createInMemoryBeneficiaryResolver([
    { appId: f.ctx.app_id, beneficiaries: parties },
  ]);
  const create = vi.fn<SnapshotPort['create']>((trx, input) =>
    createCommissionSnapshot(trx, input, {
      clock: f.clock,
      logger: { warn: vi.fn() },
      beneficiaries,
    }),
  );
  return { create, direct: parties.direct!.userId, indirect: parties.indirect!.userId };
}

/**
 * What each party got. commission_splits.beneficiaries freezes who and at which ratio and holds no
 * amount; the amounts are commission_split_amounts, one row per beneficiary (snapshot-store.ts).
 */
export async function shareAmounts(db: Kysely<DB>, appId: string, orderId: string) {
  return db
    .withSchema('app')
    .selectFrom('commission_split_amounts')
    .selectAll()
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .execute();
}
