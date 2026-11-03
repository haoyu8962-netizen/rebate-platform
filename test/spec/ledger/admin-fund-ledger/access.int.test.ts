// B2-04zs access rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminGetFundLedger — fund.view or a super admin, no step-up; any other account 10403, no token
// 10001; a reading writes nothing: no audit record, no snapshot, no event, no row of the books.
// Requests go through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { allSnapshots, snapshotEvents } from '../admin-asset-snapshots/kit.ts';
import {
  CASH_ENTRY,
  VIEW,
  answer,
  audits,
  clawback,
  denied,
  everything,
  fixture,
  openMember,
  overview,
  seedForecastOf2100000,
  seedReceivable,
  seedWatermark,
  suite,
  withFundAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-04zs#2] 权限：只持 fund.view 与超管都能读且不要 step-up；只持 fund.cash_entry、只持 fund.recon、没有权限点 → 10403；不带令牌 → 10001', async () => {
  const f = fixture(s);
  await seedReceivable(f, 'taobao', 1_000n);
  const want = [{ platform: 'taobao', union_receivable_fen: 1_000 }];
  await withFundAdmin(f, async (h) => {
    const viewer = await h.caller([VIEW]);
    expect((await overview(await h.read(viewer))).receivables).toEqual(want);
    const root = await h.caller([], { superAdmin: true });
    expect((await overview(await h.read(root))).receivables).toEqual(want);

    await denied(await h.read(await h.caller([CASH_ENTRY])));
    await denied(await h.read(await h.caller(['fund.recon'])));
    await denied(await h.read(await h.caller([])));
    await answer(await h.read(null), 10001);
  });
});

it('[AC-B2-04zs#3] 只读：fund.view 与超管读取都不写审计，也不写快照、事件、凭证、分录、余额、水位或回款行', async () => {
  const f = fixture(s);
  await seedReceivable(f, 'taobao', 1_000n);
  await clawback(f, await openMember(f), 300n);
  await seedForecastOf2100000(f);
  await seedWatermark(f, { fen: 3_000_000n });
  const before = await everything(f);
  await withFundAdmin(f, async (h) => {
    const viewer = await h.caller([VIEW]);
    const first = await overview(await h.read(viewer));
    expect(first.negative_total_fen).toBe(300);
    const root = await h.caller([], { superAdmin: true });
    expect(await overview(await h.read(root))).toEqual(first);
  });
  expect(await audits(f)).toEqual([]);
  expect(await everything(f)).toEqual(before);
  expect(await allSnapshots(f)).toEqual([]);
  expect(await snapshotEvents(f)).toEqual([]);
});
