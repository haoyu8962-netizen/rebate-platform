// B2-09zm unit tests: settleBillAwaitingConfirm, the one decision behind the issued branch of
// deriveAdminSettleBill, the list's awaiting_confirm filter and countSettleBillPending. No DB.
import { expect, it } from 'vitest';
import {
  deriveAdminSettleBill,
  settleBillAwaitingConfirm,
  type AdminSettleRoundBatch,
} from './admin-settle-bills.ts';

const GENERATED = new Date('2026-10-24T02:00:00.000Z');
const NOW = new Date('2026-10-30T02:00:00.000Z');

let seq = 0;
function batch(over: Partial<AdminSettleRoundBatch> = {}): AdminSettleRoundBatch {
  seq += 1;
  return {
    batch_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    platform: 'taobao',
    kind: 'main',
    status: 'DRAFT',
    settle_mode: 'IMMEDIATE',
    scheduled_at: null,
    created_at: new Date('2026-10-24T01:00:00.000Z'),
    ...over,
  };
}

const at = (iso: string): Date => new Date(iso);

it('[AC-B2-09zm#U1] 已生成且最近一轮有 DRAFT 才算；生成中、无批次、本轮全驳回不算', () => {
  expect(settleBillAwaitingConfirm(GENERATED, [batch()])).toBe(true);
  expect(
    settleBillAwaitingConfirm(GENERATED, [batch(), batch({ platform: 'jd', status: 'CONFIRMED' })]),
  ).toBe(true);
  expect(settleBillAwaitingConfirm(null, [batch()])).toBe(false);
  expect(settleBillAwaitingConfirm(GENERATED, [])).toBe(false);
  expect(settleBillAwaitingConfirm(GENERATED, [batch({ status: 'CANCELLED' })])).toBe(false);
});

it('[AC-B2-09zm#U2] 轮外 DRAFT 不算：补充轮全驳回或未处于 DRAFT 时不回退到较早轮', () => {
  const main = batch();
  const later = at('2026-10-28T01:00:00.000Z');
  for (const status of ['CANCELLED', 'DONE', 'CONFIRMED', 'EXECUTING', 'PARTIAL']) {
    const supplement = batch({ kind: 'supplement', status, created_at: later });
    expect(settleBillAwaitingConfirm(GENERATED, [main, supplement]), status).toBe(false);
  }
  const draft = batch({ kind: 'supplement', created_at: later });
  expect(settleBillAwaitingConfirm(GENERATED, [batch({ status: 'DONE' }), draft])).toBe(true);
});

it('[AC-B2-09zm#U3] 微秒创建时刻决定最近一轮；同刻按最大 batch_id 决胜', () => {
  const created = at('2026-10-30T01:55:00.000Z');
  const early = batch({
    kind: 'supplement',
    batch_id: 'ffffffff-0000-4000-8000-000000000001',
    status: 'DONE',
    created_at: created,
    created_micros: '1793325300000001',
  });
  const late = batch({
    kind: 'supplement',
    batch_id: '00000000-0000-4000-8000-000000000002',
    created_at: created,
    created_micros: '1793325300000002',
  });
  expect(settleBillAwaitingConfirm(GENERATED, [early, late])).toBe(true);
  expect(
    settleBillAwaitingConfirm(GENERATED, [
      { ...early, status: 'DRAFT' },
      { ...late, status: 'DONE' },
    ]),
  ).toBe(false);
  const tieHigh = batch({
    kind: 'supplement',
    platform: 'jd',
    batch_id: 'ffffffff-0000-4000-8000-000000000003',
    created_at: created,
  });
  const tieLow = batch({
    kind: 'supplement',
    batch_id: '00000000-0000-4000-8000-000000000004',
    status: 'DONE',
    created_at: created,
  });
  expect(settleBillAwaitingConfirm(GENERATED, [tieLow, tieHigh])).toBe(true);
  expect(
    settleBillAwaitingConfirm(GENERATED, [
      { ...tieLow, status: 'DRAFT' },
      { ...tieHigh, status: 'DONE' },
    ]),
  ).toBe(false);
});

it('[AC-B2-09zm#U4] 判定为真时派生状态必为 issued 且不随时钟变化；空轮与全驳回的 issued 判定为假', () => {
  const due = at('2026-10-29T00:00:00.000Z');
  const before = at('2026-10-28T12:00:00.000Z');
  const scheduledRound = [
    batch(),
    batch({
      kind: 'supplement',
      status: 'CONFIRMED',
      settle_mode: 'SCHEDULED',
      scheduled_at: due,
      created_at: at('2026-10-28T01:00:00.000Z'),
    }),
  ];
  const cases: [Date | null, AdminSettleRoundBatch[], boolean, string[]][] = [
    [GENERATED, [batch()], true, ['issued', 'issued', 'issued']],
    [GENERATED, [], false, ['issued', 'issued', 'issued']],
    [GENERATED, [batch({ status: 'CANCELLED' })], false, ['issued', 'issued', 'issued']],
    [null, [batch()], false, ['generating', 'generating', 'generating']],
    [GENERATED, scheduledRound, false, ['scheduled', 'settling', 'settling']],
    [GENERATED, [batch({ status: 'DONE' })], false, ['settled', 'settled', 'settled']],
  ];
  for (const [index, [generatedAt, batches, awaiting, statuses]] of cases.entries()) {
    expect(settleBillAwaitingConfirm(generatedAt, batches), String(index)).toBe(awaiting);
    const derived = [before, due, NOW].map(
      (now) => deriveAdminSettleBill(generatedAt, batches, now).status,
    );
    expect(derived, String(index)).toEqual(statuses);
  }
});
