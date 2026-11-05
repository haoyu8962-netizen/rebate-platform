// B2-12c reversal (claude-independent): BR-FUND-24 细则「红冲只按原单整笔」(关联且只关联 1 张已执行的
// 原单；方向相反、金额由原单带出、不能修改；同一原单只能红冲一次；红冲单本身不能再红冲；调减方向的红冲
// 同样允许 available < 0), ⑥ (`ADJ:{adjust_id}:REVERSE`), BR-FUND-16 (原凭证只插入不改), 细则
// 「注销调减单被驳回与注销中的调账」(D10-590 ④: deleting 会员只允许红冲 ACCOUNT_CLOSED 调减单) and the
// order of checks of adminCreateAdjustment. Originals are seeded with their real vouchers (kit.ts).
// Amounts by hand: +500 original, 300 frozen → available 200; the whole reversal −500 → −300.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  CREATE_ACTION,
  REVERSE_ACTION,
  answer,
  audits,
  conflict,
  expectAdjusted,
  expectMentions,
  fixture,
  formNow,
  formView,
  freeze,
  inboxOf,
  invalid,
  member,
  moneyOf,
  newAppId,
  newForm,
  normalizeForm,
  schemaRefused,
  seedDeletion,
  seedForm,
  seedPrefill,
  seedReconDiff,
  suite,
  trace,
  voucherByKey,
  wentNegative,
  withAdjustAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-12c#9] 红冲调增单（原单 +500，之后冻结 300，available 200）：只带原单号与说明即按原单整笔反向 −500 生效到 −300；原因码与科目随原单、refs 为空、键 ADJ:{原单}:REVERSE、操作人是当前管理员；原单与原凭证不变，详情显示 reversed_by；审计 adjustment_reverse 含红冲单、原单与前后 available；发 account.went_negative', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f);
    const original = await seedForm(f, {
      userId,
      direction: 'increase',
      amount: 500n,
      reason: 'RECON_FIX',
      contra: 'COMMISSION_REVENUE',
    });
    await freeze(f, userId, 300n);
    expect(await moneyOf(f, userId)).toEqual({ available: 200n, frozen: 300n });
    const originalVoucher = await voucherByKey(f, `ADJ:${original.adjust_id}`);
    expect(originalVoucher?.operator).toBe(`admin:${original.created_by ?? ''}`);

    const note = '误调 +500，整笔冲回';
    const sent = await h.create({ reverses_adjust_id: original.adjust_id, note });
    const done = await expectAdjusted(f, sent, {
      caller: h.maker,
      userId,
      direction: 'decrease',
      amount: 500n,
      reason: 'RECON_FIX',
      contra: 'COMMISSION_REVENUE',
      refs: [],
      note,
      reverses: original,
      before: { available: 200n, frozen: 300n },
    });
    expect(done.after).toBe(-300n);
    expect(done.voucher.operator).not.toBe(originalVoucher?.operator);
    expect(await formNow(f, original.adjust_id)).toEqual({
      ...original,
      row_version: expect.any(Number) as unknown,
    });
    expect(await voucherByKey(f, `ADJ:${original.adjust_id}`)).toEqual(originalVoucher);
    expect(await wentNegative(f, userId)).toHaveLength(1);

    const detail = await answer(await h.detail(original.adjust_id), 0);
    const data = detail.data as Record<string, unknown>;
    expect(normalizeForm(data['adjustment'])).toEqual(formView(original, done.row.adjust_id));
    expect(data['balance_preview']).toBeNull();

    expect(await audits(f, CREATE_ACTION)).toEqual([]);
    const recorded = await audits(f, REVERSE_ACTION);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.admin_id).toBe(h.maker.id);
    expectMentions(recorded[0]!, {
      ids: [done.row.adjust_id, original.adjust_id, userId],
      values: ['decrease', '500', 'RECON_FIX', '200', '-300'],
    });
  });
});

it('[AC-B2-12c#10] 不能红冲的原单：已红冲过的 → 20902 admin_adjustment；红冲单本身、待批的系统预填单、已驳回的单 → 20001 reverse_not_allowed（fields=[reverses_adjust_id]）；都不写单、凭证、余额、事件、站内信与审计', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 1000n, status: 'normal' });
    const original = await seedForm(f, { userId, direction: 'increase', amount: 500n });
    const reversal = await seedForm(f, { userId, reverses: original });
    const pending = await seedPrefill(f, userId);
    const rejected = await seedPrefill(f, userId, {
      status: 'REJECTED',
      refs: [{ ref_type: 'account_deletion', ref_id: randomUUID() }],
    });
    const before = await trace(f);
    const auditsBefore = await audits(f);

    await conflict(await h.create({ reverses_adjust_id: original.adjust_id, note: '再冲一次' }));
    for (const target of [reversal, pending, rejected]) {
      await invalid(
        await h.create({ reverses_adjust_id: target.adjust_id, note: '不能红冲' }),
        ['reverses_adjust_id'],
        'reverse_not_allowed',
      );
    }
    expect(await trace(f)).toEqual(before);
    expect(await audits(f)).toEqual(auditsBefore);
  });
});

it('[AC-B2-12c#11] 红冲请求只带原单号与说明：另带方向、金额、原因码、单据、科目或会员任一字段，或缺说明、说明超 500 字 → 20001（schema，fields 含 body）；说明去空白后为空 → fields=[note]；原单不存在或属别的 app → fields=[reverses_adjust_id]；都不留痕', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 1000n });
    const original = await seedForm(f, { userId, direction: 'increase', amount: 500n });
    const otherApp = newAppId();
    const stranger = await member(f, { appId: otherApp });
    const foreign = await seedForm(f, { userId: stranger, appId: otherApp });
    const base = { reverses_adjust_id: original.adjust_id, note: '整笔冲回' };
    const before = await trace(f);

    for (const extra of [
      { direction: 'decrease' },
      { amount_fen: 450 },
      { reason_code: 'RECON_FIX' },
      { refs: [{ ref_type: 'recon_diff', ref_id: randomUUID() }] },
      { contra_subject: 'COMMISSION_REVENUE' },
      { contra_platform: 'jd' },
      { user_id: userId },
    ]) {
      await schemaRefused(await h.create({ ...base, ...extra }));
    }
    await schemaRefused(await h.create({ reverses_adjust_id: original.adjust_id }));
    await schemaRefused(await h.create({ ...base, note: '冲'.repeat(501) }));
    await invalid(await h.create({ ...base, note: '   ' }), ['note']);
    await invalid(await h.create({ ...base, reverses_adjust_id: randomUUID() }), [
      'reverses_adjust_id',
    ]);
    await invalid(await h.create({ ...base, reverses_adjust_id: foreign.adjust_id }), [
      'reverses_adjust_id',
    ]);
    expect(await trace(f)).toEqual(before);
    expect(await audits(f)).toEqual([]);
  });
});

it('[AC-B2-12c#12] 已注销会员：给他提新单 → 20001 adjust_user_deleted（fields=[user_id]）；红冲他已执行的单 → 20001 adjust_user_deleted（fields=[reverses_adjust_id]）；都不留痕', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 1000n, status: 'deleted' });
    const original = await seedForm(f, { userId, direction: 'increase', amount: 500n });
    const diff = await seedReconDiff(f);
    const before = await trace(f);

    await invalid(
      await h.create(
        newForm({
          userId,
          direction: 'decrease',
          amount: 100n,
          reason: 'RECON_FIX',
          refs: [{ ref_type: 'recon_diff', ref_id: diff.id }],
          note: '已注销会员的更正',
          contra: 'COMMISSION_REVENUE',
        }),
      ),
      ['user_id'],
      'adjust_user_deleted',
    );
    await invalid(
      await h.create({ reverses_adjust_id: original.adjust_id, note: '整笔冲回' }),
      ['reverses_adjust_id'],
      'adjust_user_deleted',
    );
    expect(await trace(f)).toEqual(before);
    expect(await audits(f)).toEqual([]);
  });
});

it('[AC-B2-12c#13] D10-590 ④ 注销处理中（users.status=deleting）的会员：不受理新的人工调账单，也不能红冲其 RECON_FIX 单（20001 adjust_user_deleted）；只允许红冲已执行的 ACCOUNT_CLOSED 调减单：整笔 +2000 回到余额，按 ADMIN_ADJUST:ACCOUNT_CLOSED:REVERSE 记账，不发站内信', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 1700n, status: 'deleting' });
    const fix = await seedForm(f, {
      userId,
      direction: 'increase',
      amount: 300n,
      reason: 'RECON_FIX',
      createdAt: new Date(f.clock.now().getTime() - 3 * 3_600_000),
    });
    const deletionId = await seedDeletion(f, userId);
    const closed = await seedForm(f, {
      userId,
      direction: 'decrease',
      amount: 2000n,
      reason: 'ACCOUNT_CLOSED',
      refs: [{ ref_type: 'account_deletion', ref_id: deletionId }],
      contra: 'COMMISSION_REVENUE',
      note: null,
      createdBy: null,
    });
    expect(await moneyOf(f, userId)).toEqual({ available: 0n, frozen: 0n });
    const diff = await seedReconDiff(f);
    const before = await trace(f);

    await invalid(
      await h.create(
        newForm({
          userId,
          direction: 'increase',
          amount: 100n,
          reason: 'RECON_FIX',
          refs: [{ ref_type: 'recon_diff', ref_id: diff.id }],
          note: '注销中的更正',
          contra: 'COMMISSION_REVENUE',
        }),
      ),
      ['user_id'],
      'adjust_user_deleted',
    );
    await invalid(
      await h.create({ reverses_adjust_id: fix.adjust_id, note: '整笔冲回' }),
      ['reverses_adjust_id'],
      'adjust_user_deleted',
    );
    expect(await trace(f)).toEqual(before);

    const note = '注销放弃余额批错，整笔冲回';
    await expectAdjusted(f, await h.create({ reverses_adjust_id: closed.adjust_id, note }), {
      caller: h.maker,
      userId,
      direction: 'increase',
      amount: 2000n,
      reason: 'ACCOUNT_CLOSED',
      contra: 'COMMISSION_REVENUE',
      refs: [],
      note,
      reverses: closed,
      before: { available: 0n, frozen: 0n },
    });
    expect(await inboxOf(f, userId)).toEqual([]);
  });
});
