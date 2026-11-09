import { expect, it } from 'vitest';
import {
  loadStatusMap,
  mapPlatformStatus,
} from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import { HEADER, requiredStatusCsv } from './fixtures.ts';

// D10-31 修订：CAP-PDD-07 实测前只有 5 算已结算；D10-1069 起 4（审核失败）、10（已处罚）进表按失效。
const EXPECTED = [
  ['0', 'PLATFORM_PAID'],
  ['1', 'PLATFORM_PAID'],
  ['2', 'PLATFORM_RECEIVED'],
  ['3', 'PLATFORM_RECEIVED'],
  ['5', 'PLATFORM_SETTLED'],
  ['4', 'PLATFORM_INVALID'],
  ['10', 'PLATFORM_INVALID'],
] as const;

it('[AC-B1-08f#1] BR-FUND-02：拼多多 CSV 恰好七个文档码，均未实测', () => {
  const csv = requiredStatusCsv('pdd');
  const [header, ...lines] = csv.trimEnd().split(/\r?\n/);
  expect(header).toBe(HEADER);
  // 独立检查资产，避免加载器硬编码正确结果时掩盖 CSV 的错码或错误来源标记。
  expect(lines).toHaveLength(EXPECTED.length);
  for (const [code, event] of EXPECTED) {
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^${code},${event},doc,false,\\S`)),
      ]),
    );
  }
  const map = loadStatusMap('pdd', csv);
  expect([...map.entries.keys()].sort()).toEqual(EXPECTED.map(([code]) => code).sort());
  for (const [code, event] of EXPECTED) {
    expect(map.entries.get(code)).toEqual({
      event,
      source: 'doc',
      verified: false,
      note: expect.stringMatching(/\S/),
    });
  }
});

it.each(EXPECTED)(
  '[AC-B1-08f#2] BR-FUND-02 / D10-31：拼多多原始码 %s → %s，保留未验证标记',
  (rawCode, event) => {
    const map = loadStatusMap('pdd', requiredStatusCsv('pdd'));
    expect(mapPlatformStatus(map, rawCode)).toEqual({ kind: 'event', event, verified: false });
  },
);

it('[AC-B1-08f#3] BR-FUND-02 / D10-1069：4、10 映 PLATFORM_INVALID（未实测），只有 5 算已结算，3 不算', () => {
  const map = loadStatusMap('pdd', requiredStatusCsv('pdd'));
  expect(map.entries.get('4')).toMatchObject({ event: 'PLATFORM_INVALID', verified: false });
  expect(map.entries.get('10')).toMatchObject({ event: 'PLATFORM_INVALID', verified: false });
  expect(mapPlatformStatus(map, '4')).toEqual({
    kind: 'event',
    event: 'PLATFORM_INVALID',
    verified: false,
  });
  expect(mapPlatformStatus(map, '10')).toEqual({
    kind: 'event',
    event: 'PLATFORM_INVALID',
    verified: false,
  });
  expect(mapPlatformStatus(map, '3')).toEqual({
    kind: 'event',
    event: 'PLATFORM_RECEIVED',
    verified: false,
  });
  expect(
    [...map.entries].filter(([, row]) => row.event === 'PLATFORM_SETTLED').map(([code]) => code),
  ).toEqual(['5']);
});

it.each(['6', '9', '11', '99', '05', '5.0', ' 5 ', '', 'PLATFORM_SETTLED', null])(
  '[AC-B1-08f#4] BR-FUND-02：拼多多表外码 %s 保留原码交调用方处理 UNMAPPED_STATUS',
  (rawCode) => {
    const map = loadStatusMap('pdd', requiredStatusCsv('pdd'));
    expect(mapPlatformStatus(map, rawCode)).toEqual({ kind: 'unmapped', rawCode });
  },
);
