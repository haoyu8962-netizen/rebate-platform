// B2-09i isolation rule tests (claude-independent, SPEC_REF 6f50a051): 08 BR-WDR-18 细则「多通道的 W」
// (D10-285, D10-288, D10-290) — W is per channel: an entry of one channel never lets another channel's
// withdrawals pass; a channel without a row is stale, in a mixed batch only that channel's withdrawals
// are kept. And per app: an entry only touches its own app; another app's latest row neither decides
// the check on going backwards nor lets this app's judgement pass. The judgement is B2-06c's real
// EXECUTE. Requests go through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  MINUTE,
  enterBody,
  entered,
  executeAuto,
  executedOf,
  fixture,
  member,
  openWechat,
  otherApp,
  readings,
  refusedFor,
  seedWatermark,
  seedWithdrawal,
  sorted,
  suite,
  watermarkRows,
  withWatermarkAdmin,
  withdrawalRow,
} from './kit.ts';

const s = suite();

it('[AC-B2-09i#35] 通道隔离：只录 wechat 时，alipay 的单仍判 watermark_stale（channel=alipay），wechat 的单能执行', async () => {
  const f = fixture(s);
  await openWechat(f);
  const alipay = await seedWithdrawal(f, { userId: await member(f) });
  const wechat = await seedWithdrawal(f, { userId: await member(f), channel: 'wechat' });
  await withWatermarkAdmin(f, async (h) => {
    await entered(await h.enter(enterBody({ channel: 'wechat', available_fen: 1_000_000 })));
    expect(await executeAuto(f, [alipay])).toEqual(refusedFor('watermark_stale', 'alipay'));
    expect((await withdrawalRow(f, alipay)).status).toBe('APPROVED');
    expect(executedOf(await executeAuto(f, [wechat])).paying).toEqual([wechat]);
  });
});

it('[AC-B2-09i#36] 通道隔离：只录 alipay 时，wechat 的单仍判 watermark_stale（channel=wechat），alipay 的单能执行', async () => {
  const f = fixture(s);
  await openWechat(f);
  const alipay = await seedWithdrawal(f, { userId: await member(f) });
  const wechat = await seedWithdrawal(f, { userId: await member(f), channel: 'wechat' });
  await withWatermarkAdmin(f, async (h) => {
    await entered(await h.enter(enterBody({ channel: 'alipay', available_fen: 1_000_000 })));
    expect(await executeAuto(f, [wechat])).toEqual(refusedFor('watermark_stale', 'wechat'));
    expect((await withdrawalRow(f, wechat)).status).toBe('APPROVED');
    expect(executedOf(await executeAuto(f, [alipay])).paying).toEqual([alipay]);
  });
});

it('[AC-B2-09i#37] 混通道批次（D10-288）：只录 alipay 时只拦 wechat 的单（left watermark_stale、留 APPROVED），alipay 的单进入 PAYING；录入 wechat 后被拦的单也能执行', async () => {
  const f = fixture(s);
  await openWechat(f);
  const alipay = await seedWithdrawal(f, { userId: await member(f) });
  const wechat = await seedWithdrawal(f, { userId: await member(f), channel: 'wechat' });
  await withWatermarkAdmin(f, async (h) => {
    await entered(await h.enter(enterBody({ channel: 'alipay', available_fen: 1_000_000 })));
    const mixed = executedOf(await executeAuto(f, [alipay, wechat]));
    expect(mixed.paying).toEqual([alipay]);
    expect(mixed.left).toEqual([{ id: wechat, reason: 'watermark_stale' }]);
    expect((await withdrawalRow(f, alipay)).status).toBe('PAYING');
    expect((await withdrawalRow(f, wechat)).status).toBe('APPROVED');

    await entered(await h.enter(enterBody({ channel: 'wechat', available_fen: 1_000_000 })));
    expect(sorted(executedOf(await executeAuto(f, [wechat])).paying)).toEqual([wechat]);
  });
});

it('[AC-B2-09i#38] 隔离：别的 app 的最新一条（09:50）不影响本 app 的倒退判断，本 app 录 09:30 照常写入，行只属于本 app，别的 app 的行不变', async () => {
  const f = fixture(s);
  const other = otherApp(f);
  await seedWatermark(f, {
    availableFen: 500n,
    measuredAt: '2026-11-03T09:50:00+08:00',
    appId: other,
  });
  const theirs = await watermarkRows(f, other);
  expect(theirs).toHaveLength(1);
  await withWatermarkAdmin(f, async (h) => {
    await entered(await h.enter(enterBody({ measured_at: '2026-11-03T09:30:00+08:00' })));
    expect((await watermarkRows(f)).map((row) => row.app_id)).toEqual([f.appId]);
    expect(await watermarkRows(f, other)).toEqual(theirs);
  });
});

it('[AC-B2-09i#39] 隔离：别的 app 新鲜足额的 W 不让本 app 的判定通过；本 app 录入的 W 也不让第三个 app 的判定通过', async () => {
  const f = fixture(s);
  const other = otherApp(f);
  const third = otherApp(f, 'third');
  await seedWatermark(f, {
    availableFen: 1_000_000_000n,
    measuredAt: new Date(f.clock.now().getTime() - 5 * MINUTE).toISOString(),
    appId: other,
  });
  const ours = await seedWithdrawal(f, { userId: await member(f) });
  const stranger = await seedWithdrawal(f, { userId: await member(f, third), appId: third });
  await withWatermarkAdmin(f, async (h) => {
    expect(await executeAuto(f, [ours])).toEqual(refusedFor('watermark_stale'));

    await entered(await h.enter(enterBody({ available_fen: 1_000_000 })));
    expect(await executeAuto(f, [stranger], third)).toEqual(refusedFor('watermark_stale'));
    expect((await withdrawalRow(f, stranger, third)).status).toBe('APPROVED');
    expect(executedOf(await executeAuto(f, [ours])).paying).toEqual([ours]);
  });
});

it('[AC-B2-09i#40] 隔离：两个 app 各自经接口录入，先录 09:50 的 app 不挡另一个 app 录 09:30；账号与 app 对应，互不串行', async () => {
  const f = fixture(s);
  const g = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    await entered(await h.enter(enterBody({ measured_at: '2026-11-03T09:50:00+08:00' })));
  });
  await withWatermarkAdmin(g, async (h) => {
    await entered(await h.enter(enterBody({ measured_at: '2026-11-03T09:30:00+08:00' })));
  });
  expect(await readings(f)).toEqual([Date.parse('2026-11-03T09:50:00+08:00')]);
  expect(await readings(g)).toEqual([Date.parse('2026-11-03T09:30:00+08:00')]);
});
