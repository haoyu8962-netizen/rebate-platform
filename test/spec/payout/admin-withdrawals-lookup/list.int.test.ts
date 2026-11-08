// B2-09zg list rule tests (claude-independent, SPEC_REF 39756e36): contracts/openapi.yaml
// listAdminWithdrawals, CT-24zzb (04 §11.1; D10-1042; FU-WITHDRAWALS-USER-LOOKUP). An account holding
// user.lookup but neither withdraw.review nor fund.view reads the list only with `user_id` (without
// it 10403 data.reason=admin_permission_denied, the same as an account holding none of the three
// points), sees every row with reject_note = null, auto_decision = null and risk_flags = [] and may
// not filter by risk_flag. withdraw.review, fund.view and a super admin are not affected. Requests
// go through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
//
// Red on the code before this task: the account only holding user.lookup gets 10403 on everything,
// so every case asserts the 200 of that account (the refusals and the unaffected accounts alone
// would already be green).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  LIST_KEYS,
  REVIEW,
  VIEW,
  allAudits,
  answer,
  expectNoSecrets,
  fixture,
  footprint,
  ids,
  listView,
  normalize,
  page,
  seedMember,
  seedWithdrawal,
  suite,
} from '../admin-withdrawals/kit.ts';
import {
  DENIED,
  FLAG_CODE,
  LOOKUP,
  NOTE_MARK,
  blankedRow,
  refusal,
  richSeed,
  withLookupAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-09zg#1] 提现单列表（只持 user.lookup，含另持 fund.recon 这类别的点）带 user_id → 200，只有该用户的单，按申请时间倒序、total 为该用户的条数；每行 reject_note、auto_decision 为 null，risk_flags 为 []（库里都有真实值，持 withdraw.review 的账号读到真实值），金额、status、reject_reason_code 等其余字段照常、行的形状不变；可与别的筛选组合；未知用户、别的应用的用户、不是 UUID 的 user_id 是空页；读取不写审计、不改任何行', async () => {
  const f = fixture(s);
  const other = fixture(s);
  await withLookupAdmin(f, async (h) => {
    const a = await seedMember(f, h);
    const b = await seedMember(f, h);
    const rejected = await seedWithdrawal(f, h, a, richSeed(f, 60));
    const pending = await seedWithdrawal(
      f,
      h,
      a,
      richSeed(f, 30, { status: 'PENDING_REVIEW', reject_reason_code: null, reject_note: null }),
    );
    await seedWithdrawal(f, h, b, richSeed(f, 20));
    const stranger = await seedMember(other, h);
    await seedWithdrawal(other, h, stranger, richSeed(other, 10));
    const real = [pending, rejected].map((row) => listView(row, a));
    const before = await footprint(f);

    for (const who of [h.lookup, await h.caller([LOOKUP, 'fund.recon'])]) {
      const sent = await h.list({ user_id: a.userId }, who);
      const data = await page(sent);
      expect({ page: data.page, page_size: data.page_size, total: data.total }).toEqual({
        page: 1,
        page_size: 20,
        total: 2,
      });
      for (const item of data.items) expect(Object.keys(item).sort()).toEqual([...LIST_KEYS]);
      expect(data.items.map(normalize)).toEqual(real.map(blankedRow));
      expectNoSecrets(sent.body, [NOTE_MARK, FLAG_CODE]);
      expect(await ids(await h.list({ user_id: a.userId, status: 'REJECTED' }, who))).toEqual([
        rejected.id,
      ]);
      for (const missing of [randomUUID(), stranger.userId, 'not-a-uuid']) {
        expect(await page(await h.list({ user_id: missing }, who))).toEqual({
          items: [],
          page: 1,
          page_size: 20,
          total: 0,
        });
      }
    }
    const reviewed = await page(await h.list({ user_id: a.userId }, h.reviewer));
    expect(reviewed.items.map(normalize)).toEqual(real);
    expect(await footprint(f)).toEqual(before);
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-09zg#2] 提现单列表（只持 user.lookup）：带 user_id 能读（且确实查了库）；不带 user_id、或带合法枚举值的 risk_flag（带不带 user_id 都一样）→ 10403 admin_permission_denied，应答与三个权限点都没有的账号完全相同，且不读提现相关表；没有任何点或只持 fund.recon 的账号带 user_id、持 user.lookup + fund.recon 不带 user_id 也是同样的 10403、不读提现相关表；risk_flag 不在枚举 → 20001 [risk_flag]（路由 schema 先于权限检查）', async () => {
  const f = fixture(s);
  await withLookupAdmin(f, async (h) => {
    const m = await seedMember(f, h);
    const row = await seedWithdrawal(f, h, m, richSeed(f, 30));
    // The observation is live: the allowed read of the same account does reach the tables.
    const allowed = await h.observed(() => h.list({ user_id: m.userId }, h.lookup));
    expect(await ids(allowed.sent)).toEqual([row.id]);
    expect(allowed.reads).not.toEqual([]);

    const denied = await answer(await h.list({}, h.none), 10403, DENIED);
    for (const query of [
      {},
      { status: 'REJECTED' },
      { risk_flag: FLAG_CODE },
      { risk_flag: FLAG_CODE, user_id: m.userId },
      { risk_flag: 'recon_diff', user_id: m.userId },
    ]) {
      const refused = await h.observed(() => h.list(query, h.lookup));
      const body = await answer(refused.sent, 10403, DENIED);
      expect(refusal(body), JSON.stringify(query)).toEqual(refusal(denied));
      expect(refused.reads, JSON.stringify(query)).toEqual([]);
    }
    // user_id opens nothing without user.lookup, and another point does not stand in for user_id.
    const recon = await h.caller(['fund.recon']);
    const lookupRecon = await h.caller([LOOKUP, 'fund.recon']);
    for (const [label, request] of [
      ['no point, user_id', () => h.list({ user_id: m.userId }, h.none)],
      ['fund.recon, user_id', () => h.list({ user_id: m.userId }, recon)],
      ['user.lookup + fund.recon, no user_id', () => h.list({}, lookupRecon)],
    ] as const) {
      const refused = await h.observed(request);
      const body = await answer(refused.sent, 10403, DENIED);
      expect(refusal(body), label).toEqual(refusal(denied));
      expect(refused.reads, label).toEqual([]);
    }
    await answer(await h.list({ risk_flag: 'blacklist' }, h.lookup), 20001, {
      fields: ['risk_flag'],
    });
    await answer(await h.list({ risk_flag: 'blacklist', user_id: m.userId }, h.lookup), 20001, {
      fields: ['risk_flag'],
    });
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-09zg#3] 提现单列表：只持 user.lookup 的账号读到置空，而持 withdraw.review 或 fund.view（含同时持 user.lookup）的账号与超管不受影响——不带 user_id 照旧 200，reject_note、auto_decision、risk_flags 都是真实值，risk_flag 筛选照旧可用', async () => {
  const f = fixture(s);
  await withLookupAdmin(f, async (h) => {
    const a = await seedMember(f, h);
    const b = await seedMember(f, h);
    const first = await seedWithdrawal(f, h, a, richSeed(f, 60));
    const second = await seedWithdrawal(
      f,
      h,
      b,
      richSeed(f, 30, {
        risk_flags: [{ code: 'recon_diff', value: true, threshold: null }],
      }),
    );
    const lookedUp = await page(await h.list({ user_id: a.userId }, h.lookup));
    expect(lookedUp.items.map(normalize)).toEqual([blankedRow(listView(first, a))]);

    const root = await h.caller([], { superAdmin: true });
    const holders = [
      h.reviewer,
      h.viewer,
      await h.caller([REVIEW, LOOKUP]),
      await h.caller([VIEW, LOOKUP]),
      root,
    ];
    for (const who of holders) {
      const all = await page(await h.list({}, who));
      expect(all.items.map(normalize)).toEqual([listView(second, b), listView(first, a)]);
      const only = await page(await h.list({ user_id: a.userId }, who));
      expect(only.items.map(normalize)).toEqual([listView(first, a)]);
      expect(await ids(await h.list({ risk_flag: FLAG_CODE }, who))).toEqual([first.id]);
      expect(await ids(await h.list({ risk_flag: 'recon_diff' }, who))).toEqual([second.id]);
      expect(await ids(await h.list({ risk_flag: 'recon_diff', user_id: a.userId }, who))).toEqual(
        [],
      );
    }
  });
});
