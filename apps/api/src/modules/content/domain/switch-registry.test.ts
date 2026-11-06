import { expect, it } from 'vitest';
import { switchRegistry, switchSpecOf } from './switch-registry.ts';

const DETAIL_OFF = [
  ['shop.entry.enabled.<platform>', 'shop.entry.enabled'],
  ['detail.sales.enabled.<platform>', 'detail.sales.enabled'],
  ['detail.shop_scores.enabled.<platform>', 'detail.shop_scores.enabled'],
  ['detail.coupon_end.enabled.<platform>', 'detail.coupon_end.enabled'],
] as const;

it.each(DETAIL_OFF)(
  '[AC-B1-05zj-unit#1] %s：淘宝、京东、拼多多默认 off，布尔、只认 switch.all、可改、非系统写',
  (pattern, prefix) => {
    for (const platform of ['taobao', 'jd', 'pdd']) {
      const spec = switchSpecOf(`${prefix}.${platform}`);
      expect(spec?.pattern).toBe(pattern);
      expect(spec?.valueType).toStrictEqual({ kind: 'boolean' });
      expect(spec?.defaultValue).toBe(false);
      expect({ ...spec?.defaultOverrides }).toStrictEqual({});
      expect([...(spec?.permissions ?? [])]).toStrictEqual(['switch.all']);
      expect(spec?.adminEditable).toBe(true);
      expect(spec?.systemWritten).toBe(false);
    }
  },
);

it('[AC-B1-05zj-unit#2] detail.jd_plus_note.enabled：默认 on，布尔、只认 switch.all、可改、非系统写', () => {
  expect(switchSpecOf('detail.jd_plus_note.enabled')).toStrictEqual({
    pattern: 'detail.jd_plus_note.enabled',
    valueType: { kind: 'boolean' },
    defaultValue: true,
    defaultOverrides: {},
    permissions: ['switch.all'],
    adminEditable: true,
    systemWritten: false,
  });
  expect(switchSpecOf('detail.jd_plus_note.enabled.jd')).toBeNull();
});

it('[AC-B1-05zj-unit#3] 五项各登记一次，都排在 growth.invite_reward 两项之前，那两项仍在最后', () => {
  const patterns = switchRegistry().map((spec) => spec.pattern);
  const added = [...DETAIL_OFF.map(([pattern]) => pattern), 'detail.jd_plus_note.enabled'];
  const invite = patterns.indexOf('growth.invite_reward.enabled');
  for (const pattern of added) {
    expect(patterns.filter((p) => p === pattern)).toHaveLength(1);
    expect(patterns.indexOf(pattern)).toBeLessThan(invite);
  }
  expect(patterns.slice(-2)).toStrictEqual([
    'growth.invite_reward.enabled',
    'growth.invite_reward.payout_paused',
  ]);
});
