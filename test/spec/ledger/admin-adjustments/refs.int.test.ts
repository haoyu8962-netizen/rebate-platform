// B2-12c linked documents, subjects and body checks (claude-independent): BR-FUND-24 ②③⑥ and
// adminCreateAdjustment: RECON_FIX needs a recon_diff; PAYOUT_RECOVERY a recon_diff and exactly one
// withdrawal, its cash subject from the withdrawal's channel; OTHER any document or none with the
// 客服处理说明 in note; duplicates refused; a ref naming nothing of the app, an R4 difference, or a
// withdrawal / deletion of another member → adjust_ref_invalid; contra subjects of specs/ledger-rules.md
// §6 方案 A; RESTORE / ACCOUNT_CLOSED never chosen; the order body → user → refs.
// D10-590 ⑧ (流水先不跳转): the voucher carries no order_key, role or withdrawal business, so the
// member's balance line links nowhere (wallet-ledger linkOf).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { linkOf } from '../../../../apps/api/src/modules/ledger/application/wallet-ledger.ts';
import {
  audits,
  expectAdjusted,
  fixture,
  invalid,
  member,
  newAppId,
  newForm,
  schemaRefused,
  seedDeletion,
  seedOrder,
  seedR4Diff,
  seedReconDiff,
  seedWithdrawal,
  suite,
  trace,
  withAdjustAdmin,
  type Ref,
} from './kit.ts';

const s = suite();

it('[AC-B2-12c#14] 按原因码要的单据（不对 → 20001 fields=[refs]）：RECON_FIX 没有差错单；PAYOUT_RECOVERY 没有差错单、没有或有两张提现单；任一单据重复；都不留痕。OTHER 只写客服处理说明、不带单据 → 生效，refs 为空', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };
    const w1: Ref = { ref_type: 'withdrawal', ref_id: await seedWithdrawal(f, userId) };
    const w2: Ref = { ref_type: 'withdrawal', ref_id: await seedWithdrawal(f, userId) };
    const before = await trace(f);
    const recon = (refs: readonly Ref[]) =>
      newForm({
        userId,
        direction: 'decrease',
        amount: 100n,
        reason: 'RECON_FIX',
        refs,
        note: '更正',
        contra: 'COMMISSION_REVENUE',
      });
    const recovery = (refs: readonly Ref[]) =>
      newForm({
        userId,
        direction: 'decrease',
        amount: 100n,
        reason: 'PAYOUT_RECOVERY',
        refs,
        note: '追回',
      });

    for (const body of [
      recon([]),
      recon([w1]),
      recon([diff, diff]),
      recovery([w1]),
      recovery([diff]),
      recovery([diff, w1, w2]),
      recovery([w1, diff, w1]),
    ]) {
      await invalid(await h.create(body), ['refs']);
    }
    {
      const sent = await h.create({ ...recon([]), refs: undefined });
      await invalid(sent, ['refs']);
    }
    expect(await trace(f)).toEqual(before);
    expect(await audits(f)).toEqual([]);

    const note = '客服处理说明：企业微信沟通确认重复领取活动奖励，核实后调减';
    const sent = await h.create(
      newForm({
        userId,
        direction: 'decrease',
        amount: 200n,
        reason: 'OTHER',
        note,
        contra: 'MKT_EXPENSE',
      }),
    );
    await expectAdjusted(f, sent, {
      caller: h.maker,
      userId,
      direction: 'decrease',
      amount: 200n,
      reason: 'OTHER',
      contra: 'MKT_EXPENSE',
      refs: [],
      note,
      before: { available: 3000n, frozen: 0n },
    });
  });
});

it('[AC-B2-12c#15] 单据须是本 app 的、属这位会员的：不存在的差错单 / 提现单 / 注销单 / 子订单号、收款对账 R4 差错单、别的 app 的差错单、别的会员的提现单或注销单 → 20001 adjust_ref_invalid（fields=[refs]），都不留痕', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const other = await member(f, { available: 3000n });
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };
    const mine: Ref = { ref_type: 'withdrawal', ref_id: await seedWithdrawal(f, userId) };
    const otherApp = newAppId();
    const r4: Ref = { ref_type: 'recon_diff', ref_id: (await seedR4Diff(f)).id };
    const foreignDiff: Ref = {
      ref_type: 'recon_diff',
      ref_id: (await seedReconDiff(f, { app_id: otherApp })).id,
    };
    const othersWithdrawal: Ref = {
      ref_type: 'withdrawal',
      ref_id: await seedWithdrawal(f, other),
    };
    const othersDeletion: Ref = {
      ref_type: 'account_deletion',
      ref_id: await seedDeletion(f, other),
    };
    const before = await trace(f);
    const recon = (refs: readonly Ref[]) =>
      newForm({
        userId,
        direction: 'increase',
        amount: 100n,
        reason: 'RECON_FIX',
        refs,
        note: '更正',
        contra: 'COMMISSION_REVENUE',
      });
    const recovery = (refs: readonly Ref[]) =>
      newForm({
        userId,
        direction: 'decrease',
        amount: 100n,
        reason: 'PAYOUT_RECOVERY',
        refs,
        note: '追回',
      });
    const misc = (refs: readonly Ref[]) =>
      newForm({
        userId,
        direction: 'increase',
        amount: 100n,
        reason: 'OTHER',
        refs,
        note: '其他调整',
        contra: 'MKT_EXPENSE',
      });

    for (const body of [
      recon([{ ref_type: 'recon_diff', ref_id: randomUUID() }]),
      recon([r4]),
      recon([foreignDiff]),
      recovery([{ ref_type: 'withdrawal', ref_id: randomUUID() }, diff]),
      recovery([othersWithdrawal, diff]),
      recovery([mine, r4]),
      misc([othersDeletion]),
      misc([{ ref_type: 'account_deletion', ref_id: randomUUID() }]),
      misc([{ ref_type: 'order', ref_id: `taobao:adj-missing-${randomUUID()}` }]),
      recon([diff, { ref_type: 'withdrawal', ref_id: randomUUID() }]),
    ]) {
      await invalid(await h.create(body), ['refs'], 'adjust_ref_invalid');
    }
    expect(await trace(f)).toEqual(before);
    expect(await audits(f)).toEqual([]);
  });
});

it('[AC-B2-12c#16] 对方科目（specs/ledger-rules.md §6 方案 A）：RECON_FIX / OTHER 缺 contra_subject → fields=[contra_subject]；UNION_RECEIVABLE 缺平台、别的科目带平台 → fields=[contra_platform]；PAYOUT_RECOVERY 带科目或平台 → 对应字段；白名单外的科目（现金科目、USER_BALANCE）→ schema 20001；都不留痕', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };
    const withdrawal: Ref = { ref_type: 'withdrawal', ref_id: await seedWithdrawal(f, userId) };
    const before = await trace(f);
    const form = (reason: string, patch: { contra?: string; platform?: string }) =>
      newForm({
        userId,
        direction: 'increase',
        amount: 100n,
        reason,
        refs: reason === 'PAYOUT_RECOVERY' ? [withdrawal, diff] : [diff],
        note: '科目校验',
        ...patch,
      });

    for (const reason of ['RECON_FIX', 'OTHER']) {
      await invalid(await h.create(form(reason, {})), ['contra_subject']);
      await invalid(await h.create(form(reason, { contra: 'UNION_RECEIVABLE' })), [
        'contra_platform',
      ]);
      await invalid(
        await h.create(form(reason, { contra: 'COMMISSION_REVENUE', platform: 'jd' })),
        ['contra_platform'],
      );
      for (const contra of ['CASH_ALIPAY', 'CASH_WECHAT', 'CASH_BANK', 'USER_BALANCE']) {
        await schemaRefused(await h.create(form(reason, { contra })));
      }
    }
    await invalid(await h.create(form('PAYOUT_RECOVERY', { contra: 'COMMISSION_REVENUE' })), [
      'contra_subject',
    ]);
    await invalid(await h.create(form('PAYOUT_RECOVERY', { platform: 'jd' })), ['contra_platform']);
    expect(await trace(f)).toEqual(before);
    expect(await audits(f)).toEqual([]);
  });
});

it('[AC-B2-12c#17] 请求体：原因码 RESTORE / ACCOUNT_CLOSED、金额 0 或负数或小数、说明超 500 字、单据超 10 张、未知字段、缺必填 → 20001（schema，fields 含 body）；OTHER 不写说明、说明只有空白 → fields=[note]；会员不存在或属别的 app → fields=[user_id]；先查请求体再查会员、再查单据', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const otherApp = newAppId();
    const stranger = await member(f, { appId: otherApp });
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };
    const before = await trace(f);
    const good = newForm({
      userId,
      direction: 'increase',
      amount: 100n,
      reason: 'RECON_FIX',
      refs: [diff],
      note: '更正',
      contra: 'COMMISSION_REVENUE',
    });
    const eleven: Ref[] = Array.from({ length: 11 }, (): Ref => ({
      ref_type: 'recon_diff',
      ref_id: randomUUID(),
    }));

    for (const body of [
      { ...good, reason_code: 'RESTORE' },
      { ...good, reason_code: 'ACCOUNT_CLOSED' },
      { ...good, amount_fen: 0 },
      { ...good, amount_fen: -100 },
      { ...good, amount_fen: 1.5 },
      { ...good, direction: 'up' },
      { ...good, note: '说'.repeat(501) },
      { ...good, refs: eleven },
      { ...good, refs: [{ ref_type: 'ticket', ref_id: randomUUID() }] },
      { ...good, operator: 'admin' },
      { ...good, user_id: undefined },
      { ...good, amount_fen: undefined },
      {},
    ]) {
      await schemaRefused(await h.create(body));
    }
    const other = newForm({
      userId,
      direction: 'increase',
      amount: 100n,
      reason: 'OTHER',
      refs: [diff],
      contra: 'MKT_EXPENSE',
    });
    await invalid(await h.create(other), ['note']);
    await invalid(await h.create({ ...other, note: ' \t ' }), ['note']);
    await invalid(await h.create({ ...good, note: '  ' }), ['note']);
    await invalid(await h.create({ ...good, user_id: randomUUID() }), ['user_id']);
    await invalid(await h.create({ ...good, user_id: stranger }), ['user_id']);
    // the shared Id schema is a string of 1–64 characters, not a UUID: a malformed user_id fits
    // the shape and is named by the service as an unknown member
    await invalid(await h.create({ ...good, user_id: 'not-a-uuid' }), ['user_id']);
    // body before member: a missing subject is reported before an unknown member
    await invalid(await h.create({ ...good, user_id: randomUUID(), contra_subject: undefined }), [
      'contra_subject',
    ]);
    // member before documents
    await invalid(
      await h.create({
        ...good,
        user_id: randomUUID(),
        refs: [{ ref_type: 'recon_diff', ref_id: randomUUID() }],
      }),
      ['user_id'],
    );
    expect(await trace(f)).toEqual(before);
    expect(await audits(f)).toEqual([]);
  });
});

it('[AC-B2-12c#18] D10-590 ⑧ 流水先不跳转：带子订单号的 OTHER 单与带提现单的 PAYOUT_RECOVERY 单生效后，凭证不带 order_key、受益角色，也不是提现业务，余额流水 linkOf 为不跳转、不打码', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const order: Ref = { ref_type: 'order', ref_id: await seedOrder(f, userId) };
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };
    const withdrawal: Ref = {
      ref_type: 'withdrawal',
      ref_id: await seedWithdrawal(f, userId, { channel: 'wechat' }),
    };

    const byOrder = await expectAdjusted(
      f,
      await h.create(
        newForm({
          userId,
          direction: 'increase',
          amount: 120n,
          reason: 'OTHER',
          refs: [order],
          note: '订单补发差额',
          contra: 'UNION_RECEIVABLE',
          platform: 'taobao',
        }),
      ),
      {
        caller: h.maker,
        userId,
        direction: 'increase',
        amount: 120n,
        reason: 'OTHER',
        contra: 'UNION_RECEIVABLE',
        platform: 'taobao',
        refs: [order],
        note: '订单补发差额',
        before: { available: 3000n, frozen: 0n },
      },
    );
    const byWithdrawal = await expectAdjusted(
      f,
      await h.create(
        newForm({
          userId,
          direction: 'decrease',
          amount: 10_000n,
          reason: 'PAYOUT_RECOVERY',
          refs: [withdrawal, diff],
          note: '微信零钱重复到账',
        }),
      ),
      {
        caller: h.maker,
        userId,
        direction: 'decrease',
        amount: 10_000n,
        reason: 'PAYOUT_RECOVERY',
        contra: 'CASH_WECHAT',
        refs: [withdrawal, diff],
        note: '微信零钱重复到账',
        before: { available: 3120n, frozen: 0n },
      },
    );
    for (const { voucher } of [byOrder, byWithdrawal]) {
      expect(voucher.order_key).toBeNull();
      expect(voucher.role).toBeNull();
      expect(voucher.biz_type).not.toBe('withdrawal');
      expect(
        linkOf({
          ledgerType: 'ADMIN_ADJUST',
          bizType: voucher.biz_type,
          bizId: voucher.biz_id,
          orderKey: voucher.order_key,
          role: voucher.role,
        }),
      ).toEqual({ masked: false, kind: 'none' });
    }
  });
});
