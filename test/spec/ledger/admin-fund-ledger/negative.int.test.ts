// B2-04zs rule tests, 负余额 (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminGetFundLedger; 08 BR-FUND-20 (看板：负余额总额), BR-FUND-18 (negative_fen side); 编排裁定 D10-589 —
// negative_total_fen is the sum of the magnitudes of the negative available balances, netted per
// account over all the posted entries; negative_user_count the number of those accounts; positive and
// zero accounts do not count, frozen does not count. Balances are posted through the real ledger
// (a user entry is debit positive: available = −Σ amount_fen). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  NOW,
  clawback,
  credit,
  fixture,
  freeze,
  openMember,
  overview,
  seedReceivable,
  suite,
  tamperCache,
  withFundAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-04zs#13] 按账户净额分正负：−300、(+800 −2,000 = −1,200) → 合计 1,500、2 户；正余额 5,000、相抵为 0、(−400 +1,000 = +600) 都不计入；用户分录不动应收', async () => {
  const f = fixture(s);
  await clawback(f, await openMember(f), 300n);
  const netted = await openMember(f);
  await credit(f, netted, 800n);
  await clawback(f, netted, 2_000n);
  await credit(f, await openMember(f), 5_000n);
  const zero = await openMember(f);
  await credit(f, zero, 700n);
  await clawback(f, zero, 700n);
  const recovered = await openMember(f);
  await clawback(f, recovered, 400n);
  await credit(f, recovered, 1_000n);
  await openMember(f);
  await withFundAdmin(f, async (h) => {
    const view = await overview(await h.read());
    expect(view.negative_total_fen).toBe(1_500);
    expect(view.negative_user_count).toBe(2);
    expect(view.receivables).toEqual([]);
    expect(view.union_receivable_total_fen).toBe(0);
  });
});

it('[AC-B2-04zs#14] 只看 available，frozen 不算：available −300、frozen 500 的账户计 300；available 0、frozen 1,000 的账户不计入', async () => {
  const f = fixture(s);
  const held = await openMember(f);
  await credit(f, held, 500n);
  await freeze(f, held, 500n);
  await clawback(f, held, 300n);
  const onlyFrozen = await openMember(f);
  await credit(f, onlyFrozen, 1_000n);
  await freeze(f, onlyFrozen, 1_000n);
  await withFundAdmin(f, async (h) => {
    const view = await overview(await h.read());
    expect(view.negative_total_fen).toBe(300);
    expect(view.negative_user_count).toBe(1);
  });
});

it('[AC-B2-04zs#15] 读时算分录，不读余额缓存：缓存被改成相反符号时仍按分录得 300、1 户；没有分录、缓存为负的账户不计入', async () => {
  const f = fixture(s);
  const negative = await openMember(f);
  await clawback(f, negative, 300n);
  await tamperCache(f, negative, 9_999n);
  const positive = await openMember(f);
  await credit(f, positive, 500n);
  await tamperCache(f, positive, -7_777n);
  await tamperCache(f, await openMember(f), -4_444n);
  await withFundAdmin(f, async (h) => {
    const view = await overview(await h.read());
    expect(view.negative_total_fen).toBe(300);
    expect(view.negative_user_count).toBe(1);
  });
});

it('[AC-B2-04zs#16] 不按会计日截断：当天的扣回立刻体现（1,000 → 1,000 − 1,200 = −200）；凭证会计日晚于读取时刻的扣回同样计入', async () => {
  const f = fixture(s);
  const today = await openMember(f);
  await credit(f, today, 1_000n);
  await withFundAdmin(f, async (h) => {
    expect((await overview(await h.read())).negative_user_count).toBe(0);
    await clawback(f, today, 1_200n);
    const view = await overview(await h.read());
    expect(view.negative_total_fen).toBe(200);
    expect(view.negative_user_count).toBe(1);

    const later = await openMember(f);
    f.clock.set('2026-10-30T08:00:00.000Z');
    await clawback(f, later, 50n);
    f.clock.set(NOW);
    const both = await overview(await h.read());
    expect(both.negative_total_fen).toBe(250);
    expect(both.negative_user_count).toBe(2);
  });
});

it('[AC-B2-04zs#17] 负余额与应收互不影响：应收 1,000 与负余额 300 同时存在时各算各的', async () => {
  const f = fixture(s);
  await seedReceivable(f, 'taobao', 1_000n);
  await clawback(f, await openMember(f), 300n);
  await withFundAdmin(f, async (h) => {
    const view = await overview(await h.read());
    expect(view.receivables).toEqual([{ platform: 'taobao', union_receivable_fen: 1_000 }]);
    expect(view.union_receivable_total_fen).toBe(1_000);
    expect(view.negative_total_fen).toBe(300);
    expect(view.negative_user_count).toBe(1);
  });
});
