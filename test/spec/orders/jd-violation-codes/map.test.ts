// B1-04zga · 真实 jd.csv 的违规码行（D10-867，取代 D10-529 ⑥「处罚码实测前不进表」）。
import { expect, it } from 'vitest';
import { mapPlatformStatus } from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import { jdStatusMap, requiredJdCsv } from '../jd-status-map/kit.ts';
import { VIOLATION_CODES, VIOLATION_NOTE } from './kit.ts';

it.each(VIOLATION_CODES)(
  '[AC-B1-04zga#1] D10-867：jd.csv 恰有一行 %s，映 PLATFORM_INVALID、doc、未实测，备注「无效-违规（D10-867）」，过 loadStatusMap',
  (code) => {
    // 先查资产本身，避免加载器硬编码时掩盖 CSV 的错码、错来源或错备注。
    const lines = requiredJdCsv().trimEnd().split(/\r?\n/);
    expect(lines.filter((line) => line.split(',')[0] === code)).toEqual([
      `${code},PLATFORM_INVALID,doc,false,${VIOLATION_NOTE}`,
    ]);
    const map = jdStatusMap();
    expect(map.entries.get(code)).toEqual({
      event: 'PLATFORM_INVALID',
      source: 'doc',
      verified: false,
      note: VIOLATION_NOTE,
    });
    expect(mapPlatformStatus(map, code)).toEqual({
      kind: 'event',
      event: 'PLATFORM_INVALID',
      verified: false,
    });
  },
);
