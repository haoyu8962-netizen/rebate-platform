// B2-12c access of a reversal (claude-independent; spec-test r1 S1 on access.int.test.ts #21):
// BR-FUND-24 细则「红冲只按原单整笔」(红冲单仍按 ① 的流程执行：权限点、短信档 step-up、审计；红冲单同样只在
// 批准执行时 step-up) and adminCreateAdjustment's order of checks — fund.adjust (10403
// data.reason=admin_permission_denied, an audit record adjustment_denied, BR-FUND-24 例（无权限）) →
// step-up sms tier (10003 data.tier=sms; data.reason=verify_phone_missing without a verify phone;
// super admins too, BR-ID-34). The original is a real APPROVED form with its voucher (kit.ts
// seedForm); every refused request has a valid reversal body (D10-590 ⑥: the schema runs first).
// Amounts by hand: 1000, the original +500 → 1500; refused reversals leave 1500; the super admin's
// reversal with an sms-tier token → 1000.
import { expect, it } from 'vitest';
import {
  ADJUST,
  DENIED_ACTION,
  REVERSE_ACTION,
  audits,
  denied,
  expectAdjusted,
  fixture,
  member,
  moneyOf,
  seedForm,
  stepUpRequired,
  suite,
  trace,
  withAdjustAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-12c#41] 红冲真实已批准的原单（+500）：无权限账号（只有 fund.view 带或不带短信档令牌、没有任何权限点）→ 10403 并各写一条 adjustment_denied；有权限账号与超管不带令牌、带动态码档令牌 → 10003 tier=sms；没登记验证手机号的（含超管）→ verify_phone_missing；余额、单、凭证、事件、站内信都不变，只有三条无权限审计；之后超管带短信档令牌一次冲回', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 1000n });
    const original = await seedForm(f, {
      userId,
      direction: 'increase',
      amount: 500n,
      reason: 'RECON_FIX',
      contra: 'COMMISSION_REVENUE',
    });
    expect(await moneyOf(f, userId)).toEqual({ available: 1500n, frozen: 0n });
    const body = { reverses_adjust_id: original.adjust_id, note: '误调，整笔冲回' };
    const nobody = await h.caller([]);
    const boss = await h.caller([], { superAdmin: true });
    const noPhone = await h.caller([ADJUST], { phone: false });
    const bossNoPhone = await h.caller([], { superAdmin: true, phone: false });
    const before = await trace(f);
    const auditsBefore = await audits(f);

    await denied(await h.create(body, { caller: h.viewer }));
    await denied(await h.create(body, { caller: h.viewer, stepUp: null }));
    await denied(await h.create(body, { caller: nobody }));

    for (const who of [h.maker, boss]) {
      await stepUpRequired(await h.create(body, { caller: who, stepUp: null }));
      await stepUpRequired(
        await h.create(body, { caller: who, stepUp: await h.stepUp(who, 'totp') }),
      );
    }
    for (const who of [noPhone, bossNoPhone]) {
      await stepUpRequired(await h.create(body, { caller: who, stepUp: null }), true);
      await stepUpRequired(
        await h.create(body, { caller: who, stepUp: await h.stepUp(who, 'sms') }),
        true,
      );
    }

    expect(await trace(f)).toEqual(before);
    expect(await moneyOf(f, userId)).toEqual({ available: 1500n, frozen: 0n });
    const known = new Set(auditsBefore.map((row) => String(row.id)));
    const added = (await audits(f)).filter((row) => !known.has(String(row.id)));
    expect(added.map((row) => [row.action, row.admin_id])).toEqual([
      [DENIED_ACTION, h.viewer.id],
      [DENIED_ACTION, h.viewer.id],
      [DENIED_ACTION, nobody.id],
    ]);

    await expectAdjusted(f, await h.create(body, { caller: boss }), {
      caller: boss,
      userId,
      direction: 'decrease',
      amount: 500n,
      reason: 'RECON_FIX',
      contra: 'COMMISSION_REVENUE',
      refs: [],
      note: body.note,
      reverses: original,
      before: { available: 1500n, frozen: 0n },
    });
    const reversed = await audits(f, REVERSE_ACTION);
    expect(reversed.map((row) => row.admin_id)).toEqual([boss.id]);
  });
});
