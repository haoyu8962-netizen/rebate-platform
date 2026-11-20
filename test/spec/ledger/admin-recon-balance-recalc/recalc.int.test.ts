// B2-02x success paths (claude-independent, SPEC_REF ba6655b1): recalcBalanceAdminReconDiff
// (CT-24zzn, CT-24zzna) with 08 BR-FUND-19 细则「差异以分录为准修正」 and its 例 (USER_BALANCE
// cache 5000, entries 4900 → 4900): the cache becomes the member-sign entry sums per sub-account
// (available and frozen alike), the handler sends no amount, no voucher and no entry is written,
// version + 1 on a change, an unchanged cache is a success that writes no balance row but an audit
// record (D10-2032 ④), the audit record carries the difference, the member, the trimmed reason,
// `changed` and the values before and after; no wallet push (D10-2033); the difference is not
// closed and no withdraw_holds row is released (D10-2017); the member's own status does not
// matter; only the named member's balance row moves.
import { expect, it } from 'vitest';
import {
  EARLIER,
  RECALC_ACTION,
  audits,
  balanceCache,
  cacheOf,
  entrySums,
  expectRecalcAudit,
  expectRecalculated,
  fixture,
  memberWithStatus,
  plainMember,
  seedHold,
  seedMismatch,
  seedWithdrawal,
  suite,
  tamper,
  untouched,
  withRecalcAdmin,
  written,
} from './kit.ts';

const s = suite();

type Trace = Awaited<ReturnType<typeof untouched>>;

/** notice.int: BALANCE_CORRECTED and contracts/texts.default.json inbox.title.BALANCE_CORRECTED. */
const CODE = 'BALANCE_CORRECTED';
const TITLE = '余额更正';

/** The one notice of a recalculation whose available changed: member, difference, version after. */
interface Notice {
  readonly userId: string;
  readonly diffId: string;
  readonly version: bigint;
}

/** The trace without inbox and notifyLogs (those are checked by expectNotices). */
function apartFromNotices(t: Trace) {
  return {
    vouchers: t.vouchers,
    entries: t.entries,
    events: t.events,
    withdrawals: t.withdrawals,
    holds: t.holds,
    diffs: t.diffs,
  };
}

function sorted<T>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const x = JSON.stringify(a);
    const y = JSON.stringify(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/**
 * The inbox_messages and notify_logs rows there before stay row for row; exactly one inbox message
 * (the member, BALANCE_CORRECTED, 余额更正) and one notify log (the member, BALANCE_CORRECTED, inbox,
 * success, balance_corrected:<difference>:<version after>, as notice.int #49 / #53) per notice are
 * added, nothing else.
 */
function expectNotices(now: Trace, trace: Trace, notices: readonly Notice[]): void {
  const inboxIds = new Set(trace.inbox.map((row) => row.message_id));
  const logIds = new Set(trace.notifyLogs.map((row) => row.id));
  expect(
    now.inbox.filter((row) => inboxIds.has(row.message_id)),
    '原有站内信逐行原样',
  ).toEqual(trace.inbox);
  expect(
    now.notifyLogs.filter((row) => logIds.has(row.id)),
    '原有通知日志逐行原样',
  ).toEqual(trace.notifyLogs);
  expect(
    sorted(
      now.inbox
        .filter((row) => !inboxIds.has(row.message_id))
        .map((row) => ({ user_id: row.user_id, code: row.code, title: row.title })),
    ),
    '新增站内信恰好是本会员本差错单的那一条',
  ).toEqual(sorted(notices.map((n) => ({ user_id: n.userId, code: CODE, title: TITLE }))));
  expect(
    sorted(
      now.notifyLogs
        .filter((row) => !logIds.has(row.id))
        .map((row) => ({
          user_id: row.user_id,
          code: row.code,
          channel: row.channel,
          status: row.status,
          dedupe_key: row.dedupe_key,
        })),
    ),
    '新增通知日志恰好是本会员本差错单的那一条',
  ).toEqual(
    sorted(
      notices.map((n) => ({
        user_id: n.userId,
        code: CODE,
        channel: 'inbox',
        status: 'success',
        dedupe_key: `balance_corrected:${n.diffId}:${n.version.toString()}`,
      })),
    ),
  );
}

it('[AC-B2-02x#14] BR-FUND-19 例：缓存 5000、分录合计 4900 → 应答 before 5000 / after 4900、changed true、recalculated_at 为服务端时钟；余额行改为 4900（frozen 0、negative_since 空、version + 1），凭证与分录一条不多一条不改，审计 recon_diff_balance_recalc 记差错单、会员、去空白的原因、changed 与前后值', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 4900n);
    const before = await tamper(f, m, { available: 5000n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    const trace = await untouched(f);

    const reason = '  分录与订单、提现单据核对无误，按分录重算余额缓存 \n';
    const sent = await h.recalc(diff.id, { reason });
    await expectRecalculated(f, sent, {
      m,
      before: { available: 5000n, frozen: 0n },
      after: { available: 4900n, frozen: 0n },
      changed: true,
    });
    expect(await cacheOf(f, m)).toEqual(
      written(before, { available: 4900n, frozen: 0n, negativeSince: null }),
    );
    expect(await entrySums(f, m)).toEqual({ available: 4900n, frozen: 0n });
    const now = await untouched(f);
    expect(apartFromNotices(now), '凭证、分录、事件、提现单、冻结记录、差错单都不变').toEqual(
      apartFromNotices(trace),
    );
    expectNotices(now, trace, [
      { userId: m.userId, diffId: diff.id, version: (await cacheOf(f, m)).version },
    ]);
    const row = await expectRecalcAudit(f, {
      adminId: h.recon.id,
      diffId: diff.id,
      userId: m.userId,
      reason: reason.trim(),
      changed: true,
      before: { available: 5000n, frozen: 0n },
      after: { available: 4900n, frozen: 0n },
    });
    expect(await audits(f, RECALC_ACTION)).toEqual([row]);
  });
});

it('[AC-B2-02x#15] 两个子户各按自己的分录合计（会员方向 0 − Σ）：有一张已批提现单冻结 1000 时，缓存 available 2600 / frozen 400 → 2000 / 1000；只动这一个会员的余额行，同应用其他会员（缓存同样不准的也算）不动', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 3000n);
    await seedWithdrawal(f, m.userId, { status: 'APPROVED', amount: 1000n });
    expect(await entrySums(f, m)).toEqual({ available: 2000n, frozen: 1000n });
    const other = await plainMember(f, 800n);
    await tamper(f, other, { available: 900n, frozen: 0n, negativeSince: null });
    const before = await tamper(f, m, { available: 2600n, frozen: 400n, negativeSince: null });
    const diff = await seedMismatch(f, m, {}, '06');
    const cache = await balanceCache(f);
    const trace = await untouched(f);

    const sent = await h.recalc(diff.id, { reason: '冻结与提现单核对无误' });
    await expectRecalculated(f, sent, {
      m,
      before: { available: 2600n, frozen: 400n },
      after: { available: 2000n, frozen: 1000n },
      changed: true,
    });
    const after = written(before, { available: 2000n, frozen: 1000n, negativeSince: null });
    expect(await balanceCache(f), '只改这一个会员的余额行').toEqual(
      cache.map((row) => (row.account_id === m.accountId ? after : row)),
    );
    const now = await untouched(f);
    expect(apartFromNotices(now)).toEqual(apartFromNotices(trace));
    expectNotices(now, trace, [
      { userId: m.userId, diffId: diff.id, version: (await cacheOf(f, m)).version },
    ]);
    await expectRecalcAudit(f, {
      adminId: h.recon.id,
      diffId: diff.id,
      userId: m.userId,
      reason: '冻结与提现单核对无误',
      changed: true,
      before: { available: 2600n, frozen: 400n },
      after: { available: 2000n, frozen: 1000n },
    });
  });
});

it('[AC-B2-02x#16] 前后相同也是成功（changed false）：不写余额行（version、negative_since 不变），审计照写一条；同一差错单重算两次，第二次 changed false、before 等于第一次的 after，各留一条审计', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const same = await plainMember(f, 700n);
    const sameDiff = await seedMismatch(f, same);
    const cache = await balanceCache(f);
    const trace = await untouched(f);
    await expectRecalculated(f, await h.recalc(sameDiff.id, { reason: '复核一次' }), {
      m: same,
      before: { available: 700n, frozen: 0n },
      after: { available: 700n, frozen: 0n },
      changed: false,
    });
    expect(await balanceCache(f), 'changed=false 不写余额行').toEqual(cache);
    expect(await untouched(f)).toEqual(trace);
    await expectRecalcAudit(f, {
      adminId: h.recon.id,
      diffId: sameDiff.id,
      userId: same.userId,
      reason: '复核一次',
      changed: false,
      before: { available: 700n, frozen: 0n },
      after: { available: 700n, frozen: 0n },
    });

    const m = await plainMember(f, 4900n);
    const before = await tamper(f, m, { available: 5000n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    await expectRecalculated(f, await h.recalc(diff.id, { reason: '第一次' }), {
      m,
      before: { available: 5000n, frozen: 0n },
      after: { available: 4900n, frozen: 0n },
      changed: true,
    });
    const once = await cacheOf(f, m);
    expect(once).toEqual(written(before, { available: 4900n, frozen: 0n, negativeSince: null }));
    await expectRecalculated(f, await h.recalc(diff.id, { reason: '第二次' }), {
      m,
      before: { available: 4900n, frozen: 0n },
      after: { available: 4900n, frozen: 0n },
      changed: false,
    });
    expect(await cacheOf(f, m), '第二次不写，version 不再加').toEqual(once);
    await expectRecalcAudit(f, {
      adminId: h.recon.id,
      diffId: diff.id,
      userId: m.userId,
      reason: '第二次',
      changed: false,
      before: { available: 4900n, frozen: 0n },
      after: { available: 4900n, frozen: 0n },
    });
    expect(await audits(f, RECALC_ACTION), '三次调用三条审计').toHaveLength(3);
  });
});

it('[AC-B2-02x#17] 不关差错单、不解除冻结（D10-2017）：processing 的差错单重算后 status、handler_id、resolution、updated_at、closed_at 都不变；该单与别的单的 withdraw_holds 记录一条都不解除；超管同样能重算', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 1500n);
    await tamper(f, m, { available: 1800n, frozen: 0n, negativeSince: null });
    const handler = await h.caller([]);
    const diff = await seedMismatch(f, m, {
      status: 'processing',
      handler_id: handler.id,
      resolution: { source: 'ledger_daily_check', invariant: '01', note: '处理中' },
    });
    const own = await seedHold(f, {
      user_id: m.userId,
      reason: 'ledger_mismatch',
      source_ref: `recon_diff:${diff.id}`,
      created_by: 'system',
    });
    const another = await seedHold(f, {
      user_id: m.userId,
      reason: 'ledger_mismatch',
      source_ref: 'recon_diff:00000000-0000-4000-8000-000000000001',
      created_by: 'system',
    });
    const trace = await untouched(f);
    expect(trace.holds.map((row) => row.id).sort()).toEqual([own.id, another.id].sort());

    const boss = await h.caller([], { superAdmin: true });
    await expectRecalculated(f, await h.recalc(diff.id, { reason: '超管重算' }, { caller: boss }), {
      m,
      before: { available: 1800n, frozen: 0n },
      after: { available: 1500n, frozen: 0n },
      changed: true,
    });
    const now = await untouched(f);
    expect(now.diffs, '差错单原样').toEqual(trace.diffs);
    expect(now.holds, '冻结记录都还在、都未解除').toEqual(trace.holds);
    expect(now.holds.every((row) => row.released_at === null && row.released_by === null)).toBe(
      true,
    );
    await expectRecalcAudit(f, {
      adminId: boss.id,
      diffId: diff.id,
      userId: m.userId,
      reason: '超管重算',
      changed: true,
      before: { available: 1800n, frozen: 0n },
      after: { available: 1500n, frozen: 0n },
    });
  });
});

it('[AC-B2-02x#18] 会员自身状态不影响：注销中、已注销的会员缓存照样按分录重算', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    for (const status of ['deleting', 'deleted'] as const) {
      const m = await memberWithStatus(f, status, 600n);
      const before = await tamper(f, m, { available: 0n, frozen: 0n, negativeSince: null });
      const diff = await seedMismatch(f, m);
      await expectRecalculated(f, await h.recalc(diff.id, { reason: `会员${status}` }), {
        m,
        before: { available: 0n, frozen: 0n },
        after: { available: 600n, frozen: 0n },
        changed: true,
      });
      expect(await cacheOf(f, m), status).toEqual(
        written(before, { available: 600n, frozen: 0n, negativeSince: null }),
      );
    }
  });
});

it('[AC-B2-02x#19] 不推送钱包变更（D10-2033）：改大、改小、只改 frozen 的重算都不写 event_log（无 wallet.* 也无别的事件）；站内信只在可提现变了时写（改大、改小各一条 BALANCE_CORRECTED，只改 frozen 不写，D10-2092 ⑤）', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const up = await plainMember(f, 1500n);
    await tamper(f, up, { available: 1000n, frozen: 0n, negativeSince: null });
    const down = await plainMember(f, 200n);
    await tamper(f, down, { available: 900n, frozen: 0n, negativeSince: null });
    const frozen = await plainMember(f, 300n);
    await tamper(f, frozen, { available: 300n, frozen: 50n, negativeSince: null });
    const cases = [
      { m: up, before: 1000n, after: 1500n, frozenBefore: 0n },
      { m: down, before: 900n, after: 200n, frozenBefore: 0n },
      { m: frozen, before: 300n, after: 300n, frozenBefore: 50n },
    ];
    const trace = await untouched(f);
    const notices: Notice[] = [];
    for (const c of cases) {
      const diff = await seedMismatch(f, c.m);
      await expectRecalculated(f, await h.recalc(diff.id, { reason: '核对' }), {
        m: c.m,
        before: { available: c.before, frozen: c.frozenBefore },
        after: { available: c.after, frozen: 0n },
        changed: true,
      });
      if (c.after !== c.before) {
        notices.push({
          userId: c.m.userId,
          diffId: diff.id,
          version: (await cacheOf(f, c.m)).version,
        });
      }
    }
    expect(
      notices.map((n) => n.userId),
      '改大、改小各一条，只改 frozen 没有',
    ).toEqual([up.userId, down.userId]);
    const now = await untouched(f);
    expect(now.events, '没有任何事件').toEqual(trace.events);
    expectNotices(now, trace, notices);
    expect(now.vouchers).toEqual(trace.vouchers);
    expect(now.entries).toEqual(trace.entries);
  });
});

it('[AC-B2-02x#20] negative_since 不在合计里：缓存 available 为负（negative_since 较早）而分录合计为正时，重算写正值并把 negative_since 清空', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 400n);
    const before = await tamper(f, m, { available: -100n, frozen: 0n, negativeSince: EARLIER });
    const diff = await seedMismatch(f, m);
    await expectRecalculated(f, await h.recalc(diff.id, { reason: '回正' }), {
      m,
      before: { available: -100n, frozen: 0n },
      after: { available: 400n, frozen: 0n },
      changed: true,
    });
    expect(await cacheOf(f, m)).toEqual(
      written(before, { available: 400n, frozen: 0n, negativeSince: null }),
    );
  });
});
