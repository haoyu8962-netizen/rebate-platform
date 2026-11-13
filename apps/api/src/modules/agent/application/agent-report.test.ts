import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { reportState } from '../store/feedback/index.ts';
import { createAgentReportAdminPort, handleAgentReport, refusal } from './agent-report.ts';

const input = {
  appId: 'synthetic-app',
  messageId: '019a0000-0000-7000-8000-000000000201',
  handlerId: '019a0000-0000-7000-8000-000000000301',
  note: '已核查',
  expectedRowVersion: 3,
};

/** A transaction that fails the test if any query is built on it. */
function untouched(): Transaction<DB> {
  const withSchema = vi.fn(() => {
    throw new Error('no query expected');
  });
  return { withSchema } as unknown as Transaction<DB>;
}

it('[AC-B3-08zf#15][BR-ID-15] 未写入时按行状态给出联合体：不存在、未举报、已处理、版本冲突', () => {
  expect(refusal(undefined)).toBe('not_found');
  expect(refusal(null)).toBe('not_reported');
  expect(refusal('handled')).toBe('already_handled');
  expect(refusal('pending')).toBe('cas_conflict');
});

it('[AC-B3-08zf#15][BR-ID-15] 非 UUID 的消息为 not_found、非整数版本为 cas_conflict，都不查库', async () => {
  const clock = new FixedClock('2026-10-15T00:00:00Z');
  const trx = untouched();
  expect(await handleAgentReport(trx, clock, { ...input, messageId: 'x' })).toEqual({
    kind: 'not_found',
  });
  expect(await handleAgentReport(trx, clock, { ...input, expectedRowVersion: 1.5 })).toEqual({
    kind: 'cas_conflict',
  });
  const port = createAgentReportAdminPort({ clock });
  expect(await port.handle(trx, { ...input, messageId: 'x' })).toEqual({ kind: 'not_found' });
});

it('[AC-B3-08zf#16][BR-ID-15] report_status 只认状态机的两个状态，未举报为 null', () => {
  expect(reportState(null)).toBeNull();
  expect(reportState('pending')).toBe('pending');
  expect(reportState('handled')).toBe('handled');
  expect(() => reportState('reopened')).toThrow('Unknown agent report status');
});
