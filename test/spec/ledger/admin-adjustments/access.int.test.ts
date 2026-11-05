// B2-12c access (claude-independent): adminCreateAdjustment — permission point fund.adjust (10403
// data.reason=admin_permission_denied; the refusal writes an audit record, action
// adjustment_denied, BR-FUND-24 例（无权限）) → step-up sms tier (10003 data.tier=sms; an account
// without a verify phone also data.reason=verify_phone_missing; super admins too, BR-ID-34) → body.
// D10-590 ⑥: the route schema runs first — a malformed body is 20001 with or without fund.adjust and
// writes no audit record. The no-permission cases use a valid body.
import { expect, it } from 'vitest';
import {
  ADJUST,
  DENIED_ACTION,
  audits,
  denied,
  expectAdjusted,
  fixture,
  member,
  newForm,
  schemaRefused,
  seedReconDiff,
  stepUpRequired,
  suite,
  trace,
  withAdjustAdmin,
  type Ref,
} from './kit.ts';

const s = suite();

it('[AC-B2-12c#19] 没有 fund.adjust 的账号（只有 fund.view、没有任何权限点）用合法请求体提交（带或不带短信档令牌）→ 10403 admin_permission_denied，每次一条 adjustment_denied 审计（admin_id 为该账号），不写单、凭证、余额、事件与站内信', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };
    const body = newForm({
      userId,
      direction: 'decrease',
      amount: 500n,
      reason: 'RECON_FIX',
      refs: [diff],
      note: '无权限的调减',
      contra: 'COMMISSION_REVENUE',
    });
    const nobody = await h.caller([]);
    const before = await trace(f);

    await denied(await h.create(body, { caller: h.viewer }));
    await denied(await h.create(body, { caller: h.viewer, stepUp: null }));
    await denied(await h.create(body, { caller: nobody }));

    expect(await trace(f)).toEqual(before);
    const recorded = await audits(f);
    expect(recorded.map((row) => [row.action, row.admin_id])).toEqual([
      [DENIED_ACTION, h.viewer.id],
      [DENIED_ACTION, h.viewer.id],
      [DENIED_ACTION, nobody.id],
    ]);
  });
});

it('[AC-B2-12c#20] schema 先于守卫（D10-590 ⑥）：不合 schema 的请求体（原因码 RESTORE）对无权限账号、对有权限但不带令牌的账号都回 20001（fields 含 body），不写审计', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };
    const body = newForm({
      userId,
      direction: 'increase',
      amount: 500n,
      reason: 'RESTORE',
      refs: [diff],
      note: '手工选恢复',
      contra: 'COMMISSION_REVENUE',
    });
    const before = await trace(f);
    await schemaRefused(await h.create(body, { caller: h.viewer }));
    await schemaRefused(await h.create(body, { stepUp: null }));
    expect(await trace(f)).toEqual(before);
    expect(await audits(f)).toEqual([]);
  });
});

it('[AC-B2-12c#21] 短信档 step-up：有 fund.adjust 的账号与超管，不带令牌、带动态码档令牌 → 10003 tier=sms；没登记验证手机号的（超管也一样）→ 10003 verify_phone_missing；都不留痕、不写 adjustment_denied；之后带短信档令牌一次生效', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };
    const body = newForm({
      userId,
      direction: 'increase',
      amount: 500n,
      reason: 'RECON_FIX',
      refs: [diff],
      note: '漏记的结算补回',
      contra: 'BAD_DEBT',
    });
    const boss = await h.caller([], { superAdmin: true });
    const noPhone = await h.caller([ADJUST], { phone: false });
    const bossNoPhone = await h.caller([], { superAdmin: true, phone: false });
    const before = await trace(f);

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
    expect(await audits(f, DENIED_ACTION)).toEqual([]);

    for (const [who, start] of [
      [h.maker, 3000n],
      [boss, 3500n],
    ] as const) {
      await expectAdjusted(f, await h.create(body, { caller: who }), {
        caller: who,
        userId,
        direction: 'increase',
        amount: 500n,
        reason: 'RECON_FIX',
        contra: 'BAD_DEBT',
        refs: [diff],
        note: '漏记的结算补回',
        before: { available: start, frozen: 0n },
      });
    }
  });
});

it('[AC-B2-12c#22] 读不要 step-up：fund.view、fund.adjust 都能读列表与详情；两者都没有 → 10403，不写审计', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const nobody = await h.caller(['fund.recon']);
    for (const who of [h.viewer, h.maker]) {
      const list = await h.list({}, who);
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().code).toBe(0);
    }
    await denied(await h.list({}, nobody));
    expect(await audits(f)).toEqual([]);
  });
});
