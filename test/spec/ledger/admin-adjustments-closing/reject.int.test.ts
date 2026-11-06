// B2-12d rejection (claude-independent): contracts/openapi.yaml adminRejectAdjustment with 08
// BR-FUND-24 ① (驳回须填原因) and 细则「驳回与撤回不需二次验证」(驳回不需 step-up，短信档、动态码档都不要，
// 只写 audit_logs，不写凭证), D10-590 ⑦ (the rejection runs read-only on the guard: no step-up token is
// consumed). Order of checks: fund.adjust (10403) → body: `reason` after trimming 1–200 characters
// (20001 data.fields=[reason]) → unknown adjust_id or of another app (20001 data.fields=[adjust_id])
// → no longer PENDING (20902). Effects: REJECTED, reject_note the trimmed reason, reviewer and time,
// amount_fen stays null, no voucher, no balance move; one adjustment_reject record.
// Amounts by hand: every member holds 1200, which no rejection moves; the approval with the token a
// rejection carried takes 1200.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  REJECT_ACTION,
  TIMEOUT,
  adjustVouchers,
  answer,
  audits,
  conflict,
  denied,
  expectApproved,
  expectRejected,
  fixture,
  formNow,
  invalid,
  member,
  moneyOf,
  newAppId,
  newIdemKey,
  seedForm,
  seedPrefill,
  seedRequest,
  suite,
  trace,
  withClosingAdmin,
  type AdjustFixture,
} from './kit.ts';

const s = suite();
const REASON = '预填金额与核对结果不一致，次日按系统补建的新单处理';

async function inDeletion(f: AdjustFixture, appId?: string) {
  const fx = appId === undefined ? f : { ...f, appId };
  const userId = await member(fx, { available: 1200n, status: 'deleting' });
  const request = await seedRequest(fx, userId);
  const form = await seedPrefill(fx, userId, {
    refs: [{ ref_type: 'account_deletion', ref_id: request.id }],
  });
  return { userId, request, form };
}

it(
  '[AC-B2-12d#13] 驳回不要 step-up：带一个废的 X-Step-Up-Token、不带令牌、带动态码档令牌都直接驳回；单变 REJECTED、reject_note 为去首尾空白后的原因、reviewed_by / reviewed_at 写入、amount_fen 仍空；不写凭证、不动余额、不发站内信；写一条 adjustment_reject 审计',
  async () => {
    const f = fixture(s);
    await withClosingAdmin(f, async (h) => {
      const garbage = await inDeletion(f);
      const none = await inDeletion(f);
      const totp = await inDeletion(f);
      f.clock.advanceMs(10 * 60_000);

      await expectRejected(
        f,
        await h.reject(
          garbage.form.adjust_id,
          { reason: `  ${REASON}\n` },
          {
            stepUp: 'not-a-step-up-token',
          },
        ),
        { caller: h.maker, form: garbage.form, note: REASON, available: 1200n },
      );
      await expectRejected(f, await h.reject(none.form.adjust_id, { reason: REASON }), {
        caller: h.maker,
        form: none.form,
        note: REASON,
        available: 1200n,
      });
      await expectRejected(
        f,
        await h.reject(
          totp.form.adjust_id,
          { reason: REASON },
          {
            stepUp: await h.stepUp(h.maker, 'totp'),
          },
        ),
        { caller: h.maker, form: totp.form, note: REASON, available: 1200n },
      );
      expect(await adjustVouchers(f)).toEqual([]);
      const inbox = await f.db
        .selectFrom('inbox_messages')
        .select('message_id')
        .where('app_id', '=', f.appId)
        .execute();
      expect(inbox).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#14] 驳回不消耗 step-up 令牌：带一枚有效短信档令牌驳回一张单后，同一枚令牌仍能批准另一张单',
  async () => {
    const f = fixture(s);
    await withClosingAdmin(f, async (h) => {
      const first = await inDeletion(f);
      const second = await inDeletion(f);
      const token = await h.stepUp(h.maker);
      await expectRejected(
        f,
        await h.reject(first.form.adjust_id, { reason: REASON }, { stepUp: token }),
        { caller: h.maker, form: first.form, note: REASON, available: 1200n },
      );
      await expectApproved(f, await h.approve(second.form.adjust_id, { stepUp: token }), {
        caller: h.maker,
        form: second.form,
        amount: 1200n,
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#15] reason 去首尾空白后 1–200 字：缺 reason、空串、全是空白、201 字 → 20001 fields=[reason] 且什么都不写；恰 200 字、前后各带空白共 200 字（去掉后 196）、前后带空白的「核对后不需要」都通过，按去空白后的原文存',
  async () => {
    const f = fixture(s);
    await withClosingAdmin(f, async (h) => {
      const target = await inDeletion(f);
      const before = await trace(f);
      for (const body of [{}, { reason: '' }, { reason: ' \t\n ' }, { reason: '驳'.repeat(201) }]) {
        await invalid(await h.reject(target.form.adjust_id, body), ['reason']);
      }
      expect(await trace(f)).toEqual(before);
      expect(await audits(f, REJECT_ACTION)).toEqual([]);

      const exact = '驳'.repeat(200);
      const padded = `  ${'回'.repeat(196)}  `;
      for (const [reason, note] of [
        [exact, exact],
        [padded, '回'.repeat(196)],
        ['\t核对后不需要 ', '核对后不需要'],
      ] as const) {
        const one = await inDeletion(f);
        await expectRejected(f, await h.reject(one.form.adjust_id, { reason }), {
          caller: h.maker,
          form: one.form,
          note,
          available: 1200n,
        });
      }
      expect(await formNow(f, target.form.adjust_id)).toEqual(target.form);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#16] 驳回的检查顺序：只有 fund.view 或无权限点 → 10403（请求体不合法也先回 10403）；有权限、请求体不合法且单不存在 → 先回 20001 fields=[reason]；全程什么都不写；超管（无权限点、不带令牌）可驳回',
  async () => {
    const f = fixture(s);
    await withClosingAdmin(f, async (h) => {
      const { form } = await inDeletion(f);
      const nobody = await h.caller([]);
      const boss = await h.caller([], { superAdmin: true });
      const blank = { reason: '   ' };
      const before = await trace(f);

      await denied(await h.reject(form.adjust_id, { reason: REASON }, { caller: h.viewer }));
      await denied(await h.reject(form.adjust_id, blank, { caller: h.viewer }));
      await denied(await h.reject(form.adjust_id, { reason: REASON }, { caller: nobody }));
      await invalid(await h.reject(randomUUID(), blank), ['reason']);

      expect(await trace(f)).toEqual(before);
      expect(await audits(f, REJECT_ACTION)).toEqual([]);
      await expectRejected(
        f,
        await h.reject(form.adjust_id, { reason: REASON }, { caller: boss }),
        {
          caller: boss,
          form,
          note: REASON,
          available: 1200n,
        },
      );
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#17] 不存在的、形状合法但不是 UUID 的、别的 app 的单 → 20001 fields=[adjust_id]；已驳回的预填单、已批准的 ACCOUNT_CLOSED 单、人工一步提交的单 → 20902 resource=admin_adjustment；什么都不写',
  async () => {
    const f = fixture(s);
    await withClosingAdmin(f, async (h) => {
      const otherApp = newAppId();
      const foreign = await inDeletion(f, otherApp);
      const { userId, request, form } = await inDeletion(f);
      const rejected = await seedForm(f, {
        userId,
        direction: 'decrease',
        amount: null,
        reason: 'ACCOUNT_CLOSED',
        refs: [{ ref_type: 'account_deletion', ref_id: request.id }],
        contra: 'COMMISSION_REVENUE',
        note: null,
        status: 'REJECTED',
        createdBy: null,
      });
      const approved = await seedForm(f, {
        userId,
        direction: 'decrease',
        amount: 200n,
        reason: 'ACCOUNT_CLOSED',
        refs: [{ ref_type: 'account_deletion', ref_id: request.id }],
        contra: 'COMMISSION_REVENUE',
        note: null,
        status: 'APPROVED',
      });
      const manual = await seedForm(f, { userId, direction: 'increase', amount: 300n });
      const before = await trace(f);

      for (const id of [randomUUID(), 'not-a-uuid', foreign.form.adjust_id]) {
        await invalid(await h.reject(id, { reason: REASON }), ['adjust_id']);
      }
      for (const done of [rejected, approved, manual]) {
        await conflict(await h.reject(done.adjust_id, { reason: REASON }));
      }
      expect(await trace(f)).toEqual(before);
      expect(await audits(f, REJECT_ACTION)).toEqual([]);
      expect(await formNow(f, foreign.form.adjust_id, otherApp)).toEqual(foreign.form);
      expect(await formNow(f, form.adjust_id)).toEqual(form);
      // 1200 − 200 (ACCOUNT_CLOSED already approved) + 300 (manual) = 1300.
      expect(await moneyOf(f, userId)).toEqual({ available: 1300n, frozen: 0n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#18] 驳回的幂等：同键同原因重放 → 原样返回第一次的结果（不回 20902、不再写审计）；同键换原因 → 20901；换新键 → 20902',
  async () => {
    const f = fixture(s);
    await withClosingAdmin(f, async (h) => {
      const { form } = await inDeletion(f);
      const key = newIdemKey();
      const first = await h.reject(form.adjust_id, { reason: REASON }, { key });
      await expectRejected(f, first, { caller: h.maker, form, note: REASON, available: 1200n });
      const after = await trace(f);

      const replay = await h.reject(form.adjust_id, { reason: REASON }, { key });
      expect(replay.statusCode, replay.body).toBe(first.statusCode);
      expect(replay.body).toBe(first.body);
      await answer(await h.reject(form.adjust_id, { reason: '另一个原因' }, { key }), 20901);
      await conflict(await h.reject(form.adjust_id, { reason: REASON }, { key: newIdemKey() }));
      expect(await trace(f)).toEqual(after);
      expect(await audits(f, REJECT_ACTION)).toHaveLength(1);
    });
  },
  TIMEOUT,
);
