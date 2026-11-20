// B2-02x member notice of a recalculation (claude-independent, SPEC_REF ba6655b1; approvals 112):
// D10-2092 ⑤ / D10-2097 and contracts/openapi.yaml recalcBalanceAdminReconDiff「Member notice」— when
// the new available_fen differs from the one read under the lock, the recalculation writes one inbox
// message BALANCE_CORRECTED (title inbox.title.BALANCE_CORRECTED of contracts/texts.default.json) in
// the same transaction as the balance row, through notification's recordBalanceCorrectedMessage
// (B2-02z, wired by app.module): an increase and a decrease alike; a change of frozen_fen only, an
// unchanged cache and a refusal write none; a member whose users.status is deleting or deleted gets
// none (the recalculation itself is done), one in the cooling-off period of a deletion request gets
// it; inbox only — no push, no sms; a rolled-back transaction writes none. Its notify_logs dedupe key
// is balance_corrected:{recon_diff_id}:{the balance row's version after the recalculation}, the pair
// of the D10-2084 source recalc:<recon_diff_id>:<version>: two recoveries of one difference are two
// messages. The body is pinned only by the amounts the recalculation hands over (before / after as
// BR-TEXT-10 App amounts, written out by hand); its wording belongs to B2-02z / B2-02za (D10-2149).
import { expect, it } from 'vitest';
import { deletionRequest } from '../../notification/balance-corrected/db-kit.ts';
import {
  EARLIER,
  answer,
  cacheOf,
  events,
  expectRecalculated,
  fixture,
  memberWithStatus,
  notApplicable,
  plainMember,
  rawVoucher,
  seedMismatch,
  seedWithdrawal,
  shift,
  suite,
  tamper,
  withRecalcAdmin,
  withdrawalNow,
  type AdjustFixture,
  type Member,
} from './kit.ts';

const s = suite();

const CODE = 'BALANCE_CORRECTED';
/** contracts/texts.default.json inbox.title.BALANCE_CORRECTED. */
const TITLE = '余额更正';

/** The member's notify_logs and inbox_messages rows (dedupe keys sorted, inbox by message_id). */
async function notices(f: AdjustFixture, m: Member) {
  const logs = await f.db
    .selectFrom('notify_logs')
    .selectAll()
    .where('app_id', '=', m.appId)
    .where('user_id', '=', m.userId)
    .orderBy('dedupe_key')
    .execute();
  const inbox = await f.db
    .selectFrom('inbox_messages')
    .selectAll()
    .where('app_id', '=', m.appId)
    .where('user_id', '=', m.userId)
    .orderBy('message_id')
    .execute();
  return { logs, inbox };
}

/** The dedupe key of the recalculation's message (D10-2084 pair): the version after the write. */
function dedupeKey(reconDiffId: string, version: bigint): string {
  return `balance_corrected:${reconDiffId}:${version.toString()}`;
}

/**
 * Exactly one inbox notice for the member: one notify_logs row (inbox, success, the dedupe key) and
 * one inbox message BALANCE_CORRECTED with the default title whose body carries the before amount
 * and then the after amount (App format, as the recalculation handed them over).
 */
async function expectOneNotice(
  f: AdjustFixture,
  m: Member,
  e: { readonly key: string; readonly before: string; readonly after: string },
): Promise<void> {
  const { logs, inbox } = await notices(f, m);
  expect(logs, '恰好一条通知日志').toHaveLength(1);
  expect(logs[0]).toMatchObject({
    code: CODE,
    channel: 'inbox',
    status: 'success',
    dedupe_key: e.key,
  });
  expect(inbox, '恰好一条站内信').toHaveLength(1);
  const message = inbox[0]!;
  expect(message).toMatchObject({ code: CODE, title: TITLE });
  const at = message.body.indexOf(e.before);
  expect(at, `${message.body} 含重算前金额 ${e.before}`).toBeGreaterThanOrEqual(0);
  expect(
    message.body.indexOf(e.after, at + e.before.length),
    `${message.body} 在重算前金额之后含重算后金额 ${e.after}`,
  ).toBeGreaterThan(at);
}

it('[AC-B2-02x#49] 调增、调减各写一条站内信 BALANCE_CORRECTED（同一事务、标题「余额更正」、正文带调用方给的前后金额）；通知日志只有站内信一条，去重键 balance_corrected:<差错单>:<重算后余额版本号>；不推送、不发短信、不写事件', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const up = await plainMember(f, 5678n);
    await tamper(f, up, { available: 1234n, frozen: 0n, negativeSince: null });
    const down = await plainMember(f, 2001n);
    await tamper(f, down, { available: 9050n, frozen: 0n, negativeSince: null });
    const cases = [
      { m: up, before: 1234n, after: 5678n, texts: ['¥12.34', '¥56.78'] },
      { m: down, before: 9050n, after: 2001n, texts: ['¥90.5', '¥20.01'] },
    ] as const;
    for (const c of cases) {
      expect(await notices(f, c.m), '重算前没有通知').toEqual({ logs: [], inbox: [] });
      const diff = await seedMismatch(f, c.m);
      await expectRecalculated(f, await h.recalc(diff.id, { reason: '按分录重算' }), {
        m: c.m,
        before: { available: c.before, frozen: 0n },
        after: { available: c.after, frozen: 0n },
        changed: true,
      });
      const version = (await cacheOf(f, c.m)).version;
      await expectOneNotice(f, c.m, {
        key: dedupeKey(diff.id, version),
        before: c.texts[0],
        after: c.texts[1],
      });
    }
    expect(await events(f), '不推送：没有任何事件').toEqual([]);
  });
});

it('[AC-B2-02x#50] 不写站内信：只改 frozen（可提现前后相同）、前后都相同、拒绝（frozen 合计为负）都没有通知日志、没有站内信', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const frozenOnly = await plainMember(f, 400n);
    await seedWithdrawal(f, frozenOnly.userId, { status: 'APPROVED', amount: 100n });
    await tamper(f, frozenOnly, { available: 300n, frozen: 0n, negativeSince: null });
    const same = await plainMember(f, 700n);
    const refused = await plainMember(f, 0n);
    await shift(f, refused.userId, 400n);
    await rawVoucher(f, refused, [
      { sub_account: 'frozen', amount_fen: 50n },
      { sub_account: 'available', amount_fen: -50n },
    ]);
    const refusedCache = await tamper(f, refused, {
      available: 100n,
      frozen: 0n,
      negativeSince: null,
    });

    const frozenDiff = await seedMismatch(f, frozenOnly, {}, '06');
    await expectRecalculated(f, await h.recalc(frozenDiff.id, { reason: '只差冻结' }), {
      m: frozenOnly,
      before: { available: 300n, frozen: 0n },
      after: { available: 300n, frozen: 100n },
      changed: true,
    });
    const sameDiff = await seedMismatch(f, same);
    await expectRecalculated(f, await h.recalc(sameDiff.id, { reason: '复核' }), {
      m: same,
      before: { available: 700n, frozen: 0n },
      after: { available: 700n, frozen: 0n },
      changed: false,
    });
    const refusedDiff = await seedMismatch(f, refused);
    await notApplicable(await h.recalc(refusedDiff.id, { reason: '冻结为负' }));
    expect(await cacheOf(f, refused)).toEqual(refusedCache);

    for (const [label, m] of [
      ['只改 frozen', frozenOnly],
      ['前后相同', same],
      ['拒绝', refused],
    ] as const) {
      expect(await notices(f, m), label).toEqual({ logs: [], inbox: [] });
    }
  });
});

it('[AC-B2-02x#51] 会员状态（D10-2097）：users.status 为 deleting、deleted 的会员照样重算但不写站内信；注销冷静期（status normal、注销申请 cooling）照写一条', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    for (const status of ['deleting', 'deleted'] as const) {
      const m = await memberWithStatus(f, status, 600n);
      await tamper(f, m, { available: 0n, frozen: 0n, negativeSince: null });
      const diff = await seedMismatch(f, m);
      await expectRecalculated(f, await h.recalc(diff.id, { reason: `会员${status}` }), {
        m,
        before: { available: 0n, frozen: 0n },
        after: { available: 600n, frozen: 0n },
        changed: true,
      });
      expect(await notices(f, m), status).toEqual({ logs: [], inbox: [] });
    }

    const cooling = await memberWithStatus(f, 'normal', 600n);
    await deletionRequest(f.db, { appId: cooling.appId, uid: cooling.userId }, 'cooling');
    await tamper(f, cooling, { available: 0n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, cooling);
    await expectRecalculated(f, await h.recalc(diff.id, { reason: '冷静期' }), {
      m: cooling,
      before: { available: 0n, frozen: 0n },
      after: { available: 600n, frozen: 0n },
      changed: true,
    });
    await expectOneNotice(f, cooling, {
      key: dedupeKey(diff.id, (await cacheOf(f, cooling)).version),
      before: '¥0',
      after: '¥6',
    });
  });
});

it('[AC-B2-02x#52] 同一事务：重算在写余额或写审计时失败 → 50001，没有通知日志、没有站内信；再调一次即恰好一条', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 1500n);
    const cache = await tamper(f, m, { available: 1000n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    for (const point of ['balance', 'audit'] as const) {
      const tripped = h.fault.tripped;
      h.fault.point = point;
      const sent = await h.recalc(diff.id, { reason: `失败于 ${point}` });
      expect(h.fault.tripped, `${point} 必须在重算事务里执行`).toBe(tripped + 1);
      h.fault.point = null;
      await answer(sent, 50001);
      expect(await cacheOf(f, m), point).toEqual(cache);
      expect(await notices(f, m), `${point} 回滚后没有站内信`).toEqual({ logs: [], inbox: [] });
    }
    await expectRecalculated(f, await h.recalc(diff.id, { reason: '重试' }), {
      m,
      before: { available: 1000n, frozen: 0n },
      after: { available: 1500n, frozen: 0n },
      changed: true,
    });
    await expectOneNotice(f, m, {
      key: dedupeKey(diff.id, cache.version + 1n),
      before: '¥10',
      after: '¥15',
    });
  });
});

it('[AC-B2-02x#53] D10-2084：同一差错单两次回正（缓存 −200 → 分录 500，缓存再漂成 −200 后再重算）→ 两个不同的重算后版本、两条站内信，去重键分别带这两个版本；第一次回正解除 NEGATIVE_BALANCE 拦截，两次都不发事件', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 100n);
    const withdrawalId = await seedWithdrawal(f, m.userId, {
      status: 'APPROVED',
      amount: 100n,
      blocked: true,
    });
    await shift(f, m.userId, 500n);
    const row = await withdrawalNow(f, withdrawalId);
    expect(row.blocked_reason).toBe('NEGATIVE_BALANCE');
    const first = await tamper(f, m, { available: -200n, frozen: 100n, negativeSince: EARLIER });
    const diff = await seedMismatch(f, m);

    await expectRecalculated(f, await h.recalc(diff.id, { reason: '第一次回正' }), {
      m,
      before: { available: -200n, frozen: 100n },
      after: { available: 500n, frozen: 100n },
      changed: true,
    });
    expect((await withdrawalNow(f, withdrawalId)).blocked_reason, '第一次回正解除拦截').toBeNull();
    const once = await cacheOf(f, m);
    expect(once.version).toBe(first.version + 1n);

    const drifted = await tamper(f, m, { available: -200n, frozen: 100n, negativeSince: EARLIER });
    expect(drifted.version, '漂移不改 version').toBe(once.version);
    await expectRecalculated(f, await h.recalc(diff.id, { reason: '第二次回正' }), {
      m,
      before: { available: -200n, frozen: 100n },
      after: { available: 500n, frozen: 100n },
      changed: true,
    });
    const twice = await cacheOf(f, m);
    expect(twice.version).toBe(once.version + 1n);

    const { logs, inbox } = await notices(f, m);
    expect(logs.map((log) => log.dedupe_key).sort()).toEqual(
      [dedupeKey(diff.id, once.version), dedupeKey(diff.id, twice.version)].sort(),
    );
    expect(
      logs.every((log) => log.channel === 'inbox' && log.code === CODE),
      '只有站内信',
    ).toBe(true);
    expect(inbox, '两次回正两条站内信').toHaveLength(2);
    for (const message of inbox) {
      expect(message).toMatchObject({ code: CODE, title: TITLE });
      expect(message.body).toContain('-¥2');
      expect(message.body).toContain('¥5');
    }
    expect(await events(f), '回正不发事件').toEqual([]);
  });
});

// B2-02xb (claude-independent, B2-02x Codex r5 / r6 S1, D10-2198 / D10-2200): the notice is an
// insert only — rows the member already has (an older BALANCE_CORRECTED message still unread and its
// notify log, a message and a log of another code, the notice of an earlier recalculation) stay
// exactly as they were, every column; the one new message and log are this recalculation's.

it('[AC-B2-02xb#1] 预置旧通知不被改写：会员已有一条未读的旧 BALANCE_CORRECTED 站内信及其通知日志、一条别的 code 的已读站内信及其通知日志 → 重算（可提现变化）后预置的站内信与通知日志逐行全字段原样（旧站内信 read_at 仍为 NULL，通知日志 status / dedupe_key / 时间戳不变），新增恰为本差错单一条站内信（会员、BALANCE_CORRECTED、余额更正）与一条通知日志（会员、BALANCE_CORRECTED、inbox、success、去重键 balance_corrected:<差错单>:<重算后版本>）', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 2500n);
    const earlier = new Date('2026-11-10T01:00:00.000Z');
    const read = new Date('2026-11-11T01:00:00.000Z');
    const oldMessage = crypto.randomUUID();
    const otherMessage = crypto.randomUUID();
    const oldLog = crypto.randomUUID();
    const otherLog = crypto.randomUUID();
    await f.db
      .insertInto('inbox_messages')
      .values([
        {
          message_id: oldMessage,
          app_id: m.appId,
          user_id: m.userId,
          code: CODE,
          title: TITLE,
          body: '核对账目时发现你的余额显示与流水明细不一致，已按流水明细更正：可用余额由 ¥1 调整为 ¥2。',
          route: null,
          read_at: null,
          row_version: 0,
          created_at: earlier,
          updated_at: earlier,
        },
        {
          message_id: otherMessage,
          app_id: m.appId,
          user_id: m.userId,
          code: 'WITHDRAW_PAID',
          title: '合成旧通知',
          body: '合成旧通知正文',
          route: null,
          read_at: read,
          row_version: 1,
          created_at: earlier,
          updated_at: read,
        },
      ])
      .execute();
    await f.db
      .insertInto('notify_logs')
      .values([
        {
          id: oldLog,
          app_id: m.appId,
          user_id: m.userId,
          code: CODE,
          channel: 'inbox',
          dedupe_key: `balance_corrected:${crypto.randomUUID()}:3`,
          planned_at: earlier,
          sent_at: earlier,
          status: 'success',
          row_version: 0,
          created_at: earlier,
          updated_at: earlier,
          suppress_reason: null,
          sms_biz_id: null,
        },
        {
          id: otherLog,
          app_id: m.appId,
          user_id: m.userId,
          code: 'WITHDRAW_PAID',
          channel: 'push',
          dedupe_key: `withdraw_paid:${crypto.randomUUID()}`,
          planned_at: earlier,
          sent_at: null,
          status: 'suppressed',
          row_version: 2,
          created_at: earlier,
          updated_at: read,
          suppress_reason: 'push_disabled',
          sms_biz_id: null,
        },
      ])
      .execute();
    const seeded = await notices(f, m);
    expect(seeded.inbox.map((row) => row.message_id).sort(), '预置的两条站内信在库').toEqual(
      [oldMessage, otherMessage].sort(),
    );
    expect(seeded.logs.map((row) => row.id).sort(), '预置的两条通知日志在库').toEqual(
      [oldLog, otherLog].sort(),
    );
    expect(
      seeded.inbox.find((row) => row.message_id === oldMessage),
      '旧 BALANCE_CORRECTED 未读',
    ).toMatchObject({ code: CODE, read_at: null });

    await tamper(f, m, { available: 1000n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    await expectRecalculated(f, await h.recalc(diff.id, { reason: '旧通知在库' }), {
      m,
      before: { available: 1000n, frozen: 0n },
      after: { available: 2500n, frozen: 0n },
      changed: true,
    });
    const version = (await cacheOf(f, m)).version;

    const after = await notices(f, m);
    const oldInbox = new Set(seeded.inbox.map((row) => row.message_id));
    const oldLogs = new Set(seeded.logs.map((row) => row.id));
    expect(
      after.inbox.filter((row) => oldInbox.has(row.message_id)),
      '预置站内信逐行全字段原样（read_at 仍为 NULL）',
    ).toEqual(seeded.inbox);
    expect(
      after.logs.filter((row) => oldLogs.has(row.id)),
      '预置通知日志逐行全字段原样',
    ).toEqual(seeded.logs);
    const freshInbox = after.inbox.filter((row) => !oldInbox.has(row.message_id));
    const freshLogs = after.logs.filter((row) => !oldLogs.has(row.id));
    expect(freshInbox, '新增恰好一条站内信').toHaveLength(1);
    expect(freshInbox[0]).toMatchObject({
      app_id: m.appId,
      user_id: m.userId,
      code: CODE,
      title: TITLE,
      read_at: null,
    });
    expect(freshLogs, '新增恰好一条通知日志').toHaveLength(1);
    expect(freshLogs[0]).toMatchObject({
      app_id: m.appId,
      user_id: m.userId,
      code: CODE,
      channel: 'inbox',
      status: 'success',
      dedupe_key: dedupeKey(diff.id, version),
    });
  });
});

it('[AC-B2-02xb#2] 同一会员连续两次重算（两次可提现都变）：第一次写的站内信与通知日志在第二次之后逐行全字段原样，第二次新增恰为一条站内信与一条通知日志，去重键 balance_corrected:<第二张差错单>:<第二次重算后版本>', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 800n);
    const start = await tamper(f, m, { available: 100n, frozen: 0n, negativeSince: null });
    const firstDiff = await seedMismatch(f, m);
    await expectRecalculated(f, await h.recalc(firstDiff.id, { reason: '第一次' }), {
      m,
      before: { available: 100n, frozen: 0n },
      after: { available: 800n, frozen: 0n },
      changed: true,
    });
    const once = await notices(f, m);
    expect(once.logs, '第一次一条通知日志').toHaveLength(1);
    expect(once.inbox, '第一次一条站内信').toHaveLength(1);
    expect(once.logs[0]).toMatchObject({
      dedupe_key: dedupeKey(firstDiff.id, start.version + 1n),
    });

    await tamper(f, m, { available: 300n, frozen: 0n, negativeSince: null });
    // recon_diffs_business_key is UNIQUE (app_id, type, period, ref_id): the second difference of the
    // same account is the next day's check (kit PERIOD 2026-11-17 → 2026-11-18).
    const nextPeriod = '2026-11-18';
    const secondDiff = await seedMismatch(f, m, {
      period: nextPeriod,
      resolution: { source: 'ledger_daily_check', accounting_date: nextPeriod, invariant: '01' },
    });
    expect(secondDiff.id, '第二张差错单').not.toBe(firstDiff.id);
    await expectRecalculated(f, await h.recalc(secondDiff.id, { reason: '第二次' }), {
      m,
      before: { available: 300n, frozen: 0n },
      after: { available: 800n, frozen: 0n },
      changed: true,
    });
    const version = (await cacheOf(f, m)).version;
    expect(version, '第二次 version 再 +1').toBe(start.version + 2n);

    const twice = await notices(f, m);
    const firstInbox = new Set(once.inbox.map((row) => row.message_id));
    const firstLogs = new Set(once.logs.map((row) => row.id));
    expect(
      twice.inbox.filter((row) => firstInbox.has(row.message_id)),
      '第一次的站内信逐行全字段原样',
    ).toEqual(once.inbox);
    expect(
      twice.logs.filter((row) => firstLogs.has(row.id)),
      '第一次的通知日志逐行全字段原样',
    ).toEqual(once.logs);
    const freshInbox = twice.inbox.filter((row) => !firstInbox.has(row.message_id));
    const freshLogs = twice.logs.filter((row) => !firstLogs.has(row.id));
    expect(freshInbox, '第二次新增恰好一条站内信').toHaveLength(1);
    expect(freshInbox[0]).toMatchObject({
      user_id: m.userId,
      code: CODE,
      title: TITLE,
      read_at: null,
    });
    expect(freshLogs, '第二次新增恰好一条通知日志').toHaveLength(1);
    expect(freshLogs[0]).toMatchObject({
      user_id: m.userId,
      code: CODE,
      channel: 'inbox',
      status: 'success',
      dedupe_key: dedupeKey(secondDiff.id, version),
    });
  });
});
