// B2-09l isolation rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutBatch — every read is limited to the app of the console: another app's withdrawal is
// not_approved and does not move; another app's W, P, switches and committed sums do not count. Requests
// go through the real admin entry (batch-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  FORECAST_SOURCE,
  PLENTY,
  W_JUST_ENOUGH,
  approved,
  expectExecuted,
  expectRejected,
  fixture,
  item,
  itemsOf,
  ofNet,
  otherApp,
  payee,
  rowOf,
  seedHistory,
  seedReview,
  seedW,
  setSwitch,
  suite,
  withBatchAdmin,
  world,
} from './batch-harness.ts';

const s = suite();

it('[AC-B2-09l#55] 别的 app 的单：not_approved，不动，那个 app 什么都没变（没有批次、item、任务、审计）', async () => {
  const f = fixture(s);
  const other = otherApp(f);
  await withBatchAdmin(f, async (h) => {
    const outsider = await approved(other, h, await payee(other, h));
    await seedW(other, { fen: PLENTY });
    const mine = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: PLENTY });
    const theirs = await world(other);

    const batchId = await expectExecuted(await h.execute([mine.id, outsider.id]), {
      paying: [mine.id],
      left: [[outsider.id, 'not_approved']],
    });

    expect(await rowOf(other, outsider)).toEqual(outsider);
    expect(await world(other)).toEqual(theirs);
    expect(await itemsOf(f)).toEqual([item(batchId, mine, 'paying')]);
  });
});

it('[AC-B2-09l#56] 别的 app 的 W 不让本 app 通过：本 app 没有 W、别的 app 有足额的 → watermark_stale；本 app 录了才执行', async () => {
  const f = fixture(s);
  const other = otherApp(f);
  await withBatchAdmin(f, async (h) => {
    await seedW(other, { fen: PLENTY });
    const mine = await approved(f, h, await payee(f, h));

    await expectRejected(await h.execute([mine.id]), 'watermark_stale', 'alipay');

    await seedW(f, { fen: PLENTY });
    await expectExecuted(await h.execute([mine.id]), { paying: [mine.id] });
  });
});

it('[AC-B2-09l#57] 别的 app 的 P、在途和开关不算：那边近 7 日 ¥49,000、PAYING 90,001、payout.enabled 关，本 app W=13,719 照常执行', async () => {
  const f = fixture(s);
  const other = otherApp(f);
  await withBatchAdmin(f, async (h) => {
    const outsider = await payee(other, h);
    await seedHistory(other, h, outsider, FORECAST_SOURCE);
    await seedReview(other, h, outsider, { status: 'PAYING', execute_seq: 1, ...ofNet(90_001n) });
    await setSwitch(other, 'payout.enabled', false);
    const mine = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: W_JUST_ENOUGH });

    await expectExecuted(await h.execute([mine.id]), { paying: [mine.id] });
  });
});
