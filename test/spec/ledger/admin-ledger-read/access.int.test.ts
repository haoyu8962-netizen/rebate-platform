// B2-02u access rule tests (claude-independent, SPEC_REF 39756e36): contracts/openapi.yaml
// adminGetUserFundSummary, adminListLedgerEntries — fund.view or user.lookup (either one) or a super
// admin, no step-up; anything else 10403, no token 10001; the two points get the same shape and the
// same values (D10-1057 ①); no answer carries memo / operator / note / reject_note / source_ref /
// created_by at any depth; reading writes nothing. Requests go through the real admin entry
// (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  HIDDEN_KEYS,
  INTERNAL_TEXT,
  LOOKUP,
  VIEW,
  answer,
  audits,
  books,
  denied,
  fixture,
  keysDeep,
  ok,
  openMember,
  seedHold,
  seedStory,
  seedWithdrawal,
  suite,
  withLedgerAdmin,
  type Fixture,
} from './kit.ts';

const s = suite();

/** One member with entries, a paid and a rejected withdrawal, and an active hold. */
async function seeded(f: Fixture) {
  const story = await seedStory(f, { a: await openMember(f), b: await openMember(f) });
  const userId = story.a.userId;
  await seedWithdrawal(f, userId, 400n, 'PAID_API');
  await seedWithdrawal(f, userId, 150n, 'REJECTED', `${INTERNAL_TEXT}-reject-note`);
  await seedHold(f, {
    user_id: userId,
    reason: 'manual',
    source_ref: `${INTERNAL_TEXT}-source-ref`,
    created_by: `${INTERNAL_TEXT}-created-by`,
  });
  return story;
}

it('[AC-B2-02u#1] 权限：只持 fund.view、只持 user.lookup、两者都持、超管都能读两个接口（不要 step-up）；只持 fund.recon、只持 fund.adjust、没有权限点 → 10403；不带令牌 → 10001', async () => {
  const f = fixture(s);
  const { a } = await seeded(f);
  await withLedgerAdmin(f, async (h) => {
    for (const who of [
      await h.caller([VIEW]),
      await h.caller([LOOKUP]),
      await h.caller([VIEW, LOOKUP]),
      await h.caller([], { superAdmin: true }),
    ]) {
      const summary = (await ok(await h.summary(a.userId, who))) as Record<string, unknown>;
      expect(summary['user_id']).toBe(a.userId);
      const page = (await ok(await h.ledger({ user_id: a.userId }, who))) as { total: number };
      expect(page.total).toBe(6);
    }
    for (const permissions of [['fund.recon'], ['fund.adjust'], []]) {
      const who = await h.caller(permissions);
      await denied(await h.summary(a.userId, who));
      await denied(await h.ledger({ user_id: a.userId }, who));
    }
    await answer(await h.summary(a.userId, null), 10001);
    await answer(await h.ledger({ user_id: a.userId }, null), 10001);
  });
});

it('[AC-B2-02u#2] 两种权限同形同值：只持 user.lookup 与只持 fund.view（及超管）对同一用户的余额卡与每一页流水，data 逐字相同', async () => {
  const f = fixture(s);
  const { a } = await seeded(f);
  await withLedgerAdmin(f, async (h) => {
    const viewer = await h.caller([VIEW]);
    const lookup = await h.caller([LOOKUP]);
    const root = await h.caller([], { superAdmin: true });
    const queries: Record<string, string>[] = [
      { user_id: a.userId },
      { user_id: a.userId, page: '2', page_size: '4' },
      { user_id: a.userId, sub_account: 'frozen' },
    ];
    const summaryData = await ok(await h.summary(a.userId, viewer));
    expect(summaryData).toMatchObject({ withdrawn_fen: 400 });
    for (const other of [lookup, root]) {
      const sent = await h.summary(a.userId, other);
      expect(JSON.stringify(await ok(sent))).toBe(JSON.stringify(summaryData));
    }
    for (const query of queries) {
      const want = await ok(await h.ledger(query, viewer));
      for (const other of [lookup, root]) {
        expect(JSON.stringify(await ok(await h.ledger(query, other))), JSON.stringify(query)).toBe(
          JSON.stringify(want),
        );
      }
    }
  });
});

it('[AC-B2-02u#3] 不含内部备注：凭证 memo / operator、提现驳回备注、冻结记录 source_ref / created_by 有值时，两个接口在两种权限下的响应任意层级都没有 memo、operator、note、reject_note、source_ref、created_by 键，也不出现这些内部文本', async () => {
  const f = fixture(s);
  const { a, v4 } = await seeded(f);
  await withLedgerAdmin(f, async (h) => {
    for (const who of [await h.caller([VIEW]), await h.caller([LOOKUP])]) {
      const summarySent = await h.summary(a.userId, who);
      const summary = (await ok(summarySent)) as Record<string, unknown>;
      expect(summary['withdraw_block']).toEqual({ blocked: true, hold_kinds: ['manual'] });
      const ledgerSent = await h.ledger({ user_id: a.userId, page_size: '200' }, who);
      const page = (await ok(ledgerSent)) as { items: { voucher: { uniq_key: string } }[] };
      expect(page.items.map((item) => item.voucher.uniq_key)).toContain(v4.uniqKey);
      for (const sent of [summarySent, ledgerSent]) {
        const keys = keysDeep(JSON.parse(sent.body));
        for (const hidden of HIDDEN_KEYS)
          expect(keys.has(hidden), `${hidden}: ${sent.body}`).toBe(false);
        expect(sent.body.includes(INTERNAL_TEXT), sent.body).toBe(false);
      }
    }
  });
});

it('[AC-B2-02u#4] 只读：两种权限读余额卡与流水（含筛选与翻页）前后，凭证、分录、账户、余额缓存、冻结记录、提现单与审计行都不变，也不写审计', async () => {
  const f = fixture(s);
  const { a } = await seeded(f);
  const before = await books(f);
  await withLedgerAdmin(f, async (h) => {
    for (const who of [await h.caller([VIEW]), await h.caller([LOOKUP])]) {
      expect(await ok(await h.summary(a.userId, who))).toMatchObject({ user_id: a.userId });
      for (const query of [
        { user_id: a.userId },
        { user_id: a.userId, ledger_type: 'WITHDRAW_FREEZE', page: '1', page_size: '1' },
        { user_id: a.userId, accounting_date_from: '2026-10-28', accounting_date_to: '2026-10-29' },
      ]) {
        expect(await ok(await h.ledger(query, who))).toMatchObject({ page: 1 });
      }
    }
  });
  expect(await audits(f)).toEqual([]);
  expect(await books(f)).toEqual(before);
});
