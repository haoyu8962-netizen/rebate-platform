// B1-10t access rule tests (claude-independent, SPEC_REF 62b5c993): adminListAgentReports is
// guarded by agent.trace alone (BR-AI-19; the list is part of the trace console), adminHandleAgentReport
// by agent.report alone (BR-ID-15 细则「举报的处理」: 处理人标记已处理), neither with a step-up
// (CT-24zzi): a missing point → 10403 data.reason=admin_permission_denied, no token → 10001; an
// X-Step-Up-Token changes nothing. Refusals change no agent_* row and write no audit; the list never
// writes an audit. Requests go through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  AUDIT_ACTION,
  PII,
  REPORT,
  TRACE,
  agentTables,
  answer,
  auditCount,
  auditRows,
  denied,
  fixture,
  handleBody,
  hoursAgo,
  ids,
  messageRow,
  page,
  reportOf,
  seedReport,
  seedSession,
  suite,
  withReportAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B1-10t#1] 权限：列表只认 agent.trace（只持 agent.report、什么都不持、只持别的点 → 10403 data.reason=admin_permission_denied，带 step-up 令牌仍是 10403）；处理只认 agent.report（只持 agent.trace → 10403）；两个操作都不要 step-up（带有效或乱写的令牌结果不变）；不带令牌 → 10001；被拒的请求不改任何 agent_* 行、不写审计，列表从不写审计', async () => {
  const f = fixture(s);
  const session = await seedSession(f, { startedAt: hoursAgo(f, 5) });
  const a = await seedReport(f, session, { reportedAt: hoursAgo(f, 3), rowVersion: 2 });
  const b = await seedReport(f, session, { reportedAt: hoursAgo(f, 2), rowVersion: 2 });
  const audits = await auditCount(f.db);
  await withReportAdmin(f, async (h) => {
    // The list: agent.trace, with or without any step-up token, the same answer.
    const plain = await page(await h.list());
    expect(plain.total).toBe(2);
    expect(plain.items.map((item) => item['message_id'])).toEqual([a.id, b.id]);
    const totp = await h.stepUp(h.viewer, 'totp');
    const sms = await h.stepUp(h.viewer, 'sms');
    for (const token of [totp, sms, 'not-a-step-up-token']) {
      const headers = { 'x-step-up-token': token };
      expect(await page(await h.list({}, h.viewer, headers))).toEqual(plain);
    }
    expect(await page(await h.list({}, await h.caller([TRACE, REPORT])))).toEqual(plain);

    const nobody = await h.caller([]);
    const others = await h.caller(['fund.view', 'feedback.view', ...PII]);
    for (const who of [h.handler, nobody, others]) {
      await denied(await h.list({}, who));
      await denied(await h.list({ status: 'pending' }, who));
      const token = await h.stepUp(who, 'totp');
      await denied(await h.list({}, who, { 'x-step-up-token': token }));
    }
    await answer(await h.list({}, null), 10001);

    // The handle: agent.trace alone is not enough; refusals change nothing.
    const rowA = await messageRow(f.db, a.id);
    const tables = await agentTables(f.db);
    const body = handleBody('已核对，答复口径已修正', a.rowVersion);
    for (const who of [h.viewer, nobody, others]) {
      await denied(await h.handle(a.id, body, who));
      const token = await h.stepUp(who, 'totp');
      await denied(await h.handle(a.id, body, who, { 'x-step-up-token': token }));
    }
    await answer(await h.handle(a.id, body, null), 10001);
    await answer(await h.handle(a.id, body, null, { 'x-step-up-token': totp }), 10001);
    expect(await messageRow(f.db, a.id)).toEqual(rowA);
    expect(await agentTables(f.db)).toEqual(tables);
    expect(await auditCount(f.db)).toBe(audits);
    expect(await auditRows(f.db, f.appId)).toEqual([]);

    // agent.report alone, no step-up token → handled.
    const first = await reportOf(await h.handle(a.id, body));
    expect(first).toMatchObject({
      message_id: a.id,
      report_status: 'handled',
      handler_id: h.handler.id,
      row_version: a.rowVersion + 1,
    });
    // A step-up token on the request changes nothing.
    f.clock.advanceMs(60_000);
    const token = await h.stepUp(h.handler, 'totp');
    const second = await reportOf(
      await h.handle(b.id, handleBody('已核对', b.rowVersion), h.handler, {
        'x-step-up-token': token,
      }),
    );
    expect(second).toMatchObject({
      message_id: b.id,
      report_status: 'handled',
      handler_id: h.handler.id,
      row_version: b.rowVersion + 1,
    });
    const rows = await auditRows(f.db, f.appId);
    expect(rows.map((row) => [row.action, row.admin_id])).toEqual([
      [AUDIT_ACTION, h.handler.id],
      [AUDIT_ACTION, h.handler.id],
    ]);
    expect(await auditCount(f.db)).toBe(audits + 2);

    // The list still answers agent.trace only, and still writes nothing.
    expect(await ids(await h.list({ status: 'handled' }))).toEqual([b.id, a.id]);
    await denied(await h.list({}, h.handler));
    expect(await auditCount(f.db)).toBe(audits + 2);
  });
});
