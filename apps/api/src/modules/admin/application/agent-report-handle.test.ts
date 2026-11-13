import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  AGENT_REPORT_NOTE_MAX,
  AgentReportFieldsError,
  agentReportNote,
  createAgentReportHandler,
} from './agent-report-handle.ts';

it('[AC-B1-10t] the note is trimmed and 1–500 characters once trimmed', () => {
  expect(agentReportNote('  已核实，回复无误  ')).toBe('已核实，回复无误');
  expect(agentReportNote('字'.repeat(AGENT_REPORT_NOTE_MAX))).toBe(
    '字'.repeat(AGENT_REPORT_NOTE_MAX),
  );
  expect(() => agentReportNote('   ')).toThrow(AgentReportFieldsError);
  expect(() => agentReportNote('字'.repeat(AGENT_REPORT_NOTE_MAX + 1))).toThrow(
    AgentReportFieldsError,
  );
  try {
    agentReportNote('');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AgentReportFieldsError);
    expect((error as AgentReportFieldsError).fields).toEqual(['note']);
  }
});

it('[AC-B1-10t] a refused note opens no transaction and writes no audit record', async () => {
  const transaction = vi.fn();
  const auditOn = vi.fn();
  const namesOn = vi.fn();
  const handler = createAgentReportHandler({
    db: { transaction } as unknown as Kysely<DB>,
    clock: new FixedClock(new Date('2026-11-14T00:00:00.000Z')),
    auditOn,
    namesOn,
  });
  await expect(
    handler.handle({
      appId: 'couli',
      adminId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b00',
      messageId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01',
      note: ' \n ',
      expectedRowVersion: 1,
      ip: null,
    }),
  ).rejects.toBeInstanceOf(AgentReportFieldsError);
  expect(transaction).not.toHaveBeenCalled();
  expect(auditOn).not.toHaveBeenCalled();
  expect(namesOn).not.toHaveBeenCalled();
});
