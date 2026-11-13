import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { usePgEach } from '../stream-mount/kit.ts';
import {
  answer,
  messageRow,
  seedAdmin,
  seedReport,
  url,
  withHttp,
  type HttpFixture,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);

// BR-AI-20: feedback and reports do not accept a user message or extend session activity.
async function sessionAndRuns(f: HttpFixture) {
  const session = await f.db
    .selectFrom('agent_sessions')
    .selectAll()
    .where('id', '=', f.messages.sessionId)
    .executeTakeFirstOrThrow();
  const runs = await f.db
    .selectFrom('agent_runs')
    .selectAll()
    .where('session_id', '=', f.messages.sessionId)
    .orderBy('id')
    .execute();
  return { session, runs };
}

it.each(['member', 'guest'] as const)(
  '[AC-B3-08zf#1][BR-AI-19] %s 对自己的助手消息点赞、点踩并改选，反馈时间来自注入时钟',
  async (who) => {
    await withHttp(pg.db, who, async (f) => {
      const { assistantId, controlId, userId } = f.messages;
      const control = await messageRow(f.db, controlId);
      const user = await messageRow(f.db, userId);
      const activityBefore = await sessionAndRuns(f);
      f.clock.advanceMs(12_345);
      await answer(
        'feedback',
        await f.call('POST', url('feedback', assistantId), { feedback: 'up' }),
      );
      expect(await messageRow(f.db, assistantId)).toMatchObject({
        feedback: 'up',
        feedback_at: f.clock.now(),
        badcase: false,
      });
      expect(await sessionAndRuns(f)).toEqual(activityBefore);
      expect(await messageRow(f.db, controlId)).toEqual(control);
      f.clock.advanceMs(23_456);
      await answer(
        'feedback',
        await f.call('POST', url('feedback', assistantId), { feedback: 'down' }),
      );
      expect(await messageRow(f.db, assistantId)).toMatchObject({
        feedback: 'down',
        feedback_at: f.clock.now(),
        badcase: true,
      });
      expect(await sessionAndRuns(f)).toEqual(activityBefore);
      expect(await messageRow(f.db, controlId)).toEqual(control);
      // Also pin down as the very first selection, independently of the up -> down path.
      f.clock.advanceMs(1_000);
      await answer(
        'feedback',
        await f.call('POST', url('feedback', controlId), { feedback: 'down' }),
      );
      expect(await messageRow(f.db, controlId)).toMatchObject({
        feedback: 'down',
        feedback_at: f.clock.now(),
        badcase: true,
        report_status: control.report_status,
        reported: control.reported,
      });
      expect(await sessionAndRuns(f)).toEqual(activityBefore);
      expect(await messageRow(f.db, userId)).toEqual(user);
    });
  },
  120_000,
);

it.each(['member', 'guest'] as const)(
  '[AC-B3-08zf#2][BR-ID-15][BR-AI-19] %s 首次举报保存自由文本和时钟，重复举报保留首次原因、时刻和待处理状态',
  async (who) => {
    await withHttp(pg.db, who, async (f) => {
      const { assistantId, controlId } = f.messages;
      const control = await messageRow(f.db, controlId);
      const activityBefore = await sessionAndRuns(f);
      const reason = '  这条回复有误\n请核查原文！  ';
      f.clock.advanceMs(10_000);
      const reportedAt = f.clock.now();
      await answer('report', await f.call('POST', url('report', assistantId), { reason }));
      expect(await messageRow(f.db, assistantId)).toMatchObject({
        reported: true,
        report_reason: reason,
        reported_at: reportedAt,
        report_status: 'pending',
        report_handler_id: null,
        report_handled_at: null,
        report_note: null,
        feedback: null,
        feedback_at: null,
        badcase: false,
      });
      expect(await sessionAndRuns(f)).toEqual(activityBefore);
      f.clock.advanceMs(60_000);
      await answer(
        'report',
        await f.call('POST', url('report', assistantId), { reason: '第二次原因' }),
      );
      expect(await messageRow(f.db, assistantId)).toMatchObject({
        reported: true,
        report_reason: reason,
        reported_at: reportedAt,
        report_status: 'pending',
        report_handler_id: null,
        report_handled_at: null,
        report_note: null,
      });
      expect(await sessionAndRuns(f)).toEqual(activityBefore);
      expect(await messageRow(f.db, controlId)).toEqual(control);
    });
  },
  120_000,
);

it('[AC-B3-08zf#3][BR-ID-15] 已处理的消息再次举报仍为成功，保留首次举报及后台处理结果', async () => {
  await withHttp(pg.db, 'member', async (f) => {
    const id = f.messages.assistantId;
    const handler = await seedAdmin(f.db, f.clock, f.owner.appId);
    await seedReport(f.db, f.clock, id, handler);
    const before = await messageRow(f.db, id);
    f.clock.advanceMs(60_000);
    await answer('report', await f.call('POST', url('report', id), { reason: '试图重开举报' }));
    expect(await messageRow(f.db, id)).toMatchObject({
      reported: true,
      report_reason: before.report_reason,
      reported_at: before.reported_at,
      report_status: 'handled',
      report_handler_id: handler,
      report_handled_at: before.report_handled_at,
      report_note: before.report_note,
    });
  });
}, 120_000);

it.each(['错', '字'.repeat(200)])(
  '[AC-B3-08zf#4] 举报自由文本边界 1 字和 200 字均能原样保存：%s',
  async (reason) => {
    await withHttp(pg.db, 'member', async (f) => {
      await answer(
        'report',
        await f.call('POST', url('report', f.messages.assistantId), { reason }),
      );
      expect((await messageRow(f.db, f.messages.assistantId)).report_reason).toBe(reason);
    });
  },
  120_000,
);
