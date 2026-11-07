import { expect } from 'vitest';
import {
  loadStatusMap,
  type PlatformStatusEvent,
  type StatusMap,
} from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import { readStatusCsv } from '../status-map/fixtures.ts';

// D10-529 定表。全部 source=doc、verified=false；不标已结算码。
// D10-867：13、25–28、36–43 改进表。
const INVALID_CODES = [
  ...'2 3 4 5 6 7 8 9 11 14 19 20 21 22 23 29 30 31 34 35'.split(' '),
  ...'13 25 26 27 28 36 37 38 39 40 41 42 43'.split(' '),
];

export const MAPPED: readonly (readonly [string, PlatformStatusEvent])[] = [
  ['16', 'PLATFORM_PAID'],
  ['24', 'PLATFORM_DEPOSIT_PAID'],
  ['17', 'PLATFORM_RECEIVED'],
  ...INVALID_CODES.map((code) => [code, 'PLATFORM_INVALID'] as const),
];

// 不进表，走表外码：含 15 待付款与官方不存在的 18。
export const UNMAPPED = '-1 33 44 15 18'.split(' ');

export function requiredJdCsv(): string {
  const text = readStatusCsv('jd');
  // 缺表或只有表头都是断言失败，不让 ENOENT、INVALID_STATUS_MAP 成为先红原因。
  expect(text, 'specs/order-status-map/jd.csv 必须存在').not.toBeNull();
  expect(text!.trimEnd().split(/\r?\n/).length, 'jd.csv 必须有数据行').toBeGreaterThan(1);
  return text!;
}

export function jdStatusMap(): StatusMap {
  return loadStatusMap('jd', requiredJdCsv());
}
