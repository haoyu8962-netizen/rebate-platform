// BR-WDR-15/14/09, D10-625/626: no executable refund path in the first release.
import { expect, it } from 'vitest';
import {
  DAY,
  PROOF,
  answer,
  bill,
  fixture,
  payee,
  refused,
  seedQueries,
  state,
  suite,
  unknownWithdrawal,
  withUnknownAdmin,
} from './unknown-harness.ts';

const s = suite();

it('[AC-B2-09s#1] 判失败的24小时边界：差1毫秒 too_early，恰24小时及之后 bill_unverifiable；余额、冻结、全部人工字段、退款凭证、hold、事件和审计原封不动', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    for (const age of [DAY - 1, DAY, DAY + 1]) {
      const w = await unknownWithdrawal(f, h, await payee(f, h), { age });
      const before = await state(f);
      await refused(
        await h.resolve(w.id, { resolution: 'failed', proof_text: PROOF }),
        age < DAY ? 'resolve_too_early' : 'resolve_bill_unverifiable',
      );
      // Also checks idempotency: a 2xxxx refusal must not persist a response.
      expect(await state(f)).toEqual(before);
      expect(before.holds).toEqual([]);
      expect(before.vouchers.some((v) => v.uniq_key === `wd:${w.id}:RETURN`)).toBe(false);
    }
  });
});

it('[AC-B2-09s#2] 不能用请求文本或查询fail/unknown充当两天账单与订单不存在证明：无账单、只有其他单、两天非成功行、两天成功行均拒绝；支付宝与微信都不退钱', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    for (const method of ['alipay', 'wechat'] as const) {
      for (const evidence of ['none', 'other', 'pending', 'success'] as const) {
        for (const result of ['fail', 'unknown'] as const) {
          const w = await unknownWithdrawal(f, h, await payee(f, h), { seed: { method } });
          await seedQueries(f, w, [[result, 1]]);
          if (evidence !== 'none') {
            for (const day of ['2026-11-02', '2026-11-03']) {
              await bill(
                f,
                w,
                evidence === 'success' ? 'SUCCESS' : 'PENDING',
                day,
                evidence === 'other' ? `OTHER${w.out_biz_no.slice(5)}` : w.out_biz_no,
              );
            }
          }
          const before = await state(f);
          await refused(
            await h.resolve(w.id, { resolution: 'failed', proof_text: PROOF }),
            'resolve_bill_unverifiable',
          );
          expect(await state(f)).toEqual(before);
        }
      }
    }
  });
});

it('[AC-B2-09s#3] fail_blockers顺序和拒绝原因一致：未满24小时在前，账单与查询两个常驻原因均保留，读列表不写审计', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const young = await unknownWithdrawal(f, h, await payee(f, h), { age: DAY - 1 });
    const old = await unknownWithdrawal(f, h, await payee(f, h), { age: DAY });
    const before = await state(f);
    const response = await answer(await h.list(), 0);
    expect(response.data).toMatchObject({
      items: [
        {
          withdrawal_id: old.id,
          fail_blockers: ['resolve_bill_unverifiable', 'resolve_query_unverifiable'],
        },
        {
          withdrawal_id: young.id,
          fail_blockers: [
            'resolve_too_early',
            'resolve_bill_unverifiable',
            'resolve_query_unverifiable',
          ],
        },
      ],
      total: 2,
    });
    expect(await state(f)).toEqual(before);
  });
});
