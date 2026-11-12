// B1-10t handle rule tests (claude-independent, SPEC_REF 62b5c993): adminHandleAgentReport
// (POST /admin/v1/agent-traces/reports/{message_id}/handle, CT-24zzi). 08 BR-ID-15 细则「举报的
// 处理」: 处理人查看对话、标记已处理并填写处理说明，写审计；超时只是告警，不拒绝处理. Pending → handled
// in one transaction: report_status=handled, report_handler_id = the operator, report_handled_at =
// the injected clock, report_note = the note trimmed of leading and trailing whitespace,
// row_version + 1; the answer is the report row (the list row's shape). Exactly one audit
// agent_report_handle with target agent_messages:<message_id> (B1-10s), before / after carrying the
// status and the note, never the message text. note empty after trimming or over 500 → 20001
// [note]; unknown body fields → 20001; unknown message, another app's, never reported → 20001
// [message_id], the same answer; expected_row_version not matching or already handled → 20902
// data.resource=agent_report, nothing changed; refusals write no audit; two concurrent handles of
// one report with the same expected_row_version: exactly one wins. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  AUDIT_ACTION,
  REPORT,
  TRACE,
  afterHandle,
  agentTables,
  auditCount,
  auditRows,
  conflict,
  fixture,
  handleBody,
  hoursAgo,
  ids,
  invalid,
  leaksNone,
  marker,
  messageRow,
  otherApp,
  page,
  reportItem,
  reportOf,
  seedHandler,
  seedMember,
  seedReport,
  seedSession,
  seedUnreported,
  suite,
  untouched,
  withReportAdmin,
  without,
  withoutTrace,
  type AdminCaller,
  type Report,
} from './kit.ts';

const s = suite();

it('[AC-B1-10t#6] 处理成功：待处理 → 已处理，库里写 report_status=handled、report_handler_id=当前账号、report_handled_at=注入时钟、report_note=去首尾空白后的说明、row_version + 1，其余列与别的行不变；响应恰为该举报行（与列表行同形且相同：overdue false、handled_at、handler_id、handler_name 为当前账号展示名）；恰写一条审计 agent_report_handle，操作人为当前账号、目标 agent_messages:<message_id>、前值含 pending、后值含 handled 与说明，审计与响应都不含消息文本', async () => {
  const f = fixture(s);
  const g = otherApp(f);
  const member = await seedMember(f);
  const session = await seedSession(f, { userId: member.id, startedAt: hoursAgo(f, 5) });
  const r = await seedReport(f, session, { reportedAt: hoursAgo(f, 3), rowVersion: 3 });
  const other = await seedReport(f, session, { reportedAt: hoursAgo(f, 2), rowVersion: 3 });
  await seedReport(g, await seedSession(g), { reportedAt: hoursAgo(f, 3), rowVersion: 3 });
  const core = marker('已核对答复口径已修正');
  await withReportAdmin(f, async (h) => {
    const before = await messageRow(f.db, r.id);
    const tables = await agentTables(f.db);
    const audits = await auditCount(f.db);
    f.clock.advanceMs(7 * 60_000);
    const at = f.clock.now();
    const sent = await h.handle(r.id, handleBody(`  \t${core}\n `, r.rowVersion));
    const row = await reportOf(sent);
    expect(row).toEqual(reportItem(afterHandle(r, h.handler, at, core), at));
    expect(row).toMatchObject({
      message_id: r.id,
      session_id: session.id,
      user_id: member.id,
      report_status: 'handled',
      overdue: false,
      handled_at: at.getTime(),
      handler_id: h.handler.id,
      handler_name: h.handler.name,
      report_note: core,
      row_version: r.rowVersion + 1,
    });
    leaksNone(sent, [...r.texts, f.appId, session.deviceId, member.phone]);

    const after = await messageRow(f.db, r.id);
    expect(after['report_status']).toBe('handled');
    expect(after['report_handler_id']).toBe(h.handler.id);
    expect(Date.parse(String(after['report_handled_at']))).toBe(at.getTime());
    expect(after['report_note']).toBe(core);
    expect(after['row_version']).toBe(r.rowVersion + 1);
    expect(untouched(after)).toEqual(untouched(before));
    expect(without(await agentTables(f.db), [r.id])).toEqual(without(tables, [r.id]));

    expect(await auditCount(f.db)).toBe(audits + 1);
    const rows = await auditRows(f.db, f.appId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      admin_id: h.handler.id,
      action: AUDIT_ACTION,
      target: `agent_messages:${r.id}`,
      system_actor: null,
    });
    const audit = rows[0]!;
    expect(audit.before ?? '', audit.row).toContain('"pending"');
    expect(audit.after ?? '', audit.row).toContain('"handled"');
    expect(audit.after ?? '', audit.row).toContain(JSON.stringify(core));
    for (const text of [...r.texts, ...other.texts])
      expect(audit.row.includes(text), `audit carries ${text}`).toBe(false);
    expect(await auditRows(f.db, g.appId)).toEqual([]);

    const listed = await page(await h.list({ page_size: '200' }));
    expect(listed.total).toBe(2);
    expect(listed.items.find((item) => item['message_id'] === r.id)).toEqual(row);
    expect(listed.items.find((item) => item['message_id'] === other.id)).toEqual(
      reportItem(other, at),
    );
    expect(await ids(await h.list({ status: 'handled' }))).toEqual([r.id]);
    expect(await ids(await h.list({ status: 'pending' }))).toEqual([other.id]);
  });
});

it('[AC-B1-10t#7] 超时后照样可处理（超时只是标记，不拒绝）：已超 48 小时的待处理举报处理成功，此后 overdue 为 false、overdue=true 筛选不再含它；说明恰 500 字照存；说明首尾的空格、制表符、换行去掉、中间空白保留；游客会话的举报 user_id 为 null；每次成功各写一条审计', async () => {
  const f = fixture(s);
  const session = await seedSession(f, { startedAt: hoursAgo(f, 80) });
  const stale = await seedReport(f, session, { reportedAt: hoursAgo(f, 72), rowVersion: 1 });
  const long = await seedReport(f, session, { reportedAt: hoursAgo(f, 30), rowVersion: 7 });
  const spaced = await seedReport(f, session, { reportedAt: hoursAgo(f, 20), rowVersion: 0 });
  await withReportAdmin(f, async (h) => {
    const now = f.clock.now();
    const overdue = await page(await h.list({ overdue: 'true' }));
    expect(overdue.items).toEqual([reportItem(stale, now)]);
    expect(overdue.items[0]?.['overdue']).toBe(true);

    const note = marker('超时后补处理');
    const row = await reportOf(await h.handle(stale.id, handleBody(note, 1)));
    expect(row).toEqual(reportItem(afterHandle(stale, h.handler, now, note), now));
    expect(row).toMatchObject({ user_id: null, overdue: false, report_status: 'handled' });
    expect(await ids(await h.list({ overdue: 'true' }))).toEqual([]);
    expect((await page(await h.list({ status: 'handled' }))).items).toEqual([row]);

    const max = marker('满').padEnd(500, '字');
    expect(max).toHaveLength(500);
    const longRow = await reportOf(await h.handle(long.id, handleBody(max, 7)));
    expect(longRow).toEqual(reportItem(afterHandle(long, h.handler, now, max), now));
    expect((await messageRow(f.db, long.id))['report_note']).toBe(max);

    const inner = marker('中间 保留\t空白');
    const sent = await h.handle(spaced.id, handleBody(`\n\t  ${inner} \t\r\n`, 0));
    const spacedRow = await reportOf(sent);
    expect(spacedRow).toEqual(reportItem(afterHandle(spaced, h.handler, now, inner), now));
    expect(spacedRow['row_version']).toBe(1);
    expect((await messageRow(f.db, spaced.id))['report_note']).toBe(inner);

    const rows = await auditRows(f.db, f.appId);
    expect(rows.map((entry) => [entry.action, entry.target, entry.admin_id])).toEqual([
      [AUDIT_ACTION, `agent_messages:${stale.id}`, h.handler.id],
      [AUDIT_ACTION, `agent_messages:${long.id}`, h.handler.id],
      [AUDIT_ACTION, `agent_messages:${spaced.id}`, h.handler.id],
    ]);
  });
});

it('[AC-B1-10t#8] 请求体：说明为空串、只有空白（空格 / 制表符 / 换行）、超 500 字、不是字符串、缺失 → 20001 data.fields=[note]；expected_row_version 缺失、负数、字符串 → 20001 [expected_row_version]；请求体带契约以外的字段 → 20001（fields 为该字段）；这些都不改库、不写审计，之后用正确的请求照常处理', async () => {
  const f = fixture(s);
  const session = await seedSession(f, { startedAt: hoursAgo(f, 5) });
  const r = await seedReport(f, session, { reportedAt: hoursAgo(f, 3), rowVersion: 2 });
  const cases: [Record<string, unknown>, string[]][] = [
    [{ note: '', expected_row_version: 2 }, ['note']],
    [{ note: '   ', expected_row_version: 2 }, ['note']],
    [{ note: ' \t\n\r ', expected_row_version: 2 }, ['note']],
    [{ note: 'x'.repeat(501), expected_row_version: 2 }, ['note']],
    [{ note: '字'.repeat(501), expected_row_version: 2 }, ['note']],
    [{ note: 123, expected_row_version: 2 }, ['note']],
    [{ note: null, expected_row_version: 2 }, ['note']],
    [{ expected_row_version: 2 }, ['note']],
    [{ note: '已核对' }, ['expected_row_version']],
    [{ note: '已核对', expected_row_version: -1 }, ['expected_row_version']],
    [{ note: '已核对', expected_row_version: '2' }, ['expected_row_version']],
    [{ note: '已核对', expected_row_version: 2, priority: 'high' }, ['priority']],
    [{ note: '已核对', expected_row_version: 2, report_status: 'handled' }, ['report_status']],
  ];
  await withReportAdmin(f, async (h) => {
    const row = await messageRow(f.db, r.id);
    const tables = await agentTables(f.db);
    const audits = await auditCount(f.db);
    for (const [body, fields] of cases) await invalid(await h.handle(r.id, body), fields);
    expect(await messageRow(f.db, r.id)).toEqual(row);
    expect(await agentTables(f.db)).toEqual(tables);
    expect(await auditCount(f.db)).toBe(audits);
    expect(await auditRows(f.db, f.appId)).toEqual([]);

    const now = f.clock.now();
    const note = marker('已核对');
    expect(await reportOf(await h.handle(r.id, handleBody(note, 2)))).toEqual(
      reportItem(afterHandle(r, h.handler, now, note), now),
    );
    expect(await auditRows(f.db, f.appId)).toHaveLength(1);
  });
});

it('[AC-B1-10t#9] message_id：不存在的消息、别的 app 的举报、本 app 未被举报的回复、用户消息 → 都是 20001 data.fields=[message_id]，响应除 trace_id 外完全一致（不可探测）；不改任何 app 的库、不写审计；持 agent.trace 与 agent.report 两个点也一样；本 app 的举报照常可处理', async () => {
  const f = fixture(s);
  const g = otherApp(f);
  const session = await seedSession(f, { startedAt: hoursAgo(f, 5) });
  const own = await seedReport(f, session, { reportedAt: hoursAgo(f, 3), rowVersion: 1 });
  const plain = await seedUnreported(f, session, hoursAgo(f, 4));
  const foreign = await seedReport(g, await seedSession(g), {
    reportedAt: hoursAgo(f, 3),
    rowVersion: 1,
  });
  const targets: [string, number][] = [
    [randomUUID(), 1],
    [foreign.id, 1],
    [plain.replyId, 0],
    [plain.questionId, 0],
    [own.questionId, 0],
  ];
  await withReportAdmin(f, async (h) => {
    const tables = await agentTables(f.db);
    const audits = await auditCount(f.db);
    const both = await h.caller([TRACE, REPORT]);
    const answers: Record<string, unknown>[] = [];
    for (const [id, version] of targets) {
      for (const who of [h.handler, both]) {
        const sent = await h.handle(id, handleBody('已核对', version), who);
        await invalid(sent, ['message_id']);
        leaksNone(sent, foreign.texts);
        answers.push(withoutTrace(sent));
      }
    }
    for (const entry of answers) expect(entry).toEqual(answers[0]);
    expect(await agentTables(f.db)).toEqual(tables);
    expect(await auditCount(f.db)).toBe(audits);
    expect(await auditRows(f.db, f.appId)).toEqual([]);
    expect(await auditRows(f.db, g.appId)).toEqual([]);

    const now = f.clock.now();
    const note = marker('已核对');
    expect(await reportOf(await h.handle(own.id, handleBody(note, 1)))).toEqual(
      reportItem(afterHandle(own, h.handler, now, note), now),
    );
  });
});

it('[AC-B1-10t#10] CAS：expected_row_version 比库里小、大或为 0 → 20902 data.resource=agent_report；已是已处理的举报（带旧版本、带当前版本、换一个账号）→ 20902；20902 时库里不变、不写审计、已存的说明不被覆盖；只有版本相符的待处理举报处理成功', async () => {
  const f = fixture(s);
  const session = await seedSession(f, { startedAt: hoursAgo(f, 40) });
  const earlier = await seedHandler(f);
  const r = await seedReport(f, session, { reportedAt: hoursAgo(f, 3), rowVersion: 5 });
  const prior = await seedReport(f, session, {
    reportedAt: hoursAgo(f, 30),
    rowVersion: 2,
    handled: { by: earlier, at: hoursAgo(f, 20), note: marker('早已处理') },
  });
  await withReportAdmin(f, async (h) => {
    const start = await messageRow(f.db, r.id);
    for (const version of [4, 6, 0])
      await conflict(await h.handle(r.id, handleBody('版本不符', version)));
    expect(await messageRow(f.db, r.id)).toEqual(start);
    expect(await auditRows(f.db, f.appId)).toEqual([]);

    const now = f.clock.now();
    const note = marker('第一次处理');
    expect(await reportOf(await h.handle(r.id, handleBody(note, 5)))).toEqual(
      reportItem(afterHandle(r, h.handler, now, note), now),
    );
    const handled = await messageRow(f.db, r.id);
    const once = await auditRows(f.db, f.appId);
    expect(once).toHaveLength(1);

    f.clock.advanceMs(60_000);
    const colleague = await h.caller([REPORT], { displayName: marker('同事') });
    const repeats: [number, AdminCaller][] = [
      [5, h.handler],
      [6, h.handler],
      [6, colleague],
      [7, colleague],
    ];
    for (const [version, who] of repeats)
      await conflict(await h.handle(r.id, handleBody(marker('第二次处理'), version), who));
    expect(await messageRow(f.db, r.id)).toEqual(handled);
    expect(handled['report_note']).toBe(note);

    const priorRow = await messageRow(f.db, prior.id);
    for (const version of [1, 2, 3])
      await conflict(await h.handle(prior.id, handleBody('再处理一次', version)));
    expect(await messageRow(f.db, prior.id)).toEqual(priorRow);
    expect(await auditRows(f.db, f.appId)).toEqual(once);

    const listed = await page(await h.list({ status: 'handled' }));
    expect(listed.items).toEqual([
      reportItem(afterHandle(r, h.handler, now, note), f.clock.now()),
      reportItem(prior, f.clock.now()),
    ]);
  });
});

it('[AC-B1-10t#11] 并发：同一举报两个处理请求（两个持 agent.report 的账号）同时带同一 expected_row_version → 恰一个成功、另一个 20902 data.resource=agent_report；库里是胜者的处理人与说明、row_version 只 + 1；每个举报只写一条审计（操作人为胜者）；连做四个举报', async () => {
  const f = fixture(s);
  const session = await seedSession(f, { startedAt: hoursAgo(f, 20) });
  const reports: Report[] = [];
  for (const hours of [10, 11, 12, 13])
    reports.push(await seedReport(f, session, { reportedAt: hoursAgo(f, hours), rowVersion: 2 }));
  await withReportAdmin(f, async (h) => {
    const a = h.handler;
    const b = await h.caller([REPORT], { displayName: marker('同事') });
    for (const r of reports) {
      const noteA = marker('甲处理');
      const noteB = marker('乙处理');
      const [sentA, sentB] = await Promise.all([
        h.handle(r.id, handleBody(noteA, 2), a),
        h.handle(r.id, handleBody(noteB, 2), b),
      ]);
      const statuses = [sentA.statusCode, sentB.statusCode].sort((x, y) => x - y);
      expect(statuses, `${sentA.body} ${sentB.body}`).toEqual([200, 409]);
      const aWon = sentA.statusCode === 200;
      const winner = aWon ? a : b;
      const note = aWon ? noteA : noteB;
      await conflict(aWon ? sentB : sentA);
      const row = await reportOf(aWon ? sentA : sentB);
      expect(row).toMatchObject({
        message_id: r.id,
        report_status: 'handled',
        handler_id: winner.id,
        handler_name: winner.name,
        report_note: note,
        row_version: 3,
      });
      expect(await messageRow(f.db, r.id)).toMatchObject({
        report_status: 'handled',
        report_handler_id: winner.id,
        report_note: note,
        row_version: 3,
      });
      const audits = (await auditRows(f.db, f.appId)).filter(
        (entry) => entry.target === `agent_messages:${r.id}`,
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ admin_id: winner.id, action: AUDIT_ACTION });
    }
    expect(await auditRows(f.db, f.appId)).toHaveLength(reports.length);
  });
});
