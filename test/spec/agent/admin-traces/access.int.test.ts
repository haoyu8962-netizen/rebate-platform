// B1-10q access rule tests (claude-independent, SPEC_REF a36eb936): adminListAgentSessions and
// adminGetAgentSession (CT-24zzi) are guarded by the permission point agent.trace alone (BR-AI-19:
// 后台查看 trace 需要 agent-traces 权限): agent.report or nothing → 10403
// data.reason=admin_permission_denied, no token → 10001, no step-up (an X-Step-Up-Token changes
// nothing). Each successful detail read writes exactly one audit_logs row agent_trace_view with the
// operator and the session (BR-AI-19: 查看操作记审计); a list, a refused or failed detail writes none;
// neither operation changes any agent_* row; pii.* points reveal nothing on this resource.
// Requests go through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  AUDIT_ACTION,
  PII,
  REPORT,
  TRACE,
  agentTables,
  ago,
  answer,
  auditCount,
  auditRows,
  denied,
  detailOf,
  fixture,
  invalid,
  leaksNone,
  otherApp,
  page,
  plus8,
  seedConversation,
  seedMember,
  suite,
  withTraceAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B1-10q#1] 权限：持 agent.trace 的账号列表与明细都 200；只持 agent.report、什么都不持、只持别的点 → 两个操作都 10403 data.reason=admin_permission_denied（带上 step-up 令牌仍是 10403）；不需要 step-up：带有效的 totp / sms 令牌或乱写的令牌结果与不带完全一样；不带令牌 → 10001', async () => {
  const f = fixture(s);
  const member = await seedMember(f);
  const c = await seedConversation(f, { member });
  await withTraceAdmin(f, async (h) => {
    const plainList = await page(await h.list());
    expect(plainList.total).toBe(1);
    expect(plainList.items.map((item) => item['session_id'])).toEqual([c.session.id]);
    const plainDetail = await detailOf(await h.detail(c.session.id));
    expect(plainDetail).toEqual(c.detail);

    const totp = await h.stepUp(h.viewer, 'totp');
    const sms = await h.stepUp(h.viewer, 'sms');
    for (const token of [totp, sms, totp, 'not-a-step-up-token']) {
      const headers = { 'x-step-up-token': token };
      expect(await page(await h.list({}, h.viewer, headers))).toEqual(plainList);
      expect(await detailOf(await h.detail(c.session.id, h.viewer, headers))).toEqual(plainDetail);
    }
    // Still the same without the header after the tokens were sent.
    expect(await page(await h.list())).toEqual(plainList);

    const reporter = await h.caller([REPORT]);
    const nobody = await h.caller([]);
    const others = await h.caller(['fund.view', 'feedback.view', ...PII]);
    for (const who of [reporter, nobody, others]) {
      await denied(await h.list({}, who));
      await denied(await h.list({ session_id: c.session.id }, who));
      await denied(await h.detail(c.session.id, who));
      const token = await h.stepUp(who, 'totp');
      await denied(await h.list({}, who, { 'x-step-up-token': token }));
      await denied(await h.detail(c.session.id, who, { 'x-step-up-token': token }));
    }
    await answer(await h.list({}, null), 10001);
    await answer(await h.detail(c.session.id, null), 10001);
    await answer(await h.detail(c.session.id, null, { 'x-step-up-token': totp }), 10001);
  });
});

it('[AC-B1-10q#2] 审计（BR-AI-19 查看 trace 记审计）：明细每次成功读取恰写一条 audit_logs，action agent_trace_view、操作人是当前后台账号、目标是该 session_id；连读两次 → 两条；别的账号读别的会话 → 第三条带它自己的操作人与会话；审计行里不出现消息文本、举报文本与工具参数', async () => {
  const f = fixture(s);
  const member = await seedMember(f);
  const a = await seedConversation(f, { member });
  const b = await seedConversation(f, { startedAt: ago(f, 300) });
  const before = await auditCount(f.db);
  await withTraceAdmin(f, async (h) => {
    expect(await detailOf(await h.detail(a.session.id))).toEqual(a.detail);
    const first = await auditRows(f.db, f.appId);
    expect(first).toHaveLength(1);
    expect(await auditCount(f.db)).toBe(before + 1);

    expect(await detailOf(await h.detail(a.session.id))).toEqual(a.detail);
    const second = await auditRows(f.db, f.appId);
    expect(second).toHaveLength(2);
    for (const row of second) {
      expect(row).toMatchObject({
        admin_id: h.viewer.id,
        action: AUDIT_ACTION,
        system_actor: null,
      });
      expect(row.target ?? '', row.row).toContain(a.session.id);
      expect(row.target ?? '', row.row).not.toContain(b.session.id);
    }

    const another = await h.caller([TRACE]);
    expect(await detailOf(await h.detail(b.session.id, another))).toEqual(b.detail);
    const third = await auditRows(f.db, f.appId);
    expect(third).toHaveLength(3);
    expect(third.slice(0, 2)).toEqual(second);
    const last = third[2];
    expect(last).toMatchObject({ admin_id: another.id, action: AUDIT_ACTION, system_actor: null });
    expect(last?.target ?? '', last?.row).toContain(b.session.id);
    expect(last?.target ?? '', last?.row).not.toContain(a.session.id);
    expect(await auditCount(f.db)).toBe(before + 3);

    for (const row of third)
      for (const text of [...a.texts, ...b.texts])
        expect(row.row.includes(text), `audit row carries ${text}`).toBe(false);
  });
});

it('[AC-B1-10q#3] 只读：成功的列表（默认、带筛选、翻页过末页）与参数被拒的列表不写审计；10403、20001（不存在、别的 app 的会话）、10001 的明细请求不写审计；两个操作都不改任何 app 的 agent_sessions / agent_runs / agent_messages / agent_tool_calls / agent_cards 任何行', async () => {
  const f = fixture(s);
  const g = otherApp(f);
  const member = await seedMember(f);
  const c = await seedConversation(f, { member });
  const foreign = await seedConversation(g);
  const tables = await agentTables(f.db);
  const audits = await auditCount(f.db);
  await withTraceAdmin(f, async (h) => {
    expect((await page(await h.list())).total).toBe(1);
    const filtered = await page(
      await h.list({
        user_id: member.id,
        session_id: c.session.id,
        badcase: 'true',
        reported: 'true',
        from: plus8(ago(f, 24 * 60)),
        to: plus8(f.clock.now()),
        page: '1',
        page_size: '200',
      }),
    );
    expect(filtered.total).toBe(1);
    expect((await page(await h.list({ page: '2', page_size: '1' }))).items).toEqual([]);
    const at = plus8(ago(f, 60));
    await invalid(await h.list({ from: at, to: at }), ['from', 'to']);
    expect(await auditCount(f.db)).toBe(audits);

    await denied(await h.detail(c.session.id, await h.caller([REPORT])));
    await denied(await h.detail(c.session.id, await h.caller([])));
    await invalid(await h.detail(randomUUID()), ['session_id']);
    await invalid(await h.detail(foreign.session.id), ['session_id']);
    await answer(await h.detail(c.session.id, null), 10001);
    expect(await auditCount(f.db)).toBe(audits);
    expect(await auditRows(f.db, f.appId)).toEqual([]);
    expect(await auditRows(f.db, g.appId)).toEqual([]);

    expect(await detailOf(await h.detail(c.session.id))).toEqual(c.detail);
    expect(await auditCount(f.db)).toBe(audits + 1);
  });
  expect(await agentTables(f.db)).toEqual(tables);
});

it('[AC-B1-10q#4] 脱敏：持 agent.trace 再加任何 pii.* 权限点（单个、全部，带或不带 totp step-up 令牌）或超管，明细与列表和只持 agent.trace 时完全一致，不解开任何内容；响应里查不到设备标识、手机号、user_text、app_id', async () => {
  const f = fixture(s);
  const member = await seedMember(f);
  const c = await seedConversation(f, { member });
  await withTraceAdmin(f, async (h) => {
    const plainSent = await h.detail(c.session.id);
    const plain = await detailOf(plainSent);
    expect(plain).toEqual(c.detail);
    leaksNone(plainSent, c.hidden);
    const plainList = await page(await h.list());
    const callers = [
      await h.caller([TRACE, PII[0]]),
      await h.caller([TRACE, PII[1]]),
      await h.caller([TRACE, ...PII]),
    ];
    for (const who of callers) {
      const sent = await h.detail(c.session.id, who);
      expect(await detailOf(sent)).toEqual(plain);
      leaksNone(sent, c.hidden);
      const token = await h.stepUp(who, 'totp');
      const stepped = await h.detail(c.session.id, who, { 'x-step-up-token': token });
      expect(await detailOf(stepped)).toEqual(plain);
      leaksNone(stepped, c.hidden);
      expect(await page(await h.list({}, who))).toEqual(plainList);
    }
    const root = await h.caller([], { superAdmin: true });
    const rootSent = await h.detail(c.session.id, root);
    expect(await detailOf(rootSent)).toEqual(plain);
    leaksNone(rootSent, c.hidden);
    expect(await page(await h.list({}, root))).toEqual(plainList);
  });
});
