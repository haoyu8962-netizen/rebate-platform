import { expect, it, vi } from 'vitest';
import {
  createMetricsRegistry,
  type ChannelMismatchSnapshot,
  type SettleBillMismatchSnapshot,
} from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { families } from '../kit.ts';
import {
  BILL_GENERATED,
  BILL_METRICS,
  BILL_MISMATCH,
  CHANNEL_OPEN,
  METRICS,
  appValues,
  expectAbsent,
} from './kit.ts';

function expectGauge(text: string, name: string): void {
  expect(families(text).get(name), name).toBe('gauge');
  expect(text).toMatch(new RegExp(`^# HELP ${name} +\\S`, 'm'));
}

it('[AC-B2-09zn#1] worker 每次抓取采集一次通道差错单，按 app_id 导出 gauge，消失的 app 不留样本', async () => {
  const collectChannelMismatch = vi
    .fn<() => Promise<ChannelMismatchSnapshot>>()
    .mockResolvedValueOnce({ open: { alpha: 1, beta: 3 } })
    .mockResolvedValueOnce({ open: { beta: 2 } })
    .mockResolvedValueOnce({ open: {} });
  const worker = createMetricsRegistry({ entry: 'worker', collectChannelMismatch });
  expect(collectChannelMismatch).not.toHaveBeenCalled();

  const first = await worker.render();
  expect(collectChannelMismatch).toHaveBeenCalledTimes(1);
  expectGauge(first, CHANNEL_OPEN);
  expect(appValues(first, CHANNEL_OPEN)).toEqual({ alpha: 1, beta: 3 });
  expectAbsent(first, BILL_METRICS);

  expect(appValues(await worker.render(), CHANNEL_OPEN)).toEqual({ beta: 2 });
  expect(collectChannelMismatch).toHaveBeenCalledTimes(2);
  const empty = await worker.render();
  expectGauge(empty, CHANNEL_OPEN);
  expect(appValues(empty, CHANNEL_OPEN)).toEqual({});
  expect(collectChannelMismatch).toHaveBeenCalledTimes(3);
});

it('[AC-B2-09zn#2] worker 每次抓取只采集一次账单快照，成对导出数量和出账 Unix 秒，零值保留且消失的 app 不留样本', async () => {
  const collectSettleBillMismatch = vi
    .fn<() => Promise<SettleBillMismatchSnapshot>>()
    .mockResolvedValueOnce({
      bills: {
        alpha: { amountMismatch: 2, generatedAtSeconds: 1_767_225_600 },
        beta: { amountMismatch: 0, generatedAtSeconds: 1_764_547_200 },
      },
    })
    .mockResolvedValueOnce({
      bills: { beta: { amountMismatch: 4, generatedAtSeconds: 1_767_225_601 } },
    })
    .mockResolvedValueOnce({ bills: {} });
  const worker = createMetricsRegistry({ entry: 'worker', collectSettleBillMismatch });
  expect(collectSettleBillMismatch).not.toHaveBeenCalled();

  const first = await worker.render();
  expect(collectSettleBillMismatch).toHaveBeenCalledTimes(1);
  for (const name of BILL_METRICS) expectGauge(first, name);
  expect(appValues(first, BILL_MISMATCH)).toEqual({ alpha: 2, beta: 0 });
  expect(appValues(first, BILL_GENERATED)).toEqual({ alpha: 1_767_225_600, beta: 1_764_547_200 });
  expectAbsent(first, [CHANNEL_OPEN]);

  const second = await worker.render();
  expect(collectSettleBillMismatch).toHaveBeenCalledTimes(2);
  expect(appValues(second, BILL_MISMATCH)).toEqual({ beta: 4 });
  expect(appValues(second, BILL_GENERATED)).toEqual({ beta: 1_767_225_601 });
  const empty = await worker.render();
  for (const name of BILL_METRICS) {
    expectGauge(empty, name);
    expect(appValues(empty, name)).toEqual({});
  }
  expect(collectSettleBillMismatch).toHaveBeenCalledTimes(3);
});

it('[AC-B2-09zn#3] 两个采集项只在 worker 且给了采集函数时启用', async () => {
  const collectors = {
    collectChannelMismatch: vi.fn(async () => ({ open: { alpha: 1 } })),
    collectSettleBillMismatch: vi.fn(async () => ({
      bills: { alpha: { amountMismatch: 1, generatedAtSeconds: 1_767_225_600 } },
    })),
  };

  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    expectAbsent(await createMetricsRegistry({ entry, ...collectors }).render(), METRICS);
    expect(collectors.collectChannelMismatch, entry).not.toHaveBeenCalled();
    expect(collectors.collectSettleBillMismatch, entry).not.toHaveBeenCalled();
  }
  expectAbsent(await createMetricsRegistry({ entry: 'worker' }).render(), METRICS);

  const worker = await createMetricsRegistry({ entry: 'worker', ...collectors }).render();
  for (const name of METRICS) expectGauge(worker, name);
  expect(collectors.collectChannelMismatch).toHaveBeenCalledTimes(1);
  expect(collectors.collectSettleBillMismatch).toHaveBeenCalledTimes(1);
});

it('[AC-B2-09zn#4] 通道差错单采集拒绝或同步抛出时，render 原样拒绝，恢复后导出新值', async () => {
  const failure = new Error('channel mismatch collector unavailable');
  const collectChannelMismatch = vi
    .fn<() => Promise<ChannelMismatchSnapshot>>()
    .mockResolvedValueOnce({ open: { alpha: 1 } })
    .mockRejectedValueOnce(failure)
    .mockImplementationOnce(() => {
      throw failure;
    })
    .mockResolvedValueOnce({ open: { beta: 2 } });
  const worker = createMetricsRegistry({ entry: 'worker', collectChannelMismatch });
  expect(appValues(await worker.render(), CHANNEL_OPEN)).toEqual({ alpha: 1 });
  await expect(worker.render()).rejects.toBe(failure);
  await expect(worker.render()).rejects.toBe(failure);
  expect(appValues(await worker.render(), CHANNEL_OPEN)).toEqual({ beta: 2 });
  expect(collectChannelMismatch).toHaveBeenCalledTimes(4);
});

it('[AC-B2-09zn#5] 账单采集拒绝或同步抛出时，render 原样拒绝，恢复后两项样本都跟随新值', async () => {
  const failure = new Error('settle bill mismatch collector unavailable');
  const collectSettleBillMismatch = vi
    .fn<() => Promise<SettleBillMismatchSnapshot>>()
    .mockResolvedValueOnce({
      bills: { alpha: { amountMismatch: 1, generatedAtSeconds: 1_767_225_600 } },
    })
    .mockRejectedValueOnce(failure)
    .mockImplementationOnce(() => {
      throw failure;
    })
    .mockResolvedValueOnce({
      bills: { beta: { amountMismatch: 2, generatedAtSeconds: 1_767_225_601 } },
    });
  const worker = createMetricsRegistry({ entry: 'worker', collectSettleBillMismatch });
  expect(appValues(await worker.render(), BILL_MISMATCH)).toEqual({ alpha: 1 });
  await expect(worker.render()).rejects.toBe(failure);
  await expect(worker.render()).rejects.toBe(failure);
  const recovered = await worker.render();
  expect(appValues(recovered, BILL_MISMATCH)).toEqual({ beta: 2 });
  expect(appValues(recovered, BILL_GENERATED)).toEqual({ beta: 1_767_225_601 });
  expect(collectSettleBillMismatch).toHaveBeenCalledTimes(4);
});
