// B2-09gb rule test, R13 and an identified minor (claude-independent, SPEC_REF 29c27a1b):
// contracts/openapi.yaml restoreAdminReconDiff (R13: "the promotion share of a member identified as
// under 18 goes to the platform") and 08 BR-CALC-09 (已识别未满 18 周岁：推广份额的正向差额归平台，
// 自购份额不受影响), BR-ID-26 (b). The identification is the BeneficiaryGate's (B1-03zc minors port)
// over real field ciphers, so the fixture and the admin entry come from ../forfeited-state/kit.ts
// (read only, imported: the entry opens the fixture's keys). Base order as in kit.ts: N 1000 at the
// credit, clawed back in full, now settled 2000 → B 1700: self 850, direct 170, indirect 85,
// platform 895. Top-level it() only.
import { expect, it } from 'vitest';
import {
  MINOR_BIRTH,
  fixture as stateFixture,
  identify,
  suite,
  withAdmin,
} from '../forfeited-state/kit.ts';
import {
  available,
  memberLines,
  netsOf,
  orderRow,
  platformKey,
  platformLines,
  platformRestored,
  restoreKey,
  seedClawedBack,
  seedPlatformDiff,
  voucherLines,
} from './kit.ts';

const s = suite();

it('[AC-B2-09gb#13] R13 已识别未成年（BR-CALC-09、BR-ID-26 (b)）：本人份额照补（未成年本人 850）；未成年直推的推广份额 170 归平台，不写其凭证、余额不变；成年间推 85 照补；平台 895 + 170 = 1065；restored_fen 935；UNION_RECEIVABLE 净额 2000', async () => {
  const f = await stateFixture(s);
  const c = await seedClawedBack(f);
  const self = c.user('self');
  const direct = c.user('direct');
  const indirect = c.user('indirect');
  await identify(f, self, { birth: MINOR_BIRTH });
  await identify(f, direct, { birth: MINOR_BIRTH });
  const diff = await seedPlatformDiff(f, c);
  await withAdmin(f, async (h) => {
    const data = await platformRestored(await h.restore(diff.id));
    expect(data.restored_fen).toBe(935);
    expect(data.rebate_status_after).toBe('CREDITED');
    expect(await voucherLines(f, restoreKey(c.orderKey, self, 'self', diff.id))).toEqual(
      memberLines(c.platform, self, 850n),
    );
    expect(await voucherLines(f, restoreKey(c.orderKey, direct, 'direct', diff.id))).toEqual([]);
    expect(await voucherLines(f, restoreKey(c.orderKey, indirect, 'indirect', diff.id))).toEqual(
      memberLines(c.platform, indirect, 85n),
    );
    expect(await voucherLines(f, platformKey(c.orderKey, diff.id))).toEqual(
      platformLines(c.platform, 1065n),
    );
    expect(await available(f, self)).toBe(850n);
    expect(await available(f, direct)).toBe(0n);
    const nets = await netsOf(f, c.orderKey);
    expect(nets.union_receivable_net_fen).toBe(2000n);
    expect(nets.platform_net_fen).toBe(1065n);
    expect((await orderRow(f, c.orderId)).rebate_status).toBe('CREDITED');
  });
});
