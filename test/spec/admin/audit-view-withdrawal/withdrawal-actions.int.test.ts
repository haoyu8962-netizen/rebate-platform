// B2-09q §9 is the oracle (task refs: []): no extra business rules asserted here.
// Existing entry points suffice; the missing RULES entries must fail value assertions, not imports.
import { expect, it } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  adjust,
  everything,
  fixture,
  member,
  otherApp,
  seedReview,
  setSwitch,
  suite,
} from '../../payout/admin-withdrawal-review/review-harness.ts';
import { entryOf, payee, reviewing } from '../../payout/admin-manual-paid/manual-paid-harness.ts';
import { watermarkBody } from '../../payout/admin-payout-batch/batch-harness.ts';
import { validate } from '../audit-query/kit.ts';
import { expectPage, systemReject, view, withAuditAdmin } from './audit-harness.ts';

const s = suite();
const TIMEOUT = 90_000;

it(
  '[AC-B2-09q#1] 同一单审核后补录、另一单审核后驳回：单号精确归集；列表详情、类型权限筛选一致且读取不写库',
  async () => {
    const f = fixture(s);
    await withAuditAdmin(f, async (h) => {
      const who = await payee(f, h);
      const paid = await reviewing(f, h, who);
      const rejected = await reviewing(f, h, who);
      expect(await h.write('approve', { withdrawal_ids: [paid.id, rejected.id] })).toEqual({
        items: [paid, rejected].map((row) => ({
          withdrawal_id: row.id,
          result: 'approved',
          reason: null,
        })),
      });
      expect(await h.write('manual', { items: [entryOf(f, paid)] })).toEqual({
        items: [{ withdrawal_id: paid.id, result: 'paid', reason: null }],
      });
      expect(
        await h.write(
          'reject',
          { reason_code: 'USER_REQUEST', note: '合成用户取消申请' },
          rejected.id,
        ),
      ).toMatchObject({ withdrawal_id: rejected.id, status: 'REJECTED' });

      const approvedPaid = view('withdrawal_approve', 'withdrawal', paid.id, 'withdraw.review');
      const manualPaid = view(
        'withdrawal_manual_paid',
        'withdrawal',
        paid.id,
        'payout.manual_entry',
      );
      const approvedRejected = view(
        'withdrawal_approve',
        'withdrawal',
        rejected.id,
        'withdraw.review',
      );
      const manualRejected = view(
        'withdrawal_reject',
        'withdrawal',
        rejected.id,
        'withdraw.review',
      );
      const all = [approvedPaid, manualPaid, approvedRejected, manualRejected];
      const before = await everything(f);
      await expectPage(h, {}, all);
      await expectPage(h, { target_id: paid.id }, [approvedPaid, manualPaid]);
      await expectPage(h, { target_id: rejected.id }, [approvedRejected, manualRejected]);
      await expectPage(h, { target_type: 'withdrawal' }, all);
      await expectPage(h, { permission: 'withdraw.review' }, [
        approvedPaid,
        approvedRejected,
        manualRejected,
      ]);
      await expectPage(h, { permission: 'payout.manual_entry' }, [manualPaid]);
      await expectPage(
        h,
        { target_type: 'withdrawal', target_id: paid.id, permission: 'payout.manual_entry' },
        [manualPaid],
      );
      await expectPage(h, { target_id: rejected.id, permission: 'payout.manual_entry' }, []);
      await expectPage(h, { target_type: 'payout_batch', target_id: paid.id }, []);
      expect(await everything(f)).toEqual(before);
    });
  },
  TIMEOUT,
);

it.each(['RISK_SUSPECT', 'ORDER_ABNORMAL', 'PAYEE_INFO_INVALID', 'USER_REQUEST', 'OTHER'] as const)(
  '[AC-B2-09q#2] 人工驳回 %s：真实 after.reason_code 映射 withdraw.review，审核历史仍按原单号查到',
  async (reason) => {
    const f = fixture(s);
    await withAuditAdmin(f, async (h) => {
      const row = await seedReview(f, h, await member(f, h));
      expect(await h.write('approve', { withdrawal_ids: [row.id] })).toEqual({
        items: [{ withdrawal_id: row.id, result: 'approved', reason: null }],
      });
      expect(
        await h.write('reject', { reason_code: reason, note: '合成人工审核备注' }, row.id),
      ).toMatchObject({ withdrawal_id: row.id, reject_reason_code: reason });
      const expected = [
        view('withdrawal_approve', 'withdrawal', row.id, 'withdraw.review'),
        view('withdrawal_reject', 'withdrawal', row.id, 'withdraw.review'),
      ];
      const rows = await expectPage(h, {}, expected);
      const rejection = rows.find((item) => item.action === 'withdrawal_reject');
      expect(rejection).toBeDefined();
      expect(await h.detail(rejection!.id)).toMatchObject({
        after: { reason_code: reason },
        permission: 'withdraw.review',
        target_type: 'withdrawal',
        target_id: row.id,
      });
      await expectPage(h, { target_id: row.id }, expected);
      await expectPage(h, { target_type: 'withdrawal', permission: 'withdraw.review' }, expected);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09q#3] 真实水位录入、批次执行与整批拒绝：各目标和权限准确；空目标仅权限可筛选',
  async () => {
    const f = fixture(s);
    await withAuditAdmin(f, async (h) => {
      const row = await seedReview(f, h, await member(f, h));
      expect(await h.write('approve', { withdrawal_ids: [row.id] })).toEqual({
        items: [{ withdrawal_id: row.id, result: 'approved', reason: null }],
      });
      const watermark = await h.write<Schema<'AdminPayoutWatermarkResult'>>(
        'watermark',
        watermarkBody(f, 3_000_001),
      );
      const watermarkId = watermark.watermark.watermark_id;
      expect(watermarkId).toBeTypeOf('string');
      const batch = await h.write<Schema<'AdminPayoutBatchResult'>>('batch', {
        withdrawal_ids: [row.id],
      });
      expect(batch).toMatchObject({
        outcome: 'executed',
        paying: [row.id],
        left: [],
        reason: null,
      });
      expect(batch.batch_id).toBeTypeOf('string');
      await setSwitch(f, 'payout.enabled', false);
      expect(await h.write('batch', { withdrawal_ids: [row.id] })).toEqual({
        outcome: 'rejected',
        batch_id: null,
        reason: 'payout_disabled',
        channel: null,
        paying: [],
        left: [],
      });
      // §9.6 resolves the table's shorthand: null target has no type/id, but keeps payout.execute.
      const approved = view('withdrawal_approve', 'withdrawal', row.id, 'withdraw.review');
      const cash = view(
        'payout_watermark_create',
        'payout_watermark',
        watermarkId,
        'fund.cash_entry',
      );
      const executed = view(
        'payout_batch_execute',
        'payout_batch',
        batch.batch_id,
        'payout.execute',
      );
      const refused = view('payout_batch_execute', null, null, 'payout.execute');
      const before = await everything(f);
      await expectPage(h, {}, [approved, cash, executed, refused]);
      await expectPage(h, { target_type: 'payout_batch' }, [executed]);
      await expectPage(h, { target_id: batch.batch_id! }, [executed]);
      await expectPage(h, { permission: 'payout.execute' }, [executed, refused]);
      await expectPage(h, { target_type: 'payout_batch', permission: 'payout.execute' }, [
        executed,
      ]);
      await expectPage(h, { target_type: 'payout_watermark' }, [cash]);
      await expectPage(h, { target_id: watermarkId }, [cash]);
      await expectPage(h, { permission: 'fund.cash_entry' }, [cash]);
      await expectPage(h, { target_id: watermarkId, permission: 'payout.execute' }, []);
      expect(await everything(f)).toEqual(before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09q#4] worker 实际系统驳回可按单号查询，system:payout、权限 null，withdraw.review 只返回人工动作',
  async () => {
    const f = fixture(s);
    await withAuditAdmin(f, async (h) => {
      const debtor = await member(f, h);
      const negative = await seedReview(f, h, debtor);
      // Seeded available is 87,658; a real ledger adjustment makes it −1 before worker delivery.
      await adjust(f, debtor, -87_659n);
      await systemReject(f, debtor.userId);
      const human = await seedReview(f, h, await member(f, h));
      expect(await h.write('approve', { withdrawal_ids: [human.id] })).toEqual({
        items: [{ withdrawal_id: human.id, result: 'approved', reason: null }],
      });
      expect(
        await h.write('reject', { reason_code: 'OTHER', note: '合成人工驳回' }, human.id),
      ).toMatchObject({ withdrawal_id: human.id, status: 'REJECTED' });
      const automatic = view('withdrawal_reject', 'withdrawal', negative.id, null);
      const approved = view('withdrawal_approve', 'withdrawal', human.id, 'withdraw.review');
      const rejected = view('withdrawal_reject', 'withdrawal', human.id, 'withdraw.review');
      const [row] = await expectPage(h, { target_id: negative.id }, [automatic]);
      expect(row).toMatchObject({
        actor_id: null,
        actor_kind: 'system',
        system_actor: 'system:payout',
        permission: null,
      });
      expect(await h.detail(row!.id)).toMatchObject({
        ...automatic,
        actor_id: null,
        actor_kind: 'system',
        system_actor: 'system:payout',
        after: { withdrawal_id: negative.id, reason_code: 'NEGATIVE_BALANCE', status: 'REJECTED' },
      });
      await expectPage(h, {}, [automatic, approved, rejected]);
      await expectPage(h, { target_type: 'withdrawal' }, [automatic, approved, rejected]);
      await expectPage(h, { permission: 'withdraw.review' }, [approved, rejected]);
      await expectPage(h, { target_id: negative.id, permission: 'withdraw.review' }, []);
      await expectPage(h, { target_id: human.id, permission: 'withdraw.review' }, [
        approved,
        rejected,
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09q#5] 两个 app 查询同一个真实提现单号及审计 ID：外部 app 看不到，自己的同类行仍能正确读取',
  async () => {
    const f = fixture(s);
    await withAuditAdmin(f, async (h) => {
      const foreign = otherApp(f);
      const outsider = await h.caller(foreign.appId);
      const local = await seedReview(f, h, await member(f, h));
      const other = await seedReview(foreign, h, await member(foreign, h));
      expect(await h.write('approve', { withdrawal_ids: [local.id] })).toEqual({
        items: [{ withdrawal_id: local.id, result: 'approved', reason: null }],
      });
      expect(await h.write('approve', { withdrawal_ids: [other.id] }, undefined, outsider)).toEqual(
        {
          items: [{ withdrawal_id: other.id, result: 'approved', reason: null }],
        },
      );
      // The same globally unique withdrawal ID is looked up under two authenticated app contexts.
      const ownList = await h.page();
      expect(ownList.items).toHaveLength(1);
      const foreignList = await h.page({}, outsider);
      expect(foreignList.items).toHaveLength(1);
      expect(await h.page({ target_id: local.id }, outsider)).toMatchObject({
        total: 0,
        items: [],
      });
      expect(await h.page({ target_id: other.id })).toMatchObject({ total: 0, items: [] });
      const forbidden = await h.readDetail(ownList.items[0]!.id, outsider);
      expect(forbidden.statusCode).toBe(400);
      expect(forbidden.json()).toMatchObject({ code: 20001, data: { fields: ['id'] } });
      await validate(forbidden, true);
      const own = view('withdrawal_approve', 'withdrawal', local.id, 'withdraw.review');
      await expectPage(h, { target_id: local.id }, [own]);
      await expectPage(h, { target_type: 'withdrawal' }, [own]);
      await expectPage(h, { permission: 'withdraw.review' }, [own]);
      const visible = await h.page({ target_id: other.id }, outsider);
      expect(visible.total).toBe(1);
      expect(visible.items).toHaveLength(1);
      expect(visible.items[0]).toMatchObject(
        view('withdrawal_approve', 'withdrawal', other.id, 'withdraw.review'),
      );
      expect(await h.detail(visible.items[0]!.id, outsider)).toMatchObject(visible.items[0]!);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09q#6] 新提现动作与真实风控、导出动作共存：原有推导和筛选不变，不把其他对象误归为提现',
  async () => {
    const f = fixture(s);
    await withAuditAdmin(f, async (h) => {
      const who = await member(f, h);
      const withdrawal = await seedReview(f, h, who);
      expect(await h.write('approve', { withdrawal_ids: [withdrawal.id] })).toEqual({
        items: [{ withdrawal_id: withdrawal.id, result: 'approved', reason: null }],
      });
      expect(
        await h.write(
          'risk',
          {
            action: 'freeze',
            reason: '合成审计回归案例',
            reason_category: 'other',
            expected_row_version: null,
          },
          who.userId,
        ),
      ).toMatchObject({ state: 'frozen' });
      const exported = await h.write<Schema<'AdminExport'>>('export', {
        resource: 'users',
        filters: { risk_state: 'frozen' },
      });
      expect(exported.id).toMatch(/^exp_/);
      const approved = view('withdrawal_approve', 'withdrawal', withdrawal.id, 'withdraw.review');
      const risk = view('user_risk_state_change', 'user', who.userId, 'risk.freeze');
      const exportView = view('export_create', 'export_task', exported.id, 'export');
      await expectPage(h, {}, [approved, risk, exportView]);
      await expectPage(h, { target_type: 'withdrawal' }, [approved]);
      await expectPage(h, { target_id: who.userId }, [risk]);
      await expectPage(h, { target_type: 'user', permission: 'risk.freeze' }, [risk]);
      await expectPage(h, { target_id: exported.id }, [exportView]);
      await expectPage(h, { target_type: 'export_task', permission: 'export' }, [exportView]);
      await expectPage(h, { target_type: 'withdrawal', permission: 'export' }, []);
    });
  },
  TIMEOUT,
);
