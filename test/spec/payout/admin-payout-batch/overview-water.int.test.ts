// B2-09l overview rule tests, 水位 (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminGetPayoutOverview, adminGetFundLedger, 08 BR-WDR-18, 编排裁定 D10-285 — per channel: `watermark` is
// the latest W by measured_at, null until a row exists, with who entered it; `forecast_withdrawal_fen` is
// P, 0 (not null) with no recent withdrawals; `water_level` is low when W < 1.5 P, else normal, null with
// no W or past the 2 hour limit, while watermark.measured_at still shows its age. The same data reads the
// same as GET /admin/v1/fund-ledger and as the judgement of EXECUTE. Expected values are by hand.
// Requests go through the real admin entry (batch-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  FORECAST,
  FORECAST_SOURCE,
  HOUR,
  MINUTE,
  VIEW,
  answer,
  approved,
  byNobody,
  channelOf,
  expectExecuted,
  expectRejected,
  fixture,
  payee,
  seedHistory,
  seedW,
  shown,
  suite,
  viewOf,
  watermarkBody,
  withBatchAdmin,
  type AdminSent,
  type ShownWatermark,
} from './batch-harness.ts';

const s = suite();

async function ledgerOf(sent: AdminSent) {
  return (await answer(sent, 0)).data as {
    readonly watermark: ShownWatermark | null;
    readonly forecast_withdrawal_fen: number | null;
    readonly water_level: string | null;
  };
}

it('[AC-B2-09l#67] watermark：没有行时 null（不是 0）；经接口录入后是该行，entered_by、entered_by_name（显示名）正确；只影响它自己的通道', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const before = await viewOf(await h.overview());
    for (const channel of before.channels) expect(channel.watermark).toBeNull();

    const cashier = await h.caller(['fund.cash_entry'], { displayName: '财务合成甲' });
    const body = watermarkBody(f, 3_000_001, 30);
    await answer(await h.enterWatermark(body, { caller: cashier }), 0);

    const view = await viewOf(await h.overview());
    expect(shown(channelOf(view, 'alipay').watermark)).toEqual({
      available_fen: 3_000_001,
      measured_at: f.clock.now().getTime() - 30 * MINUTE,
      entered_by: cashier.id,
      entered_by_name: '财务合成甲',
    });
    expect(channelOf(view, 'bank_card').watermark).toBeNull();
    expect(channelOf(view, 'wechat').watermark).toBeNull();
  });
});

it('[AC-B2-09l#68] watermark 的「最新」按 measured_at（同 adminCreatePayoutWatermark）：后写入但取数更早的行不算；没有显示名时 entered_by_name 用登录名；entered_by 不是管理员时两个字段都是 null；各通道各取各的', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const noName = await h.caller(['fund.cash_entry']);
    const latest = await seedW(f, { fen: 40_009n, ageMs: 10 * MINUTE, enteredBy: noName.id });
    await seedW(f, { fen: 1_009n, ageMs: 50 * MINUTE, enteredBy: h.cashier.id });
    const wechat = await seedW(f, { fen: 70_001n, ageMs: 20 * MINUTE, channel: 'wechat' });

    const view = await viewOf(await h.overview());

    expect(shown(channelOf(view, 'alipay').watermark)).toEqual({
      available_fen: 40_009,
      measured_at: latest,
      entered_by: noName.id,
      entered_by_name: noName.loginName,
    });
    expect(shown(channelOf(view, 'wechat').watermark)).toEqual(byNobody(70_001, wechat));
    expect(channelOf(view, 'bank_card').watermark).toBeNull();
  });
});

it('[AC-B2-09l#69] forecast_withdrawal_fen 按通道（BR-WDR-18 例）：alipay 近 7 日合计 ¥49,000 → P=2,100,000；wechat 合计 11 → 日均取 2 → P=6；bank_card 没有近期提现是 0 不是 null', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await seedHistory(f, h, who, FORECAST_SOURCE);
    await seedHistory(f, h, who, 11n, 'wechat');

    const view = await viewOf(await h.overview());

    expect(channelOf(view, 'alipay').forecast_withdrawal_fen).toBe(FORECAST);
    expect(channelOf(view, 'wechat').forecast_withdrawal_fen).toBe(6);
    expect(channelOf(view, 'bank_card').forecast_withdrawal_fen).toBe(0);
  });
});

it('[AC-B2-09l#70] water_level：P=¥21,000：W=¥31,500 是 normal（1.5P 本身不算低），W=¥31,499.99 是 low；没有 W 是 null；只看自己通道的 W', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    await seedHistory(f, h, await payee(f, h), FORECAST_SOURCE);
    await seedW(f, { fen: 90_000_000n, channel: 'wechat' });

    expect(channelOf(await viewOf(await h.overview()), 'alipay').water_level).toBeNull();

    await seedW(f, { fen: 3_150_000n, ageMs: 40 * MINUTE });
    expect(channelOf(await viewOf(await h.overview()), 'alipay').water_level).toBe('normal');

    await seedW(f, { fen: 3_149_999n, ageMs: 30 * MINUTE });
    expect(channelOf(await viewOf(await h.overview()), 'alipay').water_level).toBe('low');
  });
});

it('[AC-B2-09l#71] 过期：W 恰好 2 小时仍有值，多 1 毫秒 water_level 变 null，但 watermark.measured_at 还在，P 照常', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    await seedHistory(f, h, await payee(f, h), FORECAST_SOURCE);
    const measuredAt = await seedW(f, { fen: 3_150_000n, ageMs: 2 * HOUR });

    const fresh = channelOf(await viewOf(await h.overview()), 'alipay');
    expect(fresh.water_level).toBe('normal');
    expect(shown(fresh.watermark)).toEqual(byNobody(3_150_000, measuredAt));

    f.clock.advanceMs(1);
    const stale = channelOf(await viewOf(await h.overview()), 'alipay');
    expect(stale.water_level).toBeNull();
    expect(shown(stale.watermark)).toEqual(byNobody(3_150_000, measuredAt));
    expect(stale.forecast_withdrawal_fen).toBe(FORECAST);
  });
});

it('[AC-B2-09l#72] 和 fund-ledger 一致：没有 W、W 偏低、W 充足、W 过期四种状态下，alipay 的 watermark、forecast_withdrawal_fen、water_level 都和 GET /admin/v1/fund-ledger 相同', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    // A fresh account at each reading: the clock moves two hours below.
    const expectSame = async (level: string | null): Promise<void> => {
      const reader = await h.caller([VIEW]);
      const alipay = channelOf(await viewOf(await h.overview(reader)), 'alipay');
      const ledger = await ledgerOf(await h.fundLedger(reader));
      expect(alipay.water_level).toBe(level);
      expect(ledger.water_level).toBe(level);
      expect(alipay.forecast_withdrawal_fen).toBe(ledger.forecast_withdrawal_fen);
      expect(shown(alipay.watermark)).toEqual(shown(ledger.watermark));
    };

    await seedHistory(f, h, await payee(f, h), FORECAST_SOURCE);
    await expectSame(null);

    await seedW(f, { fen: 3_000_001n, ageMs: 30 * MINUTE });
    await expectSame('low');

    await seedW(f, { fen: 3_150_001n, ageMs: 20 * MINUTE });
    await expectSame('normal');

    f.clock.advanceMs(2 * HOUR);
    await expectSame(null);
  });
});

it('[AC-B2-09l#73] 和 EXECUTE 一致：同一份 W、P 下，W 比概览的 P 少 1 分被 EXECUTE 拒 below_forecast、恰好等于 P 可以执行；water_level 为 null（过期）时 EXECUTE 是 watermark_stale', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await seedHistory(f, h, who, FORECAST_SOURCE);
    const w = await approved(f, h, who);
    const forecast = channelOf(await viewOf(await h.overview()), 'alipay').forecast_withdrawal_fen;
    expect(forecast).toBe(FORECAST);

    await seedW(f, { fen: BigInt(forecast) - 1n, ageMs: 2 * HOUR + 1 });
    expect(channelOf(await viewOf(await h.overview()), 'alipay').water_level).toBeNull();
    await expectRejected(await h.execute([w.id]), 'watermark_stale', 'alipay');

    await seedW(f, { fen: BigInt(forecast) - 1n, ageMs: 20 * MINUTE });
    expect(channelOf(await viewOf(await h.overview()), 'alipay').water_level).toBe('low');
    await expectRejected(await h.execute([w.id]), 'watermark_below_forecast', 'alipay');

    await seedW(f, { fen: BigInt(forecast), ageMs: 10 * MINUTE });
    await expectExecuted(await h.execute([w.id]), { paying: [w.id] });
  });
});
