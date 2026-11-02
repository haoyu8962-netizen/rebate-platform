// B2-04zp 源码旁单元测试：批次记的 seq 与决定金额的记录是两个数（纯函数，不连库）。
import { expect, it } from 'vitest';
import { decidingSettlement, latestSeqWithin } from './deciding.ts';

const CUTOFF = Date.parse('2026-11-24T02:00:00.000Z');
const WITHIN = new Date('2026-11-20T02:00:00.000Z');
const AT_CUTOFF = new Date(CUTOFF);
const AFTER = new Date('2026-11-24T02:00:00.001Z');

function record(seq: number, source: 'API' | 'STATEMENT', createdAt = WITHIN) {
  return { seq, source, createdAt };
}

function seqAtCutoff(rows: readonly ReturnType<typeof record>[]) {
  const deciding = decidingSettlement(rows, CUTOFF);
  if (deciding === null) throw new Error('no record within the cut-off');
  return { deciding: deciding.seq, latest: latestSeqWithin(rows, CUTOFF, deciding) };
}

it('[AC-B2-04zp#U1] STATEMENT 之后还有 API：决定金额的是 STATEMENT，seq 取整单最大', () => {
  const rows = [record(1, 'API'), record(2, 'STATEMENT'), record(3, 'API'), record(4, 'API')];
  expect(seqAtCutoff(rows)).toEqual({ deciding: 2, latest: 4 });
  expect(seqAtCutoff([...rows].reverse())).toEqual({ deciding: 2, latest: 4 });
});

it('[AC-B2-04zp#U2] 只有 API：两个数是同一条', () => {
  expect(seqAtCutoff([record(1, 'API'), record(2, 'API')])).toEqual({ deciding: 2, latest: 2 });
});

it('[AC-B2-04zp#U3] 截点相等算在内，晚于截点的不抬高 seq', () => {
  const rows = [record(1, 'STATEMENT'), record(2, 'API', AT_CUTOFF), record(3, 'API', AFTER)];
  expect(seqAtCutoff(rows)).toEqual({ deciding: 1, latest: 2 });
});
