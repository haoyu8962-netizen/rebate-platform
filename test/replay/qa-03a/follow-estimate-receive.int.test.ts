import { readFileSync } from 'node:fs';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { chinaMonth, settlementBillPeriod } from '@couli/domain';
import { expect, it } from 'vitest';
import { checkpoint, startReplay } from './driver.ts';
import { PAID, RECEIVED } from './stream-fixture.ts';

it('[AC-QA-03a#4] 合成数据回放：公共 HTTP 跟单→真实 window 同步预估→收货；每段台账与日终差异为零，业务量达标', async () => {
  const provenance = JSON.parse(
    readFileSync(new URL('./provenance.json', import.meta.url), 'utf8'),
  ) as {
    source: string;
    minimum_volume: { imported: number; estimated: number; received: number };
  };
  expect(provenance.source).toBe('synthetic');
  expect(provenance.minimum_volume).toEqual({ imported: 3, estimated: 3, received: 3 });
  const h = await startReplay({ createTestDatabase, acquireTestRedis });
  try {
    const followed = await h.follow();
    expect(followed.linkId).not.toBeNull();
    await checkpoint(h.db, h.clock, h.appId);
    const inputs = h.orderSeeds(followed);
    const sync = await h.syncDriver(inputs);
    const paidEnd = '2026-10-05T10:10:00+08:00';
    h.time.moveTo(paidEnd);
    // First red: existing DemoUnionAdapter.listOrders throws adapter_unimplemented, converted
    // by the driver into an assertion failure. No result row is inserted by this fixture.
    await sync(PAID, paidEnd);
    const rows = () =>
      h.db
        .selectFrom('orders')
        .selectAll()
        .where('app_id', '=', h.appId)
        .orderBy('sub_order_id')
        .execute();
    const paid = await rows();
    expect(paid.length).toBeGreaterThanOrEqual(provenance.minimum_volume.imported);
    expect(paid).toHaveLength(inputs.length);
    for (const row of paid) {
      expect(row).toMatchObject({
        user_id: h.userId,
        platform_status: 'PAID',
        rebate_status: 'ESTIMATED',
        received_at: null,
        settle_commission_fen: null,
      });
      expect(row.attr_at).toEqual(new Date(PAID));
      expect(row.link_id).toBe(followed.linkId);
      expect(row.source_match).toBe('exact');
      expect(row.est_commission_fen).toBeGreaterThan(0n);
      expect(row.commission_version).toBeGreaterThanOrEqual(1);
    }
    const amounts = () =>
      h.db
        .selectFrom('commission_split_amounts')
        .selectAll()
        .where('app_id', '=', h.appId)
        .orderBy('order_id')
        .orderBy('commission_version')
        .orderBy('role')
        .execute();
    const estimates = await amounts();
    const estimated = new Set(
      estimates
        .filter(
          (amount) =>
            paid.some(
              (order) =>
                order.order_id === amount.order_id &&
                order.commission_version === amount.commission_version,
            ) &&
            amount.user_id === h.userId &&
            amount.amount_fen > 0n,
        )
        .map((amount) => amount.order_id),
    );
    expect(estimated.size).toBeGreaterThanOrEqual(provenance.minimum_volume.estimated);
    expect(
      await h.db
        .selectFrom('commission_splits')
        .select('order_id')
        .where('app_id', '=', h.appId)
        .execute(),
    ).toHaveLength(inputs.length);
    await checkpoint(h.db, h.clock, h.appId);

    // Same window twice: neither duplicate orders nor duplicate commission versions.
    await sync(PAID, paidEnd);
    expect(await rows()).toEqual(paid);
    expect(await amounts()).toEqual(estimates);
    await checkpoint(h.db, h.clock, h.appId);

    const receiveEnd = '2026-10-08T20:10:00+08:00';
    h.time.moveTo(receiveEnd);
    await sync(RECEIVED, receiveEnd);
    const received = await rows();
    expect(
      received.filter(
        (row) => row.platform_status === 'RECEIVED' && row.rebate_status === 'WAITING',
      ).length,
    ).toBeGreaterThanOrEqual(provenance.minimum_volume.received);
    expect(received.map((row) => row.order_id)).toEqual(paid.map((row) => row.order_id));
    for (const row of received) {
      // BR-FUND-02: receipt is the supplied event time, ten minutes before our synchronization.
      expect(row.received_at).toEqual(new Date(RECEIVED));
      expect(row.received_at).not.toEqual(h.clock.now());
      expect(row.settle_period).toBe(chinaMonth(new Date(RECEIVED)));
      expect(row.settle_commission_fen).toBeNull();
      expect(row.user_id).toBe(h.userId);
      expect(row.link_id).toBe(followed.linkId);
    }
    expect(
      await h.db
        .selectFrom('order_settlements')
        .select('order_id')
        .where('app_id', '=', h.appId)
        .execute(),
    ).toEqual([]);
    expect(
      await h.db
        .selectFrom('order_sync_pending')
        .select('id')
        .where('app_id', '=', h.appId)
        .execute(),
    ).toEqual([]);
    await checkpoint(h.db, h.clock, h.appId);
    const receivedAmounts = await amounts();
    await sync(RECEIVED, receiveEnd);
    expect(await rows()).toEqual(received);
    expect(await amounts()).toEqual(receivedAmounts);
    await checkpoint(h.db, h.clock, h.appId);

    // The same old window remains deterministic after the replay advances into billing month.
    h.time.moveTo('2026-11-24T10:00:00+08:00');
    expect(settlementBillPeriod(h.clock.now())).toBe('2026-10');
    await sync(RECEIVED, receiveEnd);
    expect(await rows()).toEqual(received);
    await checkpoint(h.db, h.clock, h.appId);
  } finally {
    await h.close();
  }
}, 180_000);
