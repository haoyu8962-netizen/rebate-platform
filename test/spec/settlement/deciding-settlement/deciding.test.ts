// B2-04zp · 决定金额的结算记录（BR-FUND-09：API 与明细不一致以明细为准，最新 STATEMENT 优先，其次最新 API；
// D10-588 ⑤）。纯函数，不连库。每组都正反两个顺序各断言一次：取数不靠入参顺序。
import { expect, it } from 'vitest';
import { decidingSettlement } from '../../../../apps/api/src/modules/settlement/settlements/index.ts';

const CUTOFF_AT = '2026-11-24T02:00:00.000Z';
const CUTOFF = Date.parse(CUTOFF_AT);
const BEFORE = '2026-11-20T02:00:00.000Z';
const AFTER = '2026-11-24T02:00:00.001Z';

function record(seq: number, source: 'API' | 'STATEMENT', createdAt = BEFORE) {
  return { seq, source, createdAt: new Date(createdAt), commissionFen: BigInt(seq) * 100n };
}

function decided(rows: readonly ReturnType<typeof record>[]) {
  const reversed = decidingSettlement([...rows].reverse(), CUTOFF);
  expect(decidingSettlement(rows, CUTOFF)).toEqual(reversed);
  return reversed;
}

it('[AC-B2-04zp#1] 只有 API：取 seq 最大的 API', () => {
  const newest = record(2, 'API');
  expect(decided([record(1, 'API'), newest])).toEqual(newest);
});

it('[AC-B2-04zp#2] 只有 STATEMENT：取 seq 最大的 STATEMENT', () => {
  const newest = record(2, 'STATEMENT');
  expect(decided([record(1, 'STATEMENT'), newest])).toEqual(newest);
});

it('[AC-B2-04zp#3] STATEMENT 在 API 之前：取 STATEMENT，seq 更大的 API 不决定金额', () => {
  const statement = record(2, 'STATEMENT');
  expect(decided([record(1, 'API'), statement, record(3, 'API')])).toEqual(statement);
});

it('[AC-B2-04zp#4] STATEMENT 在 API 之后：取 STATEMENT', () => {
  const statement = record(2, 'STATEMENT');
  expect(decided([record(1, 'API'), statement])).toEqual(statement);
});

it('[AC-B2-04zp#5] 两条 STATEMENT 取 seq 大的，不看取得时间先后，中间夹的 API 不算', () => {
  const newest = record(3, 'STATEMENT', '2026-11-19T02:00:00.000Z');
  const older = record(1, 'STATEMENT', '2026-11-21T02:00:00.000Z');
  expect(decided([older, record(2, 'API'), newest, record(4, 'API')])).toEqual(newest);
});

it('[AC-B2-04zp#6] 唯一的 STATEMENT 晚于截点时不算：退回截点内 seq 最大的 API', () => {
  const api = record(2, 'API');
  expect(decided([record(1, 'API'), api, record(3, 'STATEMENT', AFTER)])).toEqual(api);
});

it('[AC-B2-04zp#7] 较新的 STATEMENT 晚于截点时取截点内的旧 STATEMENT，不退回 API', () => {
  const older = record(2, 'STATEMENT');
  expect(decided([record(1, 'API'), older, record(3, 'STATEMENT', AFTER)])).toEqual(older);
});

it('[AC-B2-04zp#8] 晚于截点的 API 同样不算', () => {
  const api = record(1, 'API');
  expect(decided([api, record(2, 'API', AFTER)])).toEqual(api);
});

it('[AC-B2-04zp#9] 截点相等算在内：STATEMENT 与 API 都是', () => {
  const statement = record(2, 'STATEMENT', CUTOFF_AT);
  expect(decided([record(1, 'API'), statement])).toEqual(statement);
  const api = record(1, 'API', CUTOFF_AT);
  expect(decided([api])).toEqual(api);
});

it('[AC-B2-04zp#10] 没有记录、或全部晚于截点：null', () => {
  expect(decidingSettlement([], CUTOFF)).toBeNull();
  expect(decided([record(1, 'API', AFTER), record(2, 'STATEMENT', AFTER)])).toBeNull();
});
