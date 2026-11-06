// D10-741 ③：调度门「有订单源」。照 B1-04zza rightsSources 先例，适配器报 orderSources（淘宝：大淘客订单源与
// 推广位读取器都注入才为 true；只看注入，不发请求、不取凭据）；增量调度器在现有门之外再看一道：无订单源的
// 平台本轮跳过——不投窗、不挪水位（连回看夹紧也不做）、不报错、不出 warn / error，每轮至多一条 info。适配器
// 无推广位时仍抛 taobao_order_no_slots（#2464 不动），调度门保证走不到那一步：不能靠适配器抛错兜底。京东 /
// 拼多多不受影响。
import { expect, it, vi } from 'vitest';
import { scheduleOrderSync } from '../../../../apps/api/src/modules/orders/application/sync-scheduler.ts';
import type {
  RegisteredPlatform,
  UnionAdapter,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import { onePage, setup } from '../../union/taobao-orders/kit.ts';
import {
  HOUR_MS,
  JD_CAP_MS,
  NOW_MS,
  PDD_CAP_MS,
  TAOBAO_CAP_MS,
  aboutPlatform,
  gatedFixture,
  incrementWindow,
  iso,
  jdAccount,
  pddAccount,
  taobaoAccount,
} from './taobao-sync-kit.ts';

it.each([
  { label: '订单源与推广位读取器都注入', source: true, slots: true, expected: true },
  { label: '未注入推广位读取器（未登记 PID）', source: true, slots: false, expected: false },
  { label: '未注入大淘客订单源', source: false, slots: true, expected: false },
  { label: '两者都没有', source: false, slots: false, expected: false },
])(
  '[AC-B1-04zzb#20] 淘宝适配器 orderSources：$label → $expected；只看注入，不读推广位、不发请求',
  ({ source, slots, expected }) => {
    const s = setup(onePage([]), { source, ...(slots ? {} : { slots: null }) });
    const declared: UnionAdapter = s.adapter;
    expect(declared.orderSources).toBe(expected);
    expect(s.orderSlots).not.toHaveBeenCalled();
    expect(s.transport).not.toHaveBeenCalled();
    expect(s.dataokeCredentials).not.toHaveBeenCalled();
    expect(s.taobaoTransport).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04zzb#21] 调度门：淘宝报无订单源 → 本轮不投窗、不挪水位、不报错；报有 → 照常 20 分钟窗', async () => {
  const fromMs = NOW_MS - 3 * HOUR_MS;
  const sourced = gatedFixture({ accounts: [taobaoAccount], increment: iso(fromMs) }, () => true);
  await scheduleOrderSync(sourced.deps);
  expect(sourced.f.sent()).toEqual([incrementWindow('taobao', fromMs, TAOBAO_CAP_MS)]);

  // 早于 90 天的起点：放过门的话会先夹紧挪水位（rewind），所以这里也看得出「不推进水位」。
  const gate = vi.fn((platform: RegisteredPlatform) => platform !== 'taobao');
  const bare = gatedFixture(
    { accounts: [taobaoAccount], increment: '2026-01-01T00:00:00.000Z' },
    gate,
  );
  bare.f.rewind.mockResolvedValue(true);
  await expect(scheduleOrderSync(bare.deps)).resolves.toBeUndefined();
  expect(gate).toHaveBeenCalledWith('taobao');
  expect(bare.f.send).not.toHaveBeenCalled();
  expect(bare.f.rewind).not.toHaveBeenCalled();
  expect(bare.f.advance).not.toHaveBeenCalled();
  expect(bare.f.logger.warn).not.toHaveBeenCalled();
  expect(bare.f.logger.error).not.toHaveBeenCalled();
  expect(bare.f.logger.info.mock.calls.length).toBeLessThanOrEqual(1);
});

it('[AC-B1-04zzb#22] 调度门只挡无订单源的平台：同一轮京东、拼多多照发原窗，淘宝不发', async () => {
  const fromMs = NOW_MS - 3 * HOUR_MS;
  const accounts = [jdAccount, pddAccount, taobaoAccount];
  const all = gatedFixture({ accounts, increment: iso(fromMs) }, () => true);
  await scheduleOrderSync(all.deps);
  expect(all.f.sent()).toEqual([
    incrementWindow('jd', fromMs, JD_CAP_MS),
    incrementWindow('pdd', fromMs, PDD_CAP_MS),
    incrementWindow('taobao', fromMs, TAOBAO_CAP_MS),
  ]);

  const gated = gatedFixture(
    { accounts, increment: iso(fromMs) },
    (platform) => platform !== 'taobao',
  );
  await expect(scheduleOrderSync(gated.deps)).resolves.toBeUndefined();
  expect(gated.f.sent()).toEqual([
    incrementWindow('jd', fromMs, JD_CAP_MS),
    incrementWindow('pdd', fromMs, PDD_CAP_MS),
  ]);
  expect(gated.f.logger.error).not.toHaveBeenCalled();
  expect(aboutPlatform(gated.f.logger.warn, 'taobao')).toEqual([]);
  expect(aboutPlatform(gated.f.logger.info, 'taobao').length).toBeLessThanOrEqual(1);
});
