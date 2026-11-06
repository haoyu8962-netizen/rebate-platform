import { expect, it } from 'vitest';
import { SHOP_NAME_MAX_CODE_POINTS, shopNameField } from './types.ts';

// Local unit-test identifiers (B1-04zzj, D10-692 S2-7); synthetic shop names.

it('[B1-04zzj unit] Cc / Cf characters are removed before trim; nothing left → no shop_name', () => {
  expect(shopNameField('\u200B 合成\u0000店\uFEFF ')).toEqual({ shop_name: '合成店' });
  expect(shopNameField('\u200E\u202E\u0085')).toEqual({});
  expect(shopNameField(42)).toEqual({});
});

it('[B1-04zzj unit] cut to 64 code points without splitting a surrogate pair', () => {
  const head = 'x'.repeat(SHOP_NAME_MAX_CODE_POINTS - 1);
  const field = shopNameField(`${head}\u{1F600}\u{1F600}`);
  expect(field).toEqual({ shop_name: `${head}\u{1F600}` });
  expect([...(field.shop_name ?? '')]).toHaveLength(SHOP_NAME_MAX_CODE_POINTS);
  const exact = '\u{1F600}'.repeat(SHOP_NAME_MAX_CODE_POINTS);
  expect(shopNameField(exact)).toEqual({ shop_name: exact });
});
