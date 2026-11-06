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
