// D10-741 ①：worker 启动时读 specs/order-status-map/taobao.csv（照 jd / pdd 口径）：装配时每个调度平台只读一次，
// 淘宝也在其中；读不到（ENOENT）翻译成 MISSING_STATUS_MAP，别的读错原样抛出——两种都让 worker 起不来。
import * as fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { createOrderSyncRuntime } from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import { capture } from '../attribution/kit.ts';
import { setup } from '../../union/taobao-orders/kit.ts';
import { workerDeps } from './taobao-sync-worker-kit.ts';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
afterEach(() => vi.mocked(fs.readFileSync).mockReset());

const mapReads = () =>
  vi
    .mocked(fs.readFileSync)
    .mock.calls.filter(([path]) => String(path).includes('/specs/order-status-map/'))
    .map(([path]) => String(path).split('/').at(-1));

it('[AC-B1-04zzb#25] 装配时 jd、pdd、taobao 的映射表各读一次，之后 statusMaps 只取缓存', async () => {
  const result = await capture(() => createOrderSyncRuntime(workerDeps(setup().adapter).deps));
  expect(result).toMatchObject({ ok: true });
  expect([...mapReads()].sort()).toEqual(['jd.csv', 'pdd.csv', 'taobao.csv']);
  if (!result.ok) return;
  const reads = mapReads();
  for (let i = 0; i < 3; i += 1) result.value.statusMaps('taobao');
  expect(mapReads()).toEqual(reads);
});

it.each(['ENOENT', 'EACCES'] as const)(
  '[AC-B1-04zzb#26] taobao.csv 读取 %s：worker 起不来；只把 ENOENT 翻译成 MISSING_STATUS_MAP',
  async (code) => {
    const original = vi.mocked(fs.readFileSync).getMockImplementation()!;
    const error = Object.assign(new Error(`synthetic-${code}`), { code });
    vi.mocked(fs.readFileSync).mockImplementation((...args) => {
      if (String(args[0]).endsWith('/specs/order-status-map/taobao.csv')) throw error;
      return original(...args);
    });
    const result = await capture(() => createOrderSyncRuntime(workerDeps(setup().adapter).deps));
    expect(mapReads()).toContain('taobao.csv');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      if (code === 'ENOENT') expect(result.error).toMatchObject({ code: 'MISSING_STATUS_MAP' });
      else expect(result.error).toBe(error);
    }
  },
);
