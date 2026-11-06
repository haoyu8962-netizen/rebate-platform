// B2-12d approval access (claude-independent): adminApproveAdjustment's order of checks —
// fund.adjust (10403 data.reason=admin_permission_denied) → step-up sms tier (10003 data.tier=sms;
// a totp-tier token is not enough; data.reason=verify_phone_missing without a verify phone) → body
// (20001) → adjust_id; super admins pass the permission point but still need the sms tier
// (BR-ID-34). Idempotency-Key: same key → the first result (even though the form is APPROVED by
// then), and a replay after a 10003 keeps its key (the step-up token is not part of the body hash).
// Amounts by hand: prefilled at 2000; every refusal leaves 2000; the approval leaves 0.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ADJUST,
  APPROVE_ACTION,
  TIMEOUT,
  adjustVouchers,
  audits,
  conflict,
  denied,
  expectApproved,
  fixture,
  member,
  moneyOf,
  newIdemKey,
  refusedField,
  seedPrefill,
  seedRequest,
  stepUpRequired,
  suite,
  trace,
  withClosingAdmin,
  type AdjustFixture,
} from './kit.ts';

const s = suite();

async function inDeletion(f: AdjustFixture, available: bigint) {
  const userId = await member(f, { available, status: 'deleting' });
  const request = await seedRequest(f, userId);
  const form = await seedPrefill(f, userId, {
    refs: [{ ref_type: 'account_deletion', ref_id: request.id }],
  });
  return { userId, form };
}

it(
  '[AC-B2-12d#11] 批准的检查顺序：只有 fund.view 或无权限点（带不带短信档令牌）→ 10403；有权限不带令牌、带动态码档令牌、对不存在的单不带令牌 → 10003 tier=sms；没登记验证手机号 → verify_phone_missing；带短信档令牌但请求体多出 amount_fen → 20001；全程什么都不写；超管（无权限点）带短信档令牌批准成功',
  async () => {
    const f = fixture(s);
    await withClosingAdmin(f, async (h) => {
      const { userId, form } = await inDeletion(f, 2000n);
      const nobody = await h.caller([]);
      const noPhone = await h.caller([ADJUST], { phone: false });
      const boss = await h.caller([], { superAdmin: true });
      const before = await trace(f);

      await denied(await h.approve(form.adjust_id, { caller: h.viewer }));
      await denied(await h.approve(form.adjust_id, { caller: h.viewer, stepUp: null }));
      await denied(await h.approve(form.adjust_id, { caller: nobody }));

      await stepUpRequired(await h.approve(form.adjust_id, { stepUp: null }));
      await stepUpRequired(
        await h.approve(form.adjust_id, { stepUp: await h.stepUp(h.maker, 'totp') }),
      );
      await stepUpRequired(await h.approve(randomUUID(), { stepUp: null }));
      await stepUpRequired(
        await h.approve(form.adjust_id, { caller: noPhone, stepUp: null }),
        true,
      );
      await stepUpRequired(
        await h.approve(form.adjust_id, { caller: noPhone, stepUp: await h.stepUp(noPhone) }),
        true,
      );
      await refusedField(
        await h.approve(form.adjust_id, { body: { amount_fen: 2000 } }),
        'amount_fen',
      );

      expect(await trace(f)).toEqual(before);
      expect(await moneyOf(f, userId)).toEqual({ available: 2000n, frozen: 0n });
      expect(await audits(f, APPROVE_ACTION)).toEqual([]);

      await expectApproved(f, await h.approve(form.adjust_id, { caller: boss }), {
        caller: boss,
        form,
        amount: 2000n,
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#12] 批准的幂等：同一 Idempotency-Key 先因不带令牌得 10003，再带短信档令牌 → 批准；同键重放 → 原样返回第一次的结果（不回 20902、不再记账、不再写审计）；换新键 → 20902',
  async () => {
    const f = fixture(s);
    await withClosingAdmin(f, async (h) => {
      const { form } = await inDeletion(f, 2000n);
      const key = newIdemKey();
      await stepUpRequired(await h.approve(form.adjust_id, { key, stepUp: null }));
      const first = await h.approve(form.adjust_id, { key });
      await expectApproved(f, first, { caller: h.maker, form, amount: 2000n });
      const after = await trace(f);

      const replay = await h.approve(form.adjust_id, { key });
      expect(replay.statusCode, replay.body).toBe(first.statusCode);
      expect(replay.body).toBe(first.body);
      expect(await trace(f)).toEqual(after);
      expect((await adjustVouchers(f)).map((v) => v.uniq_key)).toEqual([`ADJ:${form.adjust_id}`]);
      expect(await audits(f, APPROVE_ACTION)).toHaveLength(1);

      await conflict(await h.approve(form.adjust_id, { key: newIdemKey() }));
      expect(await trace(f)).toEqual(after);
    });
  },
  TIMEOUT,
);
