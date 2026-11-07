import { expect, it } from 'vitest';
import { priceSpecHintFor } from './spec-hint.ts';

it('[AC-B1-05zh] jd sku mode is the only null hint', () => {
  expect(priceSpecHintFor({ platform: 'jd', jdMode: 'sku' })).toBeNull();
});

it('[AC-B1-05zh] jd item or unset mode, and every other platform, say spec_uncertain', () => {
  expect(priceSpecHintFor({ platform: 'jd', jdMode: 'item' })).toBe('spec_uncertain');
  expect(priceSpecHintFor({ platform: 'jd' })).toBe('spec_uncertain');
  expect(priceSpecHintFor({ platform: 'taobao', jdMode: 'sku' })).toBe('spec_uncertain');
  expect(priceSpecHintFor({ platform: 'pdd' })).toBe('spec_uncertain');
  expect(priceSpecHintFor({ platform: 'JD', jdMode: 'sku' })).toBe('spec_uncertain');
});

it('[AC-B1-04zzn] pdd with a union-detail price is price_from; any other pdd price stays spec_uncertain', () => {
  expect(priceSpecHintFor({ platform: 'pdd', fromUnionDetail: true })).toBe('price_from');
  expect(priceSpecHintFor({ platform: 'pdd', jdMode: 'sku', fromUnionDetail: true })).toBe(
    'price_from',
  );
  expect(priceSpecHintFor({ platform: 'pdd', fromUnionDetail: false })).toBe('spec_uncertain');
  expect(priceSpecHintFor({ platform: 'pdd' })).toBe('spec_uncertain');
  // Strict: neither a near-miss platform code nor a truthy non-boolean counts.
  expect(priceSpecHintFor({ platform: 'PDD', fromUnionDetail: true })).toBe('spec_uncertain');
  expect(priceSpecHintFor({ platform: ' pdd', fromUnionDetail: true })).toBe('spec_uncertain');
  const truthy = { platform: 'pdd', fromUnionDetail: 'true' } as unknown as Parameters<
    typeof priceSpecHintFor
  >[0];
  expect(priceSpecHintFor(truthy)).toBe('spec_uncertain');
});

it('[AC-B1-04zzn] fromUnionDetail changes nothing for taobao or jd', () => {
  for (const fromUnionDetail of [true, false, undefined]) {
    const extra = fromUnionDetail === undefined ? {} : { fromUnionDetail };
    expect(priceSpecHintFor({ platform: 'taobao', ...extra })).toBe('spec_uncertain');
    expect(priceSpecHintFor({ platform: 'jd', jdMode: 'item', ...extra })).toBe('spec_uncertain');
    expect(priceSpecHintFor({ platform: 'jd', ...extra })).toBe('spec_uncertain');
    expect(priceSpecHintFor({ platform: 'jd', jdMode: 'sku', ...extra })).toBeNull();
  }
});
