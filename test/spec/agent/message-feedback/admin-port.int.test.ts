import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  handleAgentReport,
  type AgentReportAdminPort,
} from '../../../../apps/api/src/modules/agent/application/agent-report.ts';
import type { Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import { startClock } from '../session-history-http/kit.ts';
import { agentSnapshot, newMember, usePgEach } from '../stream-mount/kit.ts';
import { adminPort, messageRow, seedAdmin, seedMessages, seedReport } from './kit.ts';

const pg = usePgEach(createTestDatabase);
const entries = ['function', 'port'] as const;

async function handler(
  entry: (typeof entries)[number],
  clock: Clock,
): Promise<AgentReportAdminPort['handle']> {
  if (entry === 'function') return (trx, input) => handleAgentReport(trx, clock, input);
  const port = await adminPort(clock);
  return (trx, input) => port.handle(trx, input);
}

async function fixture() {
  const clock = startClock();
  const owner = await newMember(pg.db);
  const messages = await seedMessages(pg.db, clock, owner);
  const handlerId = await seedAdmin(pg.db, clock, owner.appId);
  await seedReport(pg.db, clock, messages.assistantId);
  return {
    clock,
    owner,
    messages,
    input: {
      appId: owner.appId,
      messageId: messages.assistantId,
      handlerId,
      note: '已核查并登记纠正意见',
      expectedRowVersion: 7,
    },
  };
}

it.each(entries)(
  '[AC-B3-08zf#13][BR-ID-15] 后台 %s 入口在调用方事务内处理 pending，记录处理人、说明、注入时刻并递增版本',
  async (entry) => {
    const f = await fixture();
    const before = await messageRow(pg.db, f.input.messageId);
    const control = await messageRow(pg.db, f.messages.controlId);
    f.clock.advanceMs(31_234);
    const handle = await handler(entry, f.clock);
    await pg.db.transaction().execute(async (trx) => {
      expect(await handle(trx, f.input)).toEqual({
        kind: 'handled',
        rowVersion: 8,
        handledAt: f.clock.now().toISOString(),
      });
      // Visibility on the supplied transaction is part of the port's contract.
      expect(await messageRow(trx, f.input.messageId)).toMatchObject({
        report_status: 'handled',
        report_handler_id: f.input.handlerId,
        report_handled_at: f.clock.now(),
        report_note: f.input.note,
        row_version: 8,
      });
    });
    expect(await messageRow(pg.db, f.input.messageId)).toMatchObject({
      report_status: 'handled',
      report_handler_id: f.input.handlerId,
      report_handled_at: f.clock.now(),
      report_note: f.input.note,
      row_version: 8,
      reported: true,
      report_reason: before.report_reason,
      reported_at: before.reported_at,
      feedback: before.feedback,
      badcase: before.badcase,
    });
    expect(await messageRow(pg.db, f.messages.controlId)).toEqual(control);
  },
  120_000,
);

it.each(entries)(
  '[AC-B3-08zf#14][BR-ID-15] 后台 %s 入口服从调用方回滚，处理状态、时刻、说明和版本均不留存',
  async (entry) => {
    const f = await fixture();
    const before = await agentSnapshot(pg.db);
    const handle = await handler(entry, f.clock);
    const rollback = new Error('caller-requested-rollback');
    await expect(
      pg.db.transaction().execute(async (trx) => {
        expect(await handle(trx, f.input)).toEqual({
          kind: 'handled',
          rowVersion: 8,
          handledAt: f.clock.now().toISOString(),
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await agentSnapshot(pg.db)).toBe(before);
  },
  120_000,
);

it.each(entries)(
  '[AC-B3-08zf#15][BR-ID-15] 后台 %s 入口把不存在、跨 app、user 消息、未举报、已处理及版本冲突返回为联合体且不写库',
  async (entry) => {
    const f = await fixture();
    const handle = await handler(entry, f.clock);
    const cases = [
      { patch: { messageId: randomUUID() }, kind: 'not_found' },
      { patch: { appId: 'another-app' }, kind: 'not_found' },
      { patch: { messageId: f.messages.userId, expectedRowVersion: 0 }, kind: 'not_found' },
      { patch: { messageId: f.messages.controlId, expectedRowVersion: 0 }, kind: 'not_reported' },
      { patch: { expectedRowVersion: 6 }, kind: 'cas_conflict' },
    ];
    for (const testCase of cases) {
      const before = await agentSnapshot(pg.db);
      const result = await pg.db
        .transaction()
        .execute((trx) => handle(trx, { ...f.input, ...testCase.patch }));
      expect(result).toEqual({ kind: testCase.kind });
      expect(await agentSnapshot(pg.db)).toBe(before);
    }
    await seedReport(pg.db, f.clock, f.input.messageId, f.input.handlerId);
    const before = await agentSnapshot(pg.db);
    const result = await pg.db.transaction().execute((trx) => handle(trx, f.input));
    expect(result).toEqual({ kind: 'already_handled' });
    expect(await agentSnapshot(pg.db)).toBe(before);
  },
  120_000,
);
