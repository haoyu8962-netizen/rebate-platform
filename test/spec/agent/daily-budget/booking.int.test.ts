import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import { usePgEach } from '../stream-recovery/kit.ts';
import { booking, DAY, dayRow, NEXT_DAY, reservationRow } from './pg-kit.ts';

const pg = usePgEach(createTestDatabase);

it('[AC-B3-09m#15] 受理用实际加预占判断，低于上限可受理，达到上限不再预占', async () => {
  const budget = booking(pg.db);
  const limit = { budgetMfen: 1_000n };
  const used = await budget.reserve({ ...limit, reserveMfen: 700n });
  await budget.settle({ runId: used.runId, live: { spentMfen: 700n, calls: 1 } });
  const crossing = await budget.reserve({ ...limit, reserveMfen: 300n });
  expect(crossing.exhausted).toBe(false);
  expect(await reservationRow(pg.db, crossing.runId)).toMatchObject({
    day: DAY,
    reserved_mfen: 300n,
    price_version: 'synthetic-v1',
    settled_at: null,
  });
  const blocked = await budget.reserve({ ...limit, reserveMfen: 300n });
  expect(blocked.exhausted).toBe(true);
  expect(await reservationRow(pg.db, blocked.runId)).toBeUndefined();
  expect(await dayRow(pg.db)).toMatchObject({ actual_mfen: 700n, reserved_mfen: 300n });
});

it('[AC-B3-09m#16] 并发受理跨过上限时只有先拿到预算的一条能预占', async () => {
  const budget = booking(pg.db);
  const limit = { budgetMfen: 1_000n };
  const prior = await budget.reserve({ ...limit, reserveMfen: 700n });
  expect(prior.exhausted).toBe(false);
  const both = await Promise.all([
    budget.reserve({ ...limit, reserveMfen: 400n }),
    budget.reserve({ ...limit, reserveMfen: 400n }),
  ]);
  expect(both.map((result) => result.exhausted).sort()).toEqual([false, true]);
  expect(await dayRow(pg.db)).toMatchObject({ actual_mfen: 0n, reserved_mfen: 1_100n });
});

it('[AC-B3-09m#17] 活进程两次调用花 700，结清只记一次实际并释放 5,000 预占', async () => {
  const budget = booking(pg.db);
  const { runId } = await budget.reserve();
  expect(await dayRow(pg.db)).toMatchObject({ actual_mfen: 0n, reserved_mfen: 5_000n });
  const settled = await budget.settle({ runId, live: { spentMfen: 700n, calls: 2 } });
  expect(settled).toMatchObject({ costMfen: 700n, priceVersion: 'synthetic-v1', settled: true });
  expect(await reservationRow(pg.db, runId)).toMatchObject({ settled_at: expect.any(Date) });
  expect(await budget.settle({ runId, live: null })).toMatchObject({ settled: false });
  expect(await dayRow(pg.db)).toMatchObject({ actual_mfen: 700n, reserved_mfen: 0n });
});

it('[AC-B3-09m#18] 别处收尾拿不到实际用量时按预占 5,000 记满，并发只结一次', async () => {
  const budget = booking(pg.db);
  const { runId } = await budget.reserve();
  const both = await Promise.all([
    budget.settle({ runId, live: null }),
    budget.settle({ runId, live: null }),
  ]);
  expect(both.filter((result) => result.settled)).toEqual([
    { costMfen: 5_000n, priceVersion: 'synthetic-v1', settled: true },
  ]);
  expect(await dayRow(pg.db)).toMatchObject({ actual_mfen: 5_000n, reserved_mfen: 0n });
});

it('[AC-B3-09m#19] 上海 23:59:50 受理，次日结清时实际与预占都归前一日', async () => {
  const budget = booking(pg.db);
  const yesterday = await budget.reserve({ budgetMfen: 5_000n });
  budget.nextDay();
  const delayed = await budget.reserve({
    acceptedAt: new Date('2026-10-06T23:59:55+08:00'),
    budgetMfen: 5_000n,
  });
  expect(delayed.exhausted).toBe(true);
  const today = await budget.reserve({ budgetMfen: 5_000n });
  expect(today.exhausted).toBe(false);
  expect(await reservationRow(pg.db, today.runId)).toMatchObject({ day: NEXT_DAY });
  const settled = await budget.settle({
    runId: yesterday.runId,
    live: { spentMfen: 700n, calls: 2 },
  });
  expect(settled).toMatchObject({ costMfen: 700n, settled: true });
  expect(await dayRow(pg.db, DAY)).toMatchObject({ actual_mfen: 700n, reserved_mfen: 0n });
  expect(await dayRow(pg.db, NEXT_DAY)).toMatchObject({ actual_mfen: 0n, reserved_mfen: 5_000n });
});

it('[AC-B3-09m#20] 日预算为 0 或预占为 0 时，首次受理就降级且不写预占', async () => {
  const budget = booking(pg.db);
  for (const config of [{ budgetMfen: 0n }, { reserveMfen: 0n }]) {
    const blocked = await budget.reserve(config);
    expect(blocked.exhausted).toBe(true);
    expect(await reservationRow(pg.db, blocked.runId)).toBeUndefined();
  }
  expect((await dayRow(pg.db))?.reserved_mfen ?? 0n).toBe(0n);
});

it('[AC-B3-09m#21] 累计到 80% 与 100% 时分别发出告警并记录时刻', async () => {
  const budget = booking(pg.db);
  const limit = { budgetMfen: 1_000n };
  await budget.reserve({ ...limit, reserveMfen: 799n });
  expect(budget.onAlert).not.toHaveBeenCalledWith('budget_80');
  await budget.reserve({ ...limit, reserveMfen: 1n });
  expect(budget.onAlert).toHaveBeenCalledWith('budget_80');
  expect(budget.onAlert).not.toHaveBeenCalledWith('budget_100');
  expect(await dayRow(pg.db)).toMatchObject({ alert_80_at: expect.any(Date), alert_100_at: null });
  await budget.reserve({ ...limit, reserveMfen: 200n });
  expect(budget.onAlert).toHaveBeenCalledWith('budget_100');
  expect(await dayRow(pg.db)).toMatchObject({ alert_100_at: expect.any(Date) });
});

it('[AC-B3-09m#22] 厂商用量超出预估时照实记，收尾越线也发出两档告警', async () => {
  const budget = booking(pg.db);
  const limit = { budgetMfen: 1_000n };
  const { runId } = await budget.reserve({ ...limit, reserveMfen: 500n });
  expect(budget.onAlert).not.toHaveBeenCalled();
  const settled = await budget.settle({ ...limit, runId, live: { spentMfen: 1_020n, calls: 1 } });
  expect(settled).toMatchObject({ costMfen: 1_020n, settled: true });
  expect(budget.onAlert).toHaveBeenCalledWith('budget_80');
  expect(budget.onAlert).toHaveBeenCalledWith('budget_100');
  expect(await dayRow(pg.db)).toMatchObject({
    actual_mfen: 1_020n,
    reserved_mfen: 0n,
    alert_80_at: expect.any(Date),
    alert_100_at: expect.any(Date),
  });
});

it('[AC-B3-09m#23] 活进程未调模型，释放预占且成本保持 null', async () => {
  const budget = booking(pg.db);
  const { runId } = await budget.reserve();
  const settled = await budget.settle({ runId, live: { spentMfen: 0n, calls: 0 } });
  expect(settled).toMatchObject({ costMfen: null, settled: true });
  expect(await dayRow(pg.db)).toMatchObject({ actual_mfen: 0n, reserved_mfen: 0n });
});
