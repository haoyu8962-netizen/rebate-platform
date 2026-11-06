import { expect, it } from 'vitest';
import { loadStatusMap } from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import { scheduledPlatforms } from '../../../../apps/api/src/modules/orders/domain/sync-window.ts';
import { SYNTHETIC_CSV, readStatusCsv } from './fixtures.ts';

it.each(['taobao'] as const)(
  '[AC-B1-08f#11] BR-FUND-02：%s 尚无资料，不建映射表；缺表明确报 MISSING_STATUS_MAP',
  (platform) => {
    // 先触发骨架，再检查当前本来就不存在的资产，保证整条测试先红。
    const synthetic = loadStatusMap('pdd', SYNTHETIC_CSV);
    expect(synthetic.entries.size).toBeGreaterThan(0);
    const csv = readStatusCsv(platform);
    // B1-04zzo：收紧为单态（B1-04zzb 已合并）
    expect(csv).not.toBeNull();
    const map = loadStatusMap(platform, csv);
    const doc = (event: string) => ({
      event,
      source: 'doc',
      verified: false,
      note: expect.any(String),
    });
    expect([...map.entries.keys()].sort()).toEqual(['12', '13', '14', '3']);
    expect(Object.fromEntries(map.entries)).toEqual({
      '12': doc('PLATFORM_PAID'),
      '14': doc('PLATFORM_RECEIVED'),
      '3': doc('PLATFORM_SETTLED'),
      '13': doc('PLATFORM_INVALID'),
    });
    expect(scheduledPlatforms()).toContain(platform);
    expect(() => loadStatusMap(platform, null)).toThrow(/MISSING_STATUS_MAP/);
  },
);
