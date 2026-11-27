// B2-02ze (claude-independent, SPEC_REF d49d8aa5): 08 BR-ID-33 on the free text of
// createAdminPayRefund (POST /admin/v1/pay-orders/{pay_order_id}/refunds, body `note`, audit
// pay_refund_create) through the real admin entry (../../payment/refund/kit.ts: pay.refund,
// Idempotency-Key, synthetic channels). Task brief §9.1 #1, #3. Top-level it() only.
import { expect, it } from 'vitest';
import { fixture, suite } from '../../payment/orders/kit.ts';
import {
  created,
  refundAudits,
  refundBody,
  refundChannels,
  refundJobs,
  refunds,
  seedPaid,
  withAdmin,
} from '../../payment/refund/kit.ts';
import { expectRedacted, sampleA } from './kit.ts';

const s = suite();

it('[AC-B2-02ze#3] 退款备注里写了邮箱、18 位身份证（末位 X）、空格分组且过 Luhn 的银行卡号、手机号：退款照常建单，pay_refund_create 审计全文不含任何一项明文；备注仍在（说明文字保留，含 @ 的邮箱片段从空白到空白整段遮成 ***、域名不显示，手机 138****5678、证件 1****************X、卡号只露末 4 位；同长同分组但不过 Luhn 的对照号按兜底也只留末四位，B2-02zg D10-3266）；退款单 id、out_refund_no、支付单 id、金额与原因码原样', async () => {
  const f = await fixture(s);
  const { channels } = refundChannels(f);
  const { kit } = await refundJobs(f, channels);
  const order = await seedPaid(f, kit, 'wechat_pay');
  f.clock.advanceMs(60_000);
  await withAdmin(f, channels, async (h) => {
    const sample = sampleA('丙');
    const target = { type: 'pay_order', id: order.id } as const;
    await created(await h.refund(target, refundBody(5_000, 'USER_REQUEST', sample.text)));

    const [refund] = await refunds(f);
    expect(refund, 'the refund row').toBeDefined();
    const rows = await refundAudits(f);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expectRedacted(row, sample);
    expect(row.after).toMatchObject({
      pay_refund_id: refund!.id,
      target_id: order.id,
      out_refund_no: refund!.out_refund_no,
      amount_fen: 5_000,
      reason_code: 'USER_REQUEST',
    });
  });
});
