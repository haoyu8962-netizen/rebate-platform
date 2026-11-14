// B1-10t list rule tests (claude-independent, SPEC_REF 62b5c993): adminListAgentReports
// (GET /admin/v1/agent-traces/reports, CT-24zzi). 08 BR-ID-15: 举报在 48 小时内处理完毕，时限从举报
// 提交起算（例：9-29 10:00 提交 → 最迟 10-01 10:00 前标为已处理，否则超时告警）. One row per reported
// reply of the console's app, exactly the contract's 13 fields: deadline_at = reported_at + 48 h;
// overdue = pending and now ≥ deadline_at (handled → always false); handler_name = the handling
// admin account's display name; user_id null for a guest session. Reports of other apps and
// replies never reported do not show and are not counted. Filters status / overdue / from
// (inclusive) / to (exclusive) on reported_at combine with AND; from not earlier than to → 20001
// data.fields=[from, to]. Order: pending first by reported_at ascending, then handled by handled_at
// descending; pages without duplicates or gaps. No message text in a row. Top-level it() only.
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  DEADLINE_MS,
  SECOND,
  agentTables,
  auditCount,
  fixture,
  hoursAgo,
  ids,
  invalid,
  leaksNone,
  marker,
  otherApp,
  page,
  plus,
  plus8,
  reportItem,
  seedHandler,
  seedMember,
  seedReport,
  seedSession,
  seedUnreported,
  suite,
  withReportAdmin,
  type Handling,
  type Report,
} from './kit.ts';

const s = suite();

function byId(items: readonly Record<string, unknown>[]): Map<unknown, Record<string, unknown>> {
  return new Map(items.map((item) => [item['message_id'], item]));
}

it('[AC-B1-10t#2] 列表字段与口径：每项恰为契约 13 个字段且逐字段等于库里的举报（deadline_at = reported_at + 48 小时；overdue 只对待处理且已到 deadline_at 的为 true，已处理恒 false，含超时后才处理的；handler_name 为处理人后台账号的展示名；游客会话与注销后会话 user_id 为 null，登录用户会话带其 user_id；注销后 report_reason 为 null 照样列出）；别的 app 的举报不出现、不计 total；未被举报的回复与用户消息不出现；响应里查不到消息文本、设备标识、手机号、user_hash、app_id；列表不改库、不写审计', async () => {
  const f = fixture(s);
  const g = otherApp(f);
  const member = await seedMember(f);
  const userHash = randomBytes(32).toString('hex');
  const guest = await seedSession(f, { startedAt: hoursAgo(f, 120) });
  const owned = await seedSession(f, { userId: member.id, startedAt: hoursAgo(f, 120) });
  const erased = await seedSession(f, { userId: null, userHash, startedAt: hoursAgo(f, 120) });
  const first = await seedHandler(f);
  const second = await seedHandler(f);
  // Pending, 50 h old: overdue.
  const stale = await seedReport(f, guest, { reportedAt: hoursAgo(f, 50) });
  // Pending, 10 h old: not overdue; a member's session.
  const fresh = await seedReport(f, owned, { reportedAt: hoursAgo(f, 10), rowVersion: 3 });
  // Handled in time (reported 70 h ago, handled 30 h ago).
  const inTime = await seedReport(f, owned, {
    reportedAt: hoursAgo(f, 70),
    rowVersion: 4,
    handled: { by: first, at: hoursAgo(f, 30), note: marker('已核对答复口径已修正') },
  });
  // Handled after its deadline (reported 100 h ago, handled 40 h ago): still not overdue.
  const late = await seedReport(f, guest, {
    reportedAt: hoursAgo(f, 100),
    rowVersion: 2,
    handled: { by: second, at: hoursAgo(f, 40), note: marker('超时后处理') },
  });
  // The owner's deletion completed: reason cleared, the report kept.
  const gone = await seedReport(f, erased, { reportedAt: hoursAgo(f, 5), reason: null });
  const reports = [stale, fresh, inTime, late, gone];
  const plain = await seedUnreported(f, guest, hoursAgo(f, 6));
  const foreignSession = await seedSession(g, { startedAt: hoursAgo(f, 80) });
  const foreign = await seedReport(g, foreignSession, { reportedAt: hoursAgo(f, 60) });
  const foreignHandled = await seedReport(g, foreignSession, {
    reportedAt: hoursAgo(f, 70),
    handled: { by: await seedHandler(g), at: hoursAgo(f, 65), note: marker('别的 app') },
  });
  const tables = await agentTables(f.db);
  const audits = await auditCount(f.db);
  await withReportAdmin(f, async (h) => {
    const now = f.clock.now();
    const sent = await h.list({ page_size: '200' });
    const result = await page(sent);
    expect(result.total).toBe(5);
    expect(result.page).toBe(1);
    expect(result.page_size).toBe(200);
    expect(result.items).toHaveLength(5);
    const rows = byId(result.items);
    expect(rows.size).toBe(5);
    for (const r of reports) expect(rows.get(r.id), r.id).toEqual(reportItem(r, now));
    for (const r of reports)
      expect(rows.get(r.id)?.['deadline_at'], r.id).toBe(r.reportedAt.getTime() + DEADLINE_MS);
    expect(rows.get(stale.id)).toMatchObject({ report_status: 'pending', overdue: true });
    expect(rows.get(fresh.id)).toMatchObject({ user_id: member.id, overdue: false });
    expect(rows.get(inTime.id)).toMatchObject({
      report_status: 'handled',
      overdue: false,
      handler_id: first.id,
      handler_name: first.name,
    });
    expect(rows.get(late.id)).toMatchObject({ overdue: false, handler_name: second.name });
    expect(rows.get(gone.id)).toMatchObject({ user_id: null, report_reason: null });
    expect(rows.get(stale.id)?.['user_id']).toBeNull();
    for (const absent of [plain.replyId, plain.questionId, foreign.id, foreignHandled.id])
      expect(rows.has(absent), absent).toBe(false);
    leaksNone(sent, [
      f.appId,
      g.appId,
      userHash,
      member.phone,
      member.phoneHmac,
      guest.deviceId,
      owned.deviceId,
      erased.deviceId,
      plain.replyId,
      plain.questionId,
      foreign.id,
      foreignHandled.id,
      ...reports.flatMap((r) => [...r.texts, r.questionId]),
      ...plain.texts,
      ...foreign.texts,
    ]);
    // Other filters never let another app's reports in either.
    const queries: Record<string, string>[] = [
      { status: 'pending' },
      { status: 'handled' },
      { overdue: 'true' },
    ];
    for (const query of queries) {
      const filtered = await page(await h.list({ ...query, page_size: '200' }));
      expect(filtered.items.some((item) => item['message_id'] === foreign.id)).toBe(false);
      expect(filtered.items.some((item) => item['message_id'] === foreignHandled.id)).toBe(false);
    }
    expect((await page(await h.list({ overdue: 'true' }))).total).toBe(1);
  });
  expect(await agentTables(f.db)).toEqual(tables);
  expect(await auditCount(f.db)).toBe(audits);
});

it('[AC-B1-10t#3] 48 小时边界（BR-ID-15 例：9-29 10:00 提交 → 10-01 10:00 到期）：deadline_at = reported_at + 48 小时；恰好满 48 小时算超时、差 1 秒不算、多 1 秒算；注入时钟走 1 秒后差 1 秒那条变为超时；已处理恒 false；overdue=true / false 筛选与每行的 overdue 一致', async () => {
  const f = fixture(s);
  const session = await seedSession(f, { startedAt: hoursAgo(f, 60) });
  const handler = await seedHandler(f);
  const now = f.clock.now();
  const exact = await seedReport(f, session, { reportedAt: plus(now, -DEADLINE_MS) });
  const early = await seedReport(f, session, { reportedAt: plus(now, -DEADLINE_MS + SECOND) });
  const past = await seedReport(f, session, { reportedAt: plus(now, -DEADLINE_MS - SECOND) });
  const done = await seedReport(f, session, {
    reportedAt: hoursAgo(f, 50),
    handled: { by: handler, at: hoursAgo(f, 1), note: marker('已处理') },
  });
  const all = [exact, early, past, done];
  await withReportAdmin(f, async (h) => {
    const before = byId((await page(await h.list({ page_size: '200' }))).items);
    expect(before.size).toBe(4);
    for (const r of all) expect(before.get(r.id), r.id).toEqual(reportItem(r, now));
    expect(before.get(exact.id)?.['deadline_at']).toBe(now.getTime());
    expect(before.get(early.id)?.['deadline_at']).toBe(now.getTime() + SECOND);
    expect(before.get(exact.id)?.['overdue']).toBe(true);
    expect(before.get(early.id)?.['overdue']).toBe(false);
    expect(before.get(past.id)?.['overdue']).toBe(true);
    expect(before.get(done.id)?.['overdue']).toBe(false);
    expect(await ids(await h.list({ overdue: 'true' }))).toEqual([past.id, exact.id]);
    expect(await ids(await h.list({ overdue: 'false' }))).toEqual([early.id, done.id]);

    f.clock.advanceMs(SECOND);
    const later = f.clock.now();
    const after = byId((await page(await h.list({ page_size: '200' }))).items);
    for (const r of all) expect(after.get(r.id), r.id).toEqual(reportItem(r, later));
    expect(after.get(early.id)?.['overdue']).toBe(true);
    expect(after.get(done.id)?.['overdue']).toBe(false);
    expect(await ids(await h.list({ overdue: 'true' }))).toEqual([past.id, exact.id, early.id]);
    expect(await ids(await h.list({ overdue: 'false' }))).toEqual([done.id]);
  });
});

it('[AC-B1-10t#4] 列表筛选：status、overdue、from / to（按 reported_at，from 含、to 不含，带 +08:00 或 Z 都行）各自生效且可组合（AND）；total 与筛选一致、不计别的 app；from 不早于 to（相等也算）→ 20001 data.fields=[from, to]；status 取值以外 → 20001 [status]；page_size 超 200 → 20001 [page_size]', async () => {
  const f = fixture(s);
  const g = otherApp(f);
  const session = await seedSession(f, { startedAt: hoursAgo(f, 70) });
  const handler = await seedHandler(f);
  const done = (hours: number): Handling => ({
    by: handler,
    at: hoursAgo(f, hours),
    note: marker('已处理'),
  });
  const r1 = await seedReport(f, session, { reportedAt: hoursAgo(f, 60) });
  const r2 = await seedReport(f, session, { reportedAt: hoursAgo(f, 47) });
  const r3 = await seedReport(f, session, { reportedAt: hoursAgo(f, 55), handled: done(50) });
  const r4 = await seedReport(f, session, { reportedAt: hoursAgo(f, 49) });
  const r5 = await seedReport(f, session, { reportedAt: hoursAgo(f, 10), handled: done(5) });
  const r6 = await seedReport(f, session, { reportedAt: hoursAgo(f, 2) });
  await seedUnreported(f, session, hoursAgo(f, 48));
  const foreignSession = await seedSession(g, { startedAt: hoursAgo(f, 70) });
  await seedReport(g, foreignSession, { reportedAt: hoursAgo(f, 49) });
  await seedReport(g, foreignSession, { reportedAt: hoursAgo(f, 3) });
  const at = (r: Report): string => plus8(r.reportedAt);
  const z = (r: Report): string => r.reportedAt.toISOString();
  const cases: [Record<string, string>, Report[]][] = [
    [{}, [r1, r4, r2, r6, r5, r3]],
    [{ status: 'pending' }, [r1, r4, r2, r6]],
    [{ status: 'handled' }, [r5, r3]],
    [{ overdue: 'true' }, [r1, r4]],
    [{ overdue: 'false' }, [r2, r6, r5, r3]],
    [{ status: 'pending', overdue: 'true' }, [r1, r4]],
    [{ status: 'pending', overdue: 'false' }, [r2, r6]],
    [{ status: 'handled', overdue: 'true' }, []],
    [{ status: 'handled', overdue: 'false' }, [r5, r3]],
    [{ from: at(r4) }, [r4, r2, r6, r5]],
    [{ to: at(r4) }, [r1, r3]],
    [{ from: at(r3), to: at(r2) }, [r4, r3]],
    [{ from: z(r3), to: z(r2) }, [r4, r3]],
    [{ from: z(r3), to: at(r2) }, [r4, r3]],
    [
      { from: plus8(plus(r3.reportedAt, SECOND)), to: plus8(plus(r2.reportedAt, SECOND)) },
      [r4, r2],
    ],
    [{ from: at(r3), to: at(r2), status: 'pending' }, [r4]],
    [{ from: at(r3), to: at(r2), status: 'handled' }, [r3]],
    [{ from: at(r4), overdue: 'true' }, [r4]],
    [{ from: at(r3), to: at(r2), overdue: 'false' }, [r3]],
    [{ from: at(r1), to: at(r6), status: 'pending', overdue: 'false' }, [r2]],
    [{ from: at(r6) }, [r6]],
    [{ to: at(r1) }, []],
  ];
  await withReportAdmin(f, async (h) => {
    for (const [query, expected] of cases) {
      const label = JSON.stringify(query);
      const result = await page(await h.list({ ...query, page_size: '200' }));
      expect(
        result.items.map((item) => item['message_id']),
        label,
      ).toEqual(expected.map((r) => r.id));
      expect(result.total, label).toBe(expected.length);
    }
    await invalid(await h.list({ from: at(r3), to: at(r3) }), ['from', 'to']);
    await invalid(await h.list({ from: z(r3), to: at(r3) }), ['from', 'to']);
    await invalid(await h.list({ from: at(r2), to: at(r3) }), ['from', 'to']);
    await invalid(await h.list({ from: at(r2), to: at(r3), status: 'pending' }), ['from', 'to']);
    await invalid(await h.list({ status: 'closed' }), ['status']);
    await invalid(await h.list({ page_size: '201' }), ['page_size']);
  });
});

it('[AC-B1-10t#5] 列表排序与翻页：待处理在前按 reported_at 升序、已处理在后按 handled_at 倒序（与 reported_at 先后无关）；同一时刻的多行翻完所有页恰得全集、不重不漏（page_size 3 与 4）；末页之后 items 为空；每页 total 都是筛选后的总数、page / page_size 照回；带筛选翻页同样不重不漏', async () => {
  const f = fixture(s);
  const g = otherApp(f);
  const session = await seedSession(f, { startedAt: hoursAgo(f, 50) });
  const handler = await seedHandler(f);
  const done = (hours: number): Handling => ({
    by: handler,
    at: hoursAgo(f, hours),
    note: marker('已处理'),
  });
  const T = hoursAgo(f, 30);
  const oldest = await seedReport(f, session, { reportedAt: hoursAgo(f, 40) });
  const tiedPending: Report[] = [];
  for (let index = 0; index < 3; index += 1)
    tiedPending.push(await seedReport(f, session, { reportedAt: T }));
  // The newest pending report is newer than every handled one but still comes before them.
  const newest = await seedReport(f, session, { reportedAt: hoursAgo(f, 8) });
  // Handled order differs from report order: the first reported is the latest handled.
  const latest = await seedReport(f, session, { reportedAt: hoursAgo(f, 45), handled: done(1) });
  const tiedHandled: Report[] = [];
  for (const hours of [44, 20, 9])
    tiedHandled.push(
      await seedReport(f, session, { reportedAt: hoursAgo(f, hours), handled: done(3) }),
    );
  const earliest = await seedReport(f, session, { reportedAt: hoursAgo(f, 12), handled: done(7) });
  await seedReport(g, await seedSession(g), { reportedAt: T });
  const pending = [oldest, ...tiedPending, newest].map((r) => r.id);
  const handled = [latest, ...tiedHandled, earliest].map((r) => r.id);
  const all = [...pending, ...handled];
  await withReportAdmin(f, async (h) => {
    const full = await page(await h.list({ page_size: '200' }));
    expect(full.total).toBe(10);
    const order = full.items.map((item) => item['message_id']);
    expect(order[0]).toBe(oldest.id);
    expect(new Set(order.slice(1, 4))).toEqual(new Set(tiedPending.map((r) => r.id)));
    expect(order[4]).toBe(newest.id);
    expect(order[5]).toBe(latest.id);
    expect(new Set(order.slice(6, 9))).toEqual(new Set(tiedHandled.map((r) => r.id)));
    expect(order[9]).toBe(earliest.id);
    const reported = full.items.slice(0, 5).map((item) => Number(item['reported_at']));
    for (let index = 1; index < reported.length; index += 1)
      expect(reported[index - 1]! <= reported[index]!, String(index)).toBe(true);
    const handledAt = full.items.slice(5).map((item) => Number(item['handled_at']));
    for (let index = 1; index < handledAt.length; index += 1)
      expect(handledAt[index - 1]! >= handledAt[index]!, String(index)).toBe(true);

    for (const size of [3, 4]) {
      const seen: unknown[] = [];
      const pages = Math.ceil(10 / size);
      for (let number = 1; number <= pages; number += 1) {
        const result = await page(await h.list({ page: String(number), page_size: String(size) }));
        expect(result.total).toBe(10);
        expect(result.page).toBe(number);
        expect(result.page_size).toBe(size);
        expect(result.items.length).toBe(number < pages ? size : 10 - size * (pages - 1));
        seen.push(...result.items.map((item) => item['message_id']));
      }
      expect(seen).toHaveLength(10);
      expect(new Set(seen).size).toBe(10);
      expect(new Set(seen)).toEqual(new Set(all));
      expect(seen[0]).toBe(oldest.id);
      expect(seen[4]).toBe(newest.id);
      expect(seen[5]).toBe(latest.id);
      expect(seen[9]).toBe(earliest.id);
      const after = await page(await h.list({ page: String(pages + 1), page_size: String(size) }));
      expect(after.items).toEqual([]);
      expect(after.total).toBe(10);
    }

    for (const [status, expected] of [
      ['pending', pending],
      ['handled', handled],
    ] as const) {
      const seen: unknown[] = [];
      for (const number of [1, 2, 3]) {
        const sent = await h.list({ status, page: String(number), page_size: '2' });
        const result = await page(sent);
        expect(result.total, status).toBe(5);
        seen.push(...(await ids(sent)));
      }
      expect(seen, status).toHaveLength(5);
      expect(new Set(seen), status).toEqual(new Set(expected));
    }
  });
});
