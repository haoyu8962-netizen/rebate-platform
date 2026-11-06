// B1-03zg (money r1 S1): a disabled BLACKLIST_HIT takes no part in the order pipeline's blacklist
// step (BR-ID-36 细则「规则清单的启停」; BR-ATTR-26 命中后的处理). The rule is toggled through the
// admin console of the order's app; orders go through the real pipeline with risk's real order
// blocklist ports (orders/blacklist/kit.ts: the settlement port rebate.onBlacklistHit is a fake that
// records its calls). After each toggle the pipeline's injected clock (the ports' Clock) moves past
// REFRESH_MS (the config_items cache period), no real waiting (see effects-kit.ts).
// - disabled: an order matching an active blocklist entry gets no BLACKLIST_HIT hit, is not voided
//   through the rebate port (void_commission) and gets no manual_review hit; enabled again: both
//   come back;
// - hits and appeals of orders judged before the disable stay as they were;
// - one app's disable leaves another app's rule of the same code deciding.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  hitView,
  seedChannel,
  seedSuffix,
  setup,
  type Fixture,
} from '../../orders/blacklist/kit.ts';
import { CHANNEL, PARENT_HIT, SUFFIX } from '../../orders/blacklist/plan-kit.ts';
import {
  BLACKLIST_RULE,
  REFRESH_MS,
  appealOrder,
  appealsOf,
  consoleOf,
  hitsOf,
  registerRule,
  ruleRowOf,
} from './effects-kit.ts';

const h = useHarness();
const BLACKLIST_SEED = {
  rule_id: BLACKLIST_RULE,
  scene: 'order',
  risk_action: 'void_commission',
} as const;

type Dimension = 'channel' | 'order_no_suffix';
interface Case {
  readonly label: string;
  readonly dimension: Dimension;
  readonly value: string;
  readonly action: 'void_commission' | 'manual_review';
  readonly voids: boolean;
}
const CASES: readonly Case[] = [
  {
    label: '渠道名单：void_commission，经返利端口作废',
    dimension: 'channel',
    value: CHANNEL,
    action: 'void_commission',
    voids: true,
  },
  {
    label: '淘宝尾号名单、尾号维度未启用：只记 manual_review',
    dimension: 'order_no_suffix',
    value: SUFFIX,
    action: 'manual_review',
    voids: false,
  },
];

/** An order fixture whose orders match one active blocklist entry; the rule row as seeded. */
async function blacklisted(dimension: Dimension) {
  const f =
    dimension === 'channel'
      ? await setup(h.db)
      : await setup(h.db, { parent_order_id: PARENT_HIT }, { suffixOn: false });
  if (dimension === 'channel') await seedChannel(h.db, f);
  else await seedSuffix(h.db, f);
  const rule = await registerRule(h, f.ctx.app_id, BLACKLIST_SEED);
  return { f, rule };
}

/** Imports one more order of the fixture's app (same buyer parameters, so the same match). */
async function importOrder(f: Fixture): Promise<string> {
  const incoming = { ...f.incoming, order_id: randomUUID(), sub_order_id: randomUUID() };
  expect(await f.run(incoming)).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  const row = (await f.read()).orders.find((o) => o.sub_order_id === incoming.sub_order_id);
  expect(row, 'the order is imported').toBeDefined();
  return String(row?.order_id);
}

/** The orders handed to settlement's BLACKLIST_HIT (R6), in call order. */
const voided = (f: Fixture) => f.onBlacklistHit.mock.calls.map(([, hit]) => hit.order_id);

function expectedHit(f: Fixture, c: Case, orderId: string) {
  return {
    user_id: f.userId,
    rule_id: BLACKLIST_RULE,
    risk_action: c.action,
    dimension: c.dimension,
    value_hmac: f.hmac(c.dimension, c.value),
    ref_type: 'order',
    ref_id: orderId,
  };
}

it.each(CASES)(
  '[AC-B1-03zg#44] 停用 BLACKLIST_HIT 后命中黑名单的订单不记该规则命中、不因该规则进入 manual_review / void_commission；重新启用后恢复：$label',
  async (c) => {
    const { f } = await blacklisted(c.dimension);
    const app = f.ctx.app_id;
    const admin = await consoleOf(h, app);

    // Enabled: the blacklist step records the hit and disposes of the order.
    const first = await importOrder(f);
    const before = await hitsOf(h, app, BLACKLIST_RULE);
    expect(before.map(hitView)).toEqual([expectedHit(f, c, first)]);
    expect(voided(f)).toEqual(c.voids ? [first] : []);

    // Disabled: the order matching the same entry is left alone by the rule.
    await admin.toggle('disable', BLACKLIST_RULE);
    f.clock.advanceMs(REFRESH_MS);
    const second = await importOrder(f);
    const during = await hitsOf(h, app, BLACKLIST_RULE);
    expect(
      during.map((hit) => hit.ref_id),
      'no BLACKLIST_HIT hit for an order judged while the rule is disabled',
    ).not.toContain(second);
    expect(during).toEqual(before);
    expect(voided(f), 'no void through the rebate port while disabled').toEqual(
      c.voids ? [first] : [],
    );

    // Enabled again: hit and disposition as before.
    await admin.toggle('enable', BLACKLIST_RULE);
    f.clock.advanceMs(REFRESH_MS);
    const third = await importOrder(f);
    expect((await hitsOf(h, app, BLACKLIST_RULE)).map(hitView)).toEqual([
      expectedHit(f, c, first),
      expectedHit(f, c, third),
    ]);
    expect(voided(f)).toEqual(c.voids ? [first, third] : []);
  },
  120_000,
);

it('[AC-B1-03zg#45] 停用前订单的 BLACKLIST_HIT 命中与订单申诉不受停用影响；停用不追溯已完成的判定', async () => {
  const { f } = await blacklisted('channel');
  const app = f.ctx.app_id;
  const admin = await consoleOf(h, app);

  const first = await importOrder(f);
  const [hit] = await hitsOf(h, app, BLACKLIST_RULE);
  expect(hit, 'the order judged before the disable is recorded').toBeDefined();
  await appealOrder(h, { appId: app, userId: f.userId, orderId: first, now: f.clock.now() });
  const hitsBefore = await hitsOf(h, app);
  const appealsBefore = await appealsOf(h, app);
  expect(appealsBefore).toHaveLength(1);

  await admin.toggle('disable', BLACKLIST_RULE);
  f.clock.advanceMs(REFRESH_MS);
  const second = await importOrder(f);

  // The disable judged the new order without the rule and left the earlier decision as it was.
  expect(await hitsOf(h, app, BLACKLIST_RULE)).toEqual([hit]);
  expect(voided(f)).toEqual([first]);
  expect(voided(f)).not.toContain(second);
  expect(await hitsOf(h, app)).toEqual(expect.arrayContaining(hitsBefore));
  expect(await appealsOf(h, app)).toEqual(appealsBefore);
}, 120_000);

it('[AC-B1-03zg#46] 跨 app：A 停用 BLACKLIST_HIT 不影响 B 同名规则的订单判定', async () => {
  const a = await blacklisted('channel');
  const b = await blacklisted('channel');
  const adminA = await consoleOf(h, a.f.ctx.app_id);

  await adminA.toggle('disable', BLACKLIST_RULE);
  a.f.clock.advanceMs(REFRESH_MS);
  b.f.clock.advanceMs(REFRESH_MS);

  await importOrder(a.f);
  expect(await hitsOf(h, a.f.ctx.app_id, BLACKLIST_RULE)).toEqual([]);
  expect(voided(a.f)).toEqual([]);

  const orderB = await importOrder(b.f);
  expect((await hitsOf(h, b.f.ctx.app_id, BLACKLIST_RULE)).map(hitView)).toEqual([
    expectedHit(b.f, CASES[0]!, orderB),
  ]);
  expect(voided(b.f)).toEqual([orderB]);
  expect(await ruleRowOf(h, b.f.ctx.app_id, BLACKLIST_RULE)).toEqual(b.rule);
}, 120_000);
