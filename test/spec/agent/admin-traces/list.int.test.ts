// B1-10q list rule tests (claude-independent, SPEC_REF a36eb936): adminListAgentSessions
// (GET /admin/v1/agent-traces/sessions, CT-24zzi). Each item is exactly the contract's 8 fields; a
// guest session (BR-AI-20, owned by a device) and a session whose owner's deletion completed
// (BR-AI-22, user_id cleared) have user_id null; run_count counts agent_runs, badcase_count the
// replies marked badcase, report_count the reported replies (pending or handled); expired follows
// BR-AI-20 (last_active_at + 24 h ≤ now, or expired_at set and passed). No phone number, device id,
// user_hash, app_id or message text in the response. Filters user_id / session_id / badcase /
// reported / from (inclusive) / to (exclusive) on started_at combine with AND; from not earlier
// than to → 20001 data.fields=[from, to]. started_at descending; equal started_at in a
// server-internal order that pages without duplicates or gaps; total counts the filter set.
// Top-level it() only (规划/11 §4.3).
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ago,
  fixture,
  ids,
  invalid,
  leaksNone,
  page,
  plus,
  plus8,
  seedMember,
  seedSession,
  seedTurn,
  sessionItem,
  suite,
  withTraceAdmin,
  type Session,
} from './kit.ts';

const s = suite();

it('[AC-B1-10q#5] 列表字段：每项恰为契约 8 个字段；游客会话与注销后会话 user_id 为 null，登录用户会话带其 user_id；run_count = 该会话 agent_runs 行数、badcase_count = badcase 的回复数（踩与人工标记都算）、report_count = 被举报（pending 或 handled）的回复数；expired 按 last_active_at + 24 小时 ≤ now 或 expired_at 已到；整份 JSON 查不到手机号、device_id、user_hash、app_id、任何消息文本', async () => {
  const f = fixture(s);
  const u = await seedMember(f);
  const v = await seedMember(f);
  const userHash = randomBytes(32).toString('hex');
  // A: guest, active; six runs, two badcase replies, three reported replies.
  const A = await seedSession(f, { startedAt: ago(f, 300), lastActiveAt: ago(f, 60) });
  // B: member u, idle exactly 24 hours → expired; no runs.
  const B = await seedSession(f, {
    userId: u.id,
    startedAt: ago(f, 25 * 60),
    lastActiveAt: ago(f, 24 * 60),
  });
  // C: member v, expired_at set and passed → expired.
  const C = await seedSession(f, {
    userId: v.id,
    startedAt: ago(f, 5 * 60),
    lastActiveAt: ago(f, 4 * 60),
    expiredAt: ago(f, 3 * 60),
  });
  // D: the owner's deletion completed (user_id cleared, user_hash set), active.
  const D = await seedSession(f, {
    userId: null,
    userHash,
    startedAt: ago(f, 90),
    lastActiveAt: ago(f, 30),
  });
  // E: member u, idle 23 h 59 min → not expired.
  const E = await seedSession(f, {
    userId: u.id,
    startedAt: ago(f, 24 * 60),
    lastActiveAt: ago(f, 24 * 60 - 1),
  });
  const turns = [
    await seedTurn(f, A, ago(f, 290), { feedback: 'down' }),
    await seedTurn(f, A, ago(f, 280), { badcase: true, report: 'pending' }),
    await seedTurn(f, A, ago(f, 270), { feedback: 'up', report: 'handled' }),
    await seedTurn(f, A, ago(f, 260), null),
    await seedTurn(f, A, ago(f, 250), { report: 'pending' }),
    await seedTurn(f, A, ago(f, 240), { feedback: 'up' }),
    await seedTurn(f, C, ago(f, 4 * 60), { feedback: 'up' }),
    await seedTurn(f, D, ago(f, 40), { feedback: 'down', report: 'pending' }),
  ];
  const expected = new Map<string, Record<string, unknown>>([
    [A.id, sessionItem(A, { expired: false, run_count: 6, badcase_count: 2, report_count: 3 })],
    [B.id, sessionItem(B, { expired: true, run_count: 0, badcase_count: 0, report_count: 0 })],
    [C.id, sessionItem(C, { expired: true, run_count: 1, badcase_count: 0, report_count: 0 })],
    [D.id, sessionItem(D, { expired: false, run_count: 1, badcase_count: 1, report_count: 1 })],
    [E.id, sessionItem(E, { expired: false, run_count: 0, badcase_count: 0, report_count: 0 })],
  ]);
  await withTraceAdmin(f, async (h) => {
    const sent = await h.list({ page_size: '200' });
    const result = await page(sent);
    expect(result.total).toBe(5);
    expect(result.items).toHaveLength(5);
    for (const item of result.items) {
      const id = String(item['session_id']);
      expect(expected.has(id), id).toBe(true);
      expect(item, id).toEqual(expected.get(id));
    }
    expect(new Set(result.items.map((item) => item['session_id'])).size).toBe(5);
    const userIds = new Map(result.items.map((item) => [item['session_id'], item['user_id']]));
    expect(userIds.get(A.id)).toBeNull();
    expect(userIds.get(D.id)).toBeNull();
    expect(userIds.get(B.id)).toBe(u.id);
    expect(userIds.get(C.id)).toBe(v.id);
    leaksNone(sent, [
      f.appId,
      userHash,
      u.phone,
      u.phoneHmac,
      v.phone,
      v.phoneHmac,
      ...[A, B, C, D, E].map((session) => session.deviceId),
      ...turns.flatMap((turn) => turn.texts),
    ]);
  });
});

it('[AC-B1-10q#6] 列表筛选：user_id、session_id、badcase、reported 各自生效且可组合（AND）；from 含、to 不含（按 started_at，带 +08:00 或 Z 都行）；total 与筛选一致；from 不早于 to（相等也算）→ 20001 data.fields=[from, to]', async () => {
  const f = fixture(s);
  const U = await seedMember(f);
  const V = await seedMember(f);
  const hours = (n: number): Date => ago(f, n * 60);
  const S1 = await seedSession(f, { userId: U.id, startedAt: hours(50) });
  const S2 = await seedSession(f, { userId: U.id, startedAt: hours(40) });
  const S3 = await seedSession(f, { userId: V.id, startedAt: hours(30) });
  const S4 = await seedSession(f, { startedAt: hours(20) });
  const S5 = await seedSession(f, { userId: V.id, startedAt: hours(10) });
  const S6 = await seedSession(f, { startedAt: hours(5) });
  const at = (session: Session, minutes: number): Date => plus(session.startedAt, minutes * 60_000);
  await seedTurn(f, S1, at(S1, 1), { feedback: 'down' });
  await seedTurn(f, S2, at(S2, 1), { report: 'pending' });
  await seedTurn(f, S3, at(S3, 1), { badcase: true, report: 'handled' });
  await seedTurn(f, S4, at(S4, 1), { feedback: 'up' });
  await seedTurn(f, S6, at(S6, 1), { feedback: 'down' });
  await seedTurn(f, S6, at(S6, 2), { report: 'pending' });
  const id = (session: Session): string => session.id;
  const cases: [Record<string, string>, Session[]][] = [
    [{}, [S6, S5, S4, S3, S2, S1]],
    [{ user_id: U.id }, [S2, S1]],
    [{ user_id: V.id }, [S5, S3]],
    [{ session_id: S3.id }, [S3]],
    [{ session_id: S4.id }, [S4]],
    [{ badcase: 'true' }, [S6, S3, S1]],
    [{ badcase: 'false' }, [S5, S4, S2]],
    [{ reported: 'true' }, [S6, S3, S2]],
    [{ reported: 'false' }, [S5, S4, S1]],
    [{ user_id: V.id, badcase: 'true' }, [S3]],
    [{ user_id: U.id, reported: 'true' }, [S2]],
    [{ badcase: 'true', reported: 'false' }, [S1]],
    [{ badcase: 'false', reported: 'false' }, [S5, S4]],
    [{ badcase: 'true', reported: 'true' }, [S6, S3]],
    [{ from: S2.startedAt.toISOString(), to: S4.startedAt.toISOString() }, [S3, S2]],
    [{ from: plus8(S2.startedAt), to: plus8(S4.startedAt) }, [S3, S2]],
    [{ from: plus8(S5.startedAt) }, [S6, S5]],
    [{ to: plus8(S2.startedAt) }, [S1]],
    [{ from: plus8(plus(S2.startedAt, 1000)), to: plus8(plus(S4.startedAt, 1000)) }, [S4, S3]],
    [
      {
        from: plus8(S2.startedAt),
        to: plus8(S4.startedAt),
        reported: 'true',
        user_id: V.id,
      },
      [S3],
    ],
    [{ session_id: S1.id, badcase: 'false' }, []],
    [{ session_id: S1.id, user_id: V.id }, []],
    [{ user_id: randomUUID() }, []],
  ];
  await withTraceAdmin(f, async (h) => {
    for (const [query, sessions] of cases) {
      const label = JSON.stringify(query);
      const result = await page(await h.list({ ...query, page_size: '200' }));
      expect(
        result.items.map((item) => item['session_id']),
        label,
      ).toEqual(sessions.map(id));
      expect(result.total, label).toBe(sessions.length);
    }
    const same = plus8(S3.startedAt);
    await invalid(await h.list({ from: same, to: same }), ['from', 'to']);
    await invalid(await h.list({ from: plus8(S4.startedAt), to: plus8(S2.startedAt) }), [
      'from',
      'to',
    ]);
    await invalid(
      await h.list({ from: S3.startedAt.toISOString(), to: plus8(S3.startedAt), badcase: 'true' }),
      ['from', 'to'],
    );
  });
});

it('[AC-B1-10q#7] 列表排序与翻页：按 started_at 倒序；同一 started_at 的多行翻完所有页恰得全集、不重不漏（page_size 2 与 3）；末页之后 items 为空；每页 total 都是筛选后的总数、page / page_size 照回；带筛选翻页同样不重不漏', async () => {
  const f = fixture(s);
  const T0 = ago(f, 180);
  const newer = await seedSession(f, { startedAt: ago(f, 120) });
  const older = await seedSession(f, { startedAt: ago(f, 240) });
  const tied: Session[] = [];
  for (let index = 0; index < 5; index += 1) tied.push(await seedSession(f, { startedAt: T0 }));
  const marked = [tied[0]!, tied[2]!, tied[4]!];
  for (const session of marked) await seedTurn(f, session, plus(T0, 60_000), { feedback: 'down' });
  await seedTurn(f, tied[1]!, plus(T0, 60_000), { feedback: 'up' });
  const all = [newer, ...tied, older].map((session) => session.id);
  await withTraceAdmin(f, async (h) => {
    const full = await page(await h.list({ page_size: '200' }));
    expect(full.total).toBe(7);
    const order = full.items.map((item) => item['session_id']);
    expect(order[0]).toBe(newer.id);
    expect(order[6]).toBe(older.id);
    expect(new Set(order.slice(1, 6))).toEqual(new Set(tied.map((session) => session.id)));
    const starts = full.items.map((item) => Number(item['started_at']));
    for (let index = 1; index < starts.length; index += 1)
      expect(starts[index - 1]! >= starts[index]!, `${String(index)}`).toBe(true);

    for (const size of [2, 3]) {
      const seen: unknown[] = [];
      const pages = Math.ceil(7 / size);
      for (let number = 1; number <= pages; number += 1) {
        const result = await page(await h.list({ page: String(number), page_size: String(size) }));
        expect(result.total).toBe(7);
        expect(result.page).toBe(number);
        expect(result.page_size).toBe(size);
        expect(result.items.length).toBe(number < pages ? size : 7 - size * (pages - 1));
        seen.push(...result.items.map((item) => item['session_id']));
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      expect(new Set(seen)).toEqual(new Set(all));
      expect(seen[0]).toBe(newer.id);
      expect(seen[6]).toBe(older.id);
      const after = await page(await h.list({ page: String(pages + 1), page_size: String(size) }));
      expect(after.items).toEqual([]);
      expect(after.total).toBe(7);
    }

    const seen: unknown[] = [];
    for (const number of [1, 2]) {
      const sent = await h.list({ badcase: 'true', page: String(number), page_size: '2' });
      const result = await page(sent);
      expect(result.total).toBe(3);
      seen.push(...(await ids(sent)));
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen)).toEqual(new Set(marked.map((session) => session.id)));
  });
});
