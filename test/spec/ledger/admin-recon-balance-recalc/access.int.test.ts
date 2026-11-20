// B2-02x access and request (claude-independent, SPEC_REF ba6655b1): recalcBalanceAdminReconDiff
// (CT-24zzn) with 08 BR-ID-34 (短信档 includes 改用户可见余额的余额缓存重算; every step-up operation
// asks again each time) — the route schema first (D10-590 ⑥, D10-1132: an amount or any other extra
// key, a missing / non-string / over-long reason → 20001 before fund.recon and step-up, with or
// without them), then fund.recon (10403 data.reason=admin_permission_denied; no token 10001), then
// the sms tier (no token, a totp-tier token, a spent token → 10003 data.tier=sms; an account
// without a verify phone also data.reason=verify_phone_missing), then the reason after trimming
// (1–200 characters, else 20001 [reason]), then the difference. Nothing is written by a refusal:
// the member's cache disagrees with the entries throughout, so a call that got through would show.
import { expect, it } from 'vitest';
import {
  RECALC_ACTION,
  VIEW,
  audits,
  balanceCache,
  cacheOf,
  chars,
  denied,
  expectRecalcAudit,
  expectRecalculated,
  fixture,
  plainMember,
  reasonInvalid,
  schemaRefused,
  seedMismatch,
  stepUpRequired,
  suite,
  tamper,
  untouched,
  withRecalcAdmin,
  answer,
} from './kit.ts';

const s = suite();

it('[AC-B2-02x#35] 控制台不送金额：带 available_fen / frozen_fen / amount_fen 或任何多余字段、缺 reason、reason 不是字符串、超过 200 字 → 路由校验 20001（data.fields 指出该字段），先于权限与二次验证（无权限、无 step-up 也一样），什么都不写', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 4900n);
    await tamper(f, m, { available: 5000n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    const cache = await balanceCache(f);
    const trace = await untouched(f);
    const bodies: readonly (readonly [unknown, string])[] = [
      [{ reason: '按分录重算', available_fen: 4900 }, 'available_fen'],
      [{ reason: '按分录重算', frozen_fen: 0 }, 'frozen_fen'],
      [{ reason: '按分录重算', amount_fen: 100 }, 'amount_fen'],
      [{ reason: '按分录重算', user_id: m.userId }, 'user_id'],
      [{}, 'reason'],
      [{ reason: 42 }, 'reason'],
      [{ reason: null }, 'reason'],
      [{ reason: chars(201) }, 'reason'],
    ];
    for (const [body, field] of bodies) {
      await schemaRefused(await h.recalc(diff.id, body), field);
      await schemaRefused(await h.recalc(diff.id, body, { stepUp: null }), field);
      await schemaRefused(await h.recalc(diff.id, body, { caller: h.viewer, stepUp: null }), field);
    }
    expect(await balanceCache(f)).toEqual(cache);
    expect(await untouched(f)).toEqual(trace);
    expect(await audits(f, RECALC_ACTION)).toEqual([]);
  });
});

it('[AC-B2-02x#36] 权限点 fund.recon：只有 fund.view、没有权限点、只有别的权限点 → 10403 data.reason=admin_permission_denied（带不带短信验证、原因全空白都先判权限）；不带令牌 → 10001；都不写', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 4900n);
    await tamper(f, m, { available: 5000n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    const cache = await balanceCache(f);
    const trace = await untouched(f);
    const nobody = await h.caller([]);
    const adjuster = await h.caller(['fund.adjust', VIEW]);
    for (const caller of [h.viewer, nobody, adjuster]) {
      await denied(await h.recalc(diff.id, { reason: '越权' }, { caller }));
      await denied(await h.recalc(diff.id, { reason: '越权' }, { caller, stepUp: null }));
      await denied(await h.recalc(diff.id, { reason: '   ' }, { caller }));
    }
    await answer(await h.recalc(diff.id, { reason: '未登录' }, { caller: null }), 10001);
    expect(await balanceCache(f)).toEqual(cache);
    expect(await untouched(f)).toEqual(trace);
    expect(await audits(f, RECALC_ACTION)).toEqual([]);
  });
});

it('[AC-B2-02x#37] 短信档 step-up（BR-ID-34）：不带令牌、带 totp 档令牌 → 10003 data.tier=sms；未登记验证手机的账号（含超管）→ 另带 data.reason=verify_phone_missing；都不改余额、不写审计', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 4900n);
    await tamper(f, m, { available: 5000n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    const boss = await h.caller([], { superAdmin: true });
    const noPhone = await h.caller(['fund.recon'], { phone: false });
    const bossNoPhone = await h.caller([], { superAdmin: true, phone: false });
    const cache = await balanceCache(f);
    const trace = await untouched(f);
    for (const who of [h.recon, boss]) {
      await stepUpRequired(
        await h.recalc(diff.id, { reason: '核对' }, { caller: who, stepUp: null }),
      );
      await stepUpRequired(
        await h.recalc(
          diff.id,
          { reason: '核对' },
          { caller: who, stepUp: await h.stepUp(who, 'totp') },
        ),
      );
    }
    for (const who of [noPhone, bossNoPhone]) {
      await stepUpRequired(
        await h.recalc(diff.id, { reason: '核对' }, { caller: who, stepUp: null }),
        true,
      );
      await stepUpRequired(
        await h.recalc(diff.id, { reason: '核对' }, { caller: who, stepUp: await h.stepUp(who) }),
        true,
      );
    }
    expect(await balanceCache(f)).toEqual(cache);
    expect(await untouched(f)).toEqual(trace);
    expect(await audits(f, RECALC_ACTION)).toEqual([]);
  });
});

it('[AC-B2-02x#38] 每次都要新的短信验证：成功用过的令牌再用 → 10003 data.tier=sms，余额不变（缓存再次被改坏也不重算）、不多写审计；换新令牌即可再算', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 4900n);
    const before = await tamper(f, m, { available: 5000n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    const token = await h.stepUp(h.recon);
    await expectRecalculated(f, await h.recalc(diff.id, { reason: '第一次' }, { stepUp: token }), {
      m,
      before: { available: 5000n, frozen: 0n },
      after: { available: 4900n, frozen: 0n },
      changed: true,
    });
    const drifted = await tamper(f, m, { available: 5000n, frozen: 0n, negativeSince: null });
    expect(drifted.version, '第一次写过 version + 1').toBe(before.version + 1n);

    await stepUpRequired(await h.recalc(diff.id, { reason: '重用令牌' }, { stepUp: token }));
    expect(await cacheOf(f, m), '重用令牌不重算').toEqual(drifted);
    expect(await audits(f, RECALC_ACTION)).toHaveLength(1);

    await expectRecalculated(f, await h.recalc(diff.id, { reason: '新令牌' }), {
      m,
      before: { available: 5000n, frozen: 0n },
      after: { available: 4900n, frozen: 0n },
      changed: true,
    });
    expect(await audits(f, RECALC_ACTION)).toHaveLength(2);
  });
});

it('[AC-B2-02x#39] 原因：去首尾空白后为空 → 20001 data.fields=[reason]（在二次验证之后、差错单之前判：无令牌先回 10003，未知差错单先回 [reason]）；恰好 200 字可以重算并原样记入审计', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 4900n);
    await tamper(f, m, { available: 5000n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    const cache = await balanceCache(f);
    for (const reason of [' ', ' \t \n ']) {
      await reasonInvalid(await h.recalc(diff.id, { reason }));
      await reasonInvalid(await h.recalc('00000000-0000-4000-8000-000000000000', { reason }));
      await stepUpRequired(await h.recalc(diff.id, { reason }, { stepUp: null }));
    }
    expect(await balanceCache(f)).toEqual(cache);
    expect(await audits(f, RECALC_ACTION)).toEqual([]);

    const reason = chars(200);
    await expectRecalculated(f, await h.recalc(diff.id, { reason }), {
      m,
      before: { available: 5000n, frozen: 0n },
      after: { available: 4900n, frozen: 0n },
      changed: true,
    });
    await expectRecalcAudit(f, {
      adminId: h.recon.id,
      diffId: diff.id,
      userId: m.userId,
      reason,
      changed: true,
      before: { available: 5000n, frozen: 0n },
      after: { available: 4900n, frozen: 0n },
    });
  });
});
