import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { DAY, fields, ok, setup, unionAccount, type Created, type Limits } from './kit.ts';

const h = useHarness();
// 02 §7.1 table: the farthest look-back of each platform; 01 F-ORD-10: at most 50 order numbers.
const LOOK_BACK_DAYS: Record<string, number> = { taobao: 90, jd: 30, pdd: 90 };
/** The most one request may carry (01 F-ORD-10). */
const FIFTY_NUMBERS = Array.from(
  { length: 50 },
  (_, n) => `231006-12345678${String(n).padStart(2, '0')}`,
);

it('[AC-B1-09i#30] limits 每个可同步平台一项：earliest_from 为注入时钟减最远回扫范围，max_order_nos pdd 50、jd 0；读不写审计', async () => {
  const s = await setup(h);
  const audits = await s.audits();
  const limits = await ok<Limits>(await s.limits(), 'limits');
  const platforms = limits.items.map((item) => item.platform);
  expect(platforms).toContain('pdd');
  expect(new Set(platforms).size).toBe(platforms.length);
  // The fixture clock is fixed days before the wall clock: a wall-clock bound falls outside.
  const now = s.f.clock.now().getTime();
  for (const item of limits.items) {
    expect(Object.keys(LOOK_BACK_DAYS)).toContain(item.platform);
    expect(item.max_order_nos).toBe(item.platform === 'pdd' ? 50 : 0);
    const range = LOOK_BACK_DAYS[item.platform]! * DAY;
    const earliest = Date.parse(item.earliest_from);
    expect(earliest).toBeLessThanOrEqual(now - range);
    expect(earliest).toBeGreaterThan(now - range - DAY);
  }
  expect(await s.audits()).toEqual(audits);
});

it('[AC-B1-04zu#2] limits 给 jd 报 0、pdd 报 50，POST 校验不变：jd 按单号仍 20001 [order_nos] 不建请求不投递，pdd 按 50 个单号照常建请求', async () => {
  const s = await setup(h);
  await unionAccount(s, 'jd');
  await unionAccount(s, 'pdd');
  const limits = await ok<Limits>(await s.limits(), 'limits');
  const maxOf = (platform: string) =>
    limits.items.find((item) => item.platform === platform)?.max_order_nos;
  expect(maxOf('jd')).toBe(0);
  expect(maxOf('pdd')).toBe(50);

  await fields(await s.post({ platform: 'jd', order_nos: FIFTY_NUMBERS }), 'create', ['order_nos']);
  expect(await s.rows()).toEqual([]);
  expect(s.jobs()).toEqual([]);

  const created = await ok<Created>(
    await s.post({ platform: 'pdd', order_nos: FIFTY_NUMBERS }),
    'create',
  );
  expect(created).toMatchObject({ status: 'queued', reused: false });
  const rows = await s.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: created.sync_id,
    platform: 'pdd',
    mode: 'order_nos',
    order_nos: FIFTY_NUMBERS,
  });
  expect(s.jobs().length).toBeGreaterThan(0);
});
