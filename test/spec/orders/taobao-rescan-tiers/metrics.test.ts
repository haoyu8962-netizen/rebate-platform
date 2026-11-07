// B1-04zzr (D10-798 ⑧, linked B1-01zzr): which query_kind is a rescan stream (rescan or a 'rescan_'
// prefix) and which streams count in the watermark lag (every rescan stream and exactly rights /
// manual are left out). Pure predicates; the SQL is held to the same table in metrics.int.test.ts.
import { expect, it } from 'vitest';
import {
  countsInWatermarkLag,
  isRescanQueryKind,
} from '../../../../apps/api/src/modules/platform/metrics/rescan-position.ts';

const RESCAN = ['rescan', 'rescan_hour', 'rescan_week', 'rescan_synthetic'];
// Near misses: no underscore after the prefix (a LIKE 'rescan_%' would take 'rescanx'), another
// case, a suffix, a leading space.
const NOT_RESCAN = ['rescanx', 'rescan-hour', 'Rescan_hour', 'pre_rescan', ' rescan', 'increment'];

it('[AC-B1-04zzr#36] 回扫流：query_kind 是 rescan 或以 rescan_ 开头；近似值都不是', () => {
  for (const kind of RESCAN) expect(isRescanQueryKind(kind), kind).toBe(true);
  for (const kind of [...NOT_RESCAN, 'rights', 'manual', 'updated_at', '']) {
    expect(isRescanQueryKind(kind), JSON.stringify(kind)).toBe(false);
  }
});

it('[AC-B1-04zzr#37] 水位滞后：回扫流（含各档）与 rights / manual 不计入；rights、manual 仍按精确值，其余 query_kind 照常计入', () => {
  for (const kind of [...RESCAN, 'rights', 'manual']) {
    expect(countsInWatermarkLag(kind), kind).toBe(false);
  }
  for (const kind of [...NOT_RESCAN, 'updated_at', 'paid_time', 'rights_x', 'manual_x']) {
    expect(countsInWatermarkLag(kind), kind).toBe(true);
  }
});
