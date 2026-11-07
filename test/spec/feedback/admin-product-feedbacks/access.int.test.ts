// B1-28s access rule tests (claude-independent, SPEC_REF 18f0015e): adminListProductFeedbacks
// (GET /admin/v1/product-feedbacks, CT-26x, 编排 D10-757) is guarded by the permission point
// feedback.view alone (a super admin holds every point): without it 10403 with
// data.reason=admin_permission_denied, without a token 10001; it is read only and needs no step-up,
// so X-Step-Up-Token (valid, of another tier, or garbage) changes nothing and grants nothing; a list
// writes no audit record and changes no feedback row of any app. Requests go through the real admin
// entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  VIEW,
  ago,
  allFeedbackRows,
  answer,
  auditCount,
  denied,
  fixture,
  invalid,
  newestFirst,
  normalize,
  page,
  seedFeedbacks,
  suite,
  view,
  withFeedbackAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B1-28s#2] 权限：持 feedback.view（只此一点、或另有别的点）与超管 200 且结果相同；没有任何点、只有 fund.view / fund.recon 等别的点 → 10403 data.reason=admin_permission_denied；不带令牌 → 10001；不需要 step-up：带有效的 totp / sms step-up 令牌或乱写的令牌结果与不带完全一样，同一令牌可反复带；无权限的账号带上 step-up 令牌仍是 10403', async () => {
  const f = fixture(s);
  const rows = await seedFeedbacks(f, [
    { createdAt: ago(f, 30), reason: 'rebate', platform: 'taobao', productKey: 'tb:6543210' },
    { createdAt: ago(f, 20), userId: randomUUID(), note: '价格和页面上写的不一样' },
  ]);
  const expected = newestFirst(rows).map(view);
  await withFeedbackAdmin(f, async (h) => {
    const plain = await page(await h.list());
    expect({ page: plain.page, page_size: plain.page_size, total: plain.total }).toEqual({
      page: 1,
      page_size: 20,
      total: 2,
    });
    expect(plain.items.map(normalize)).toEqual(expected);

    for (const who of [
      await h.caller([VIEW, 'fund.view', 'fund.recon']),
      await h.caller([], { superAdmin: true }),
    ]) {
      expect(await page(await h.list({}, who))).toEqual(plain);
    }

    const totp = await h.stepUp(h.viewer, 'totp');
    const sms = await h.stepUp(h.viewer, 'sms');
    for (const token of [totp, sms, totp, 'not-a-step-up-token']) {
      expect(await page(await h.list({}, h.viewer, { 'x-step-up-token': token }))).toEqual(plain);
    }
    // Still plain without the header after the tokens were sent.
    expect(await page(await h.list())).toEqual(plain);

    const nobody = await h.caller([]);
    const others = await h.caller(['fund.view', 'fund.recon', 'fund.adjust']);
    for (const who of [nobody, others]) {
      await denied(await h.list({}, who));
      await denied(await h.list({ reason: 'price' }, who));
      const token = await h.stepUp(who, 'totp');
      await denied(await h.list({}, who, { 'x-step-up-token': token }));
    }
    await answer(await h.list({}, null), 10001);
    await answer(await h.list({}, null, { 'x-step-up-token': totp }), 10001);
  });
});

it('[AC-B1-28s#3] 只读、不审计：成功的列表（默认、带全部筛选、翻页、超管、带 step-up 头）与参数被拒的列表前后 audit_logs 行数不变；任何 app 的 app.product_feedbacks 行不增不减不改', async () => {
  const f = fixture(s);
  const other = fixture(s);
  await seedFeedbacks(f, [
    { createdAt: ago(f, 50), platform: 'jd', reason: 'price' },
    { createdAt: ago(f, 40), platform: 'pdd', reason: 'info', userId: randomUUID() },
    { createdAt: ago(f, 30), platform: 'jd', reason: 'other', note: '说明' },
  ]);
  await seedFeedbacks(other, [{ createdAt: ago(other, 45), platform: 'jd', reason: 'price' }]);
  const tableBefore = await allFeedbackRows(f.db);
  const auditsBefore = await auditCount(f.db);
  await withFeedbackAdmin(f, async (h) => {
    expect((await page(await h.list())).total).toBe(3);
    const filtered = await page(
      await h.list({
        platform: 'jd',
        reason: 'price',
        from: '2026-11-07T08:00:00+08:00',
        to: '2026-11-07T10:00:00+08:00',
        page: '1',
        page_size: '200',
      }),
    );
    expect(filtered.total).toBe(1);
    expect((await page(await h.list({ page: '2', page_size: '2' }))).items).toHaveLength(1);
    const root = await h.caller([], { superAdmin: true });
    expect((await page(await h.list({}, root))).total).toBe(3);
    const token = await h.stepUp(h.viewer, 'totp');
    expect((await page(await h.list({}, h.viewer, { 'x-step-up-token': token }))).total).toBe(3);
    await invalid(
      await h.list({ from: '2026-11-07T09:00:00+08:00', to: '2026-11-07T09:00:00+08:00' }),
      ['from', 'to'],
    );
    expect(await auditCount(f.db)).toBe(auditsBefore);
  });
  expect(await auditCount(f.db)).toBe(auditsBefore);
  expect(await allFeedbackRows(f.db)).toEqual(tableBefore);
});
