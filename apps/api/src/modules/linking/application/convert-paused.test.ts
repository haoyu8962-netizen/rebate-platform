// B1-06zl 源码旁单元测试：转链开关关闭的 50301 data 只由 convert.off_reason.<platform> 与 content
// 开关登记表的缺省值决定（不认识的取值、未配置都取登记表缺省），其他暂停不带 data。不连库。
import { expect, it, vi } from 'vitest';
import { convertOffReasonOf, convertPausedData, pausedDataOf } from './convert-paused.ts';

it.each([
  ['maintenance', 'maintenance'],
  ['not_launched', 'not_launched'],
  [undefined, 'not_launched'],
  [null, 'not_launched'],
  ['synthetic_unknown_reason', 'not_launched'],
  [true, 'not_launched'],
] as const)('[AC-B1-06zl] off_reason %s → reason %s', (stored, reason) => {
  for (const platform of ['taobao', 'jd', 'pdd']) {
    expect(convertOffReasonOf(platform, stored)).toBe(reason);
  }
});

it('[AC-B1-06zl] reads convert.off_reason.<platform> of the app through the config reader', async () => {
  const configValue = vi.fn(async (_app: string, key: string) =>
    key === 'convert.off_reason.pdd' ? { value: 'maintenance', version: 3 } : null,
  );
  await expect(convertPausedData({ configValue }, 'synthetic-app', 'pdd')).resolves.toStrictEqual({
    platform: 'pdd',
    reason: 'maintenance',
  });
  await expect(convertPausedData({ configValue }, 'synthetic-app', 'jd')).resolves.toStrictEqual({
    platform: 'jd',
    reason: 'not_launched',
  });
  expect(configValue.mock.calls).toEqual([
    ['synthetic-app', 'convert.off_reason.pdd'],
    ['synthetic-app', 'convert.off_reason.jd'],
  ]);
});

it('[AC-B1-06zl] only a pause carrying { platform, reason } gives data', () => {
  const data = { platform: 'jd', reason: 'maintenance' };
  expect(pausedDataOf(Object.assign(new Error('x'), { code: 50301, data }))).toStrictEqual(data);
  expect(pausedDataOf(Object.assign(new Error('x'), { code: 50301 }))).toBeUndefined();
  expect(
    pausedDataOf(Object.assign(new Error('x'), { data: { reason: 'other' } })),
  ).toBeUndefined();
  expect(pausedDataOf(null)).toBeUndefined();
});
