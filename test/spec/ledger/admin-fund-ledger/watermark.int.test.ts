// B2-04zs rule tests, 水位 (claude-independent, SPEC_REF 6f50a051): 08 BR-WDR-18; contracts/openapi.yaml
// adminGetFundLedger; 编排裁定 D10-589 — watermark is the latest W of the enterprise Alipay channel by
// measured_at, null until a row exists; forecast_withdrawal_fen is P of the same channel over the 7
// complete natural days before today (+08:00), REJECTED excluded, round_half_up(total / 7) × 3 of
// amount_fen, 0 with no recent withdrawals; water_level is low when W < 1.5P (exact integers:
// W × 10 < P × 15), else normal; null when there is no W or W is older than 2 hours (exactly 2 hours
// is not stale), while watermark and P are still shown. No default anywhere. Expected values are
// computed by hand in the tests. W rows and withdrawals are seeded by INSERT (kit.ts); requests go
// through the real admin entry. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  HOUR,
  MINUTE,
  byNobody,
  fixture,
  levelOf,
  overview,
  seedForecastOf2100000,
  seedWatermark,
  seedWithdrawal,
  suite,
  watermarkOf,
  withFundAdmin,
} from './kit.ts';

const s = suite();

/** In the 7-day window of the fixture's default clock. */
const IN_WINDOW = '2026-10-25T04:00:00.000Z';

it('[AC-B2-04zs#18] 没有 W、有近期提现：watermark 和 water_level 为 null，P 照常算（2,100,000），不给默认值', async () => {
  const f = fixture(s);
  await seedForecastOf2100000(f);
  await withFundAdmin(f, async (h) => {
    const view = await overview(await h.read());
    expect(view.watermark).toBeNull();
    expect(view.forecast_withdrawal_fen).toBe(2_100_000);
    expect(view.water_level).toBeNull();
  });
});

it('[AC-B2-04zs#19] 近期没有提现：P 是 0 不是 null；W=0、P=0 时 W 是数据不是空：available_fen 0、water_level normal（0 不小于 0）', async () => {
  const f = fixture(s);
  await withFundAdmin(f, async (h) => {
    const noRows = await overview(await h.read());
    expect(levelOf(noRows)).toEqual({
      available_fen: null,
      forecast_withdrawal_fen: 0,
      water_level: null,
    });

    await seedWatermark(f, { fen: 0n });
    expect(levelOf(await overview(await h.read()))).toEqual({
      available_fen: 0,
      forecast_withdrawal_fen: 0,
      water_level: 'normal',
    });
  });
});

it('[AC-B2-04zs#20] P 与 BR-WDR-18 同口径：窗口是近 7 个完整自然日（+08:00，含 10-22 00:00、不含 10-29 00:00），各状态都算但不含 REJECTED，按 amount_fen 不按 net_fen：合计 4,900,000 → 日均 700,000 → P=2,100,000', async () => {
  const f = fixture(s);
  // In the window: 1,000,000 + 700,000 + 700,000 + 2,500,000 = 4,900,000.
  await seedWithdrawal(f, {
    amountFen: 1_000_000n,
    createdAt: '2026-10-21T16:00:00.000Z',
    status: 'PAID_API',
  });
  await seedWithdrawal(f, {
    amountFen: 700_000n,
    createdAt: '2026-10-28T15:59:59.999Z',
    status: 'PENDING_REVIEW',
  });
  await seedWithdrawal(f, { amountFen: 700_000n, createdAt: IN_WINDOW, status: 'PAYING' });
  await seedWithdrawal(f, {
    amountFen: 2_500_000n,
    feeFen: 500_000n,
    createdAt: IN_WINDOW,
    status: 'FAILED',
  });
  // Not counted: one millisecond before the window, today, REJECTED.
  await seedWithdrawal(f, { amountFen: 7_000_000n, createdAt: '2026-10-21T15:59:59.999Z' });
  await seedWithdrawal(f, { amountFen: 7_000_000n, createdAt: '2026-10-28T16:00:00.000Z' });
  await seedWithdrawal(f, { amountFen: 7_000_000n, createdAt: IN_WINDOW, status: 'REJECTED' });
  await withFundAdmin(f, async (h) => {
    expect((await overview(await h.read())).forecast_withdrawal_fen).toBe(2_100_000);
  });
});

it('[AC-B2-04zs#21] P 先四舍五入日均再乘 3：合计 11 → 日均 11/7 取 2 → P=6（不是 3，也不是 5）', async () => {
  const f = fixture(s);
  await seedWithdrawal(f, { amountFen: 11n, createdAt: IN_WINDOW });
  await withFundAdmin(f, async (h) => {
    expect((await overview(await h.read())).forecast_withdrawal_fen).toBe(6);
  });
});

it('[AC-B2-04zs#22] BR-WDR-18 的例子：W=3,000,000 < 1.5P=3,150,000 → low，watermark 与 P 都照常给（entered_by 非管理员时两个字段都是 null）', async () => {
  const f = fixture(s);
  await seedForecastOf2100000(f);
  const measuredAt = await seedWatermark(f, { fen: 3_000_000n });
  await withFundAdmin(f, async (h) => {
    const view = await overview(await h.read());
    expect(watermarkOf(view)).toEqual(byNobody(3_000_000, measuredAt));
    expect(view.forecast_withdrawal_fen).toBe(2_100_000);
    expect(view.water_level).toBe('low');
  });
});

it('[AC-B2-04zs#23] 边界：W × 10 恰好等于 P × 15（W=3,150,000、P=2,100,000）是 normal，少 1 分是 low，多 1 分是 normal；W=P 也是 low', async () => {
  const f = fixture(s);
  await seedForecastOf2100000(f);
  await withFundAdmin(f, async (h) => {
    await seedWatermark(f, { fen: 3_150_000n, ageMs: 40 * MINUTE });
    expect(levelOf(await overview(await h.read()))).toEqual({
      available_fen: 3_150_000,
      forecast_withdrawal_fen: 2_100_000,
      water_level: 'normal',
    });
    await seedWatermark(f, { fen: 3_149_999n, ageMs: 30 * MINUTE });
    expect((await overview(await h.read())).water_level).toBe('low');
    await seedWatermark(f, { fen: 3_150_001n, ageMs: 20 * MINUTE });
    expect((await overview(await h.read())).water_level).toBe('normal');
    await seedWatermark(f, { fen: 2_100_000n, ageMs: 10 * MINUTE });
    expect((await overview(await h.read())).water_level).toBe('low');
  });
});

it('[AC-B2-04zs#24] 1.5P 不是整数时不能取整比较：P=3（合计 7），1.5P=4.5：W=4 是 low，W=5 是 normal', async () => {
  const f = fixture(s);
  await seedWithdrawal(f, { amountFen: 7n, createdAt: IN_WINDOW });
  await withFundAdmin(f, async (h) => {
    await seedWatermark(f, { fen: 4n, ageMs: 30 * MINUTE });
    expect(levelOf(await overview(await h.read()))).toEqual({
      available_fen: 4,
      forecast_withdrawal_fen: 3,
      water_level: 'low',
    });
    await seedWatermark(f, { fen: 5n, ageMs: 10 * MINUTE });
    expect((await overview(await h.read())).water_level).toBe('normal');
  });
});

it('[AC-B2-04zs#25] 比较不能用浮点：P=6,000,000,000,000,027（合计 14,000,000,000,000,063），W × 10 = 90,000,000,000,000,400 < P × 15 = 90,000,000,000,000,405 → low（双精度下两边相等），W 多 1 分 → normal', async () => {
  const f = fixture(s);
  await seedWithdrawal(f, { amountFen: 7_000_000_000_000_000n, createdAt: IN_WINDOW });
  await seedWithdrawal(f, { amountFen: 7_000_000_000_000_063n, createdAt: IN_WINDOW });
  await withFundAdmin(f, async (h) => {
    await seedWatermark(f, { fen: 9_000_000_000_000_040n, ageMs: 30 * MINUTE });
    expect(levelOf(await overview(await h.read()))).toEqual({
      available_fen: 9_000_000_000_000_040,
      forecast_withdrawal_fen: 6_000_000_000_000_027,
      water_level: 'low',
    });
    await seedWatermark(f, { fen: 9_000_000_000_000_041n, ageMs: 10 * MINUTE });
    expect((await overview(await h.read())).water_level).toBe('normal');
  });
});

it('[AC-B2-04zs#26] 过期：恰好 2 小时不算过期，多 1 毫秒算：W 偏低时 low 变 null、W 充足时 normal 变 null；watermark（含 measured_at）和 P 都照常返回', async () => {
  for (const [fen, level] of [
    [1_000, 'low'],
    [5_000_000, 'normal'],
  ] as const) {
    const f = fixture(s);
    await seedForecastOf2100000(f);
    const measuredAt = await seedWatermark(f, { fen: BigInt(fen), ageMs: 2 * HOUR });
    await withFundAdmin(f, async (h) => {
      const fresh = await overview(await h.read());
      expect(watermarkOf(fresh)).toEqual(byNobody(fen, measuredAt));
      expect(fresh.forecast_withdrawal_fen).toBe(2_100_000);
      expect(fresh.water_level).toBe(level);

      f.clock.advanceMs(1);
      const stale = await overview(await h.read());
      expect(watermarkOf(stale)).toEqual(byNobody(fen, measuredAt));
      expect(stale.forecast_withdrawal_fen).toBe(2_100_000);
      expect(stale.water_level).toBeNull();
    });
  }
});

it('[AC-B2-04zs#27] 最新 W 按 measured_at 取，不按写入先后：后写入但取数更早的行不算；最新一行过期时不回退到别的行', async () => {
  const f = fixture(s);
  await seedForecastOf2100000(f);
  const latest = await seedWatermark(f, { fen: 3_150_000n, ageMs: 30 * MINUTE });
  await seedWatermark(f, { fen: 1_000n, ageMs: 90 * MINUTE });
  await withFundAdmin(f, async (h) => {
    const view = await overview(await h.read());
    expect(watermarkOf(view)).toEqual(byNobody(3_150_000, latest));
    expect(view.water_level).toBe('normal');

    f.clock.advanceMs(HOUR + 31 * MINUTE);
    const stale = await overview(await h.read());
    expect(watermarkOf(stale)).toEqual(byNobody(3_150_000, latest));
    expect(stale.water_level).toBeNull();
  });
});

it('[AC-B2-04zs#28] 只看企业支付宝通道：bank_card、wechat 的 W（更新、更大）和提现都不计入', async () => {
  const f = fixture(s);
  await seedForecastOf2100000(f);
  const measuredAt = await seedWatermark(f, { fen: 3_000_000n, ageMs: 30 * MINUTE });
  await seedWatermark(f, { fen: 90_000_000n, ageMs: MINUTE, channel: 'bank_card' });
  await seedWatermark(f, { fen: 80_000_000n, ageMs: MINUTE, channel: 'wechat' });
  await seedWithdrawal(f, { amountFen: 7_000_000n, createdAt: IN_WINDOW, channel: 'bank_card' });
  await seedWithdrawal(f, { amountFen: 7_000_000n, createdAt: IN_WINDOW, channel: 'wechat' });
  await withFundAdmin(f, async (h) => {
    const view = await overview(await h.read());
    expect(watermarkOf(view)).toEqual(byNobody(3_000_000, measuredAt));
    expect(view.forecast_withdrawal_fen).toBe(2_100_000);
    expect(view.water_level).toBe('low');
  });
});

it('[AC-B2-04zs#29] 只有别的通道有 W 和提现：watermark=null、water_level=null，P=0；支付宝 W 过期时别的通道的新鲜 W 也救不回结论', async () => {
  const f = fixture(s);
  await seedWatermark(f, { fen: 90_000_000n, channel: 'bank_card' });
  await seedWithdrawal(f, { amountFen: 7_000_000n, createdAt: IN_WINDOW, channel: 'bank_card' });
  await withFundAdmin(f, async (h) => {
    const view = await overview(await h.read());
    expect(view.watermark).toBeNull();
    expect(view.forecast_withdrawal_fen).toBe(0);
    expect(view.water_level).toBeNull();

    const measuredAt = await seedWatermark(f, { fen: 5_000n, ageMs: 3 * HOUR });
    const stale = await overview(await h.read());
    expect(watermarkOf(stale)).toEqual(byNobody(5_000, measuredAt));
    expect(stale.water_level).toBeNull();
  });
});

it('[AC-B2-04zs#37] P 也算 PAID_MANUAL：窗口内 PAID_API 4,900,000 + PAID_MANUAL 2,100,000 = 7,000,000 → P=3,000,000；W=4,000,000 新鲜时 low（40,000,000 < 45,000,000），漏掉 PAID_MANUAL 会得到 P=2,100,000、normal', async () => {
  const f = fixture(s);
  await seedWithdrawal(f, { amountFen: 4_900_000n, createdAt: IN_WINDOW, status: 'PAID_API' });
  await seedWithdrawal(f, { amountFen: 2_100_000n, createdAt: IN_WINDOW, status: 'PAID_MANUAL' });
  await seedWatermark(f, { fen: 4_000_000n });
  await withFundAdmin(f, async (h) => {
    expect(levelOf(await overview(await h.read()))).toEqual({
      available_fen: 4_000_000,
      forecast_withdrawal_fen: 3_000_000,
      water_level: 'low',
    });
  });
});

it('[AC-B2-04zs#38] P 的窗口按申请时间 created_at：10-20 申请、窗口内才打款（updated_at 在窗口内）的 7,000,000 不算，只算窗口内申请的 4,900,000 → P=2,100,000（按 updated_at 会得到 5,100,000）', async () => {
  const f = fixture(s);
  await seedWithdrawal(f, { amountFen: 4_900_000n, createdAt: IN_WINDOW });
  await seedWithdrawal(f, {
    amountFen: 7_000_000n,
    createdAt: '2026-10-20T04:00:00.000Z',
    updatedAt: IN_WINDOW,
    status: 'PAID_API',
  });
  await withFundAdmin(f, async (h) => {
    expect((await overview(await h.read())).forecast_withdrawal_fen).toBe(2_100_000);
  });
});

it('[AC-B2-04zs#39] P 的窗口按申请时间 created_at：窗口内申请、今天才打款（updated_at 在窗口外）的 4,900,000 要算 → P=2,100,000（按 updated_at 会得到 0）', async () => {
  const f = fixture(s);
  await seedWithdrawal(f, {
    amountFen: 4_900_000n,
    createdAt: IN_WINDOW,
    updatedAt: '2026-10-29T02:00:00.000Z',
    status: 'PAID_API',
  });
  await withFundAdmin(f, async (h) => {
    expect((await overview(await h.read())).forecast_withdrawal_fen).toBe(2_100_000);
  });
});

it('[AC-B2-04zs#40] 日均四舍五入、不向上取整：合计 8 → 8/7 取 1 → P=3；W=5 时 normal（50 ≥ 45），向上取整会得到 P=6、low', async () => {
  const f = fixture(s);
  await seedWithdrawal(f, { amountFen: 8n, createdAt: IN_WINDOW });
  await seedWatermark(f, { fen: 5n });
  await withFundAdmin(f, async (h) => {
    expect(levelOf(await overview(await h.read()))).toEqual({
      available_fen: 5,
      forecast_withdrawal_fen: 3,
      water_level: 'normal',
    });
  });
});
