import { expect, it } from 'vitest';
import { deliveredSection, deliveredSections } from './delivered-sections.ts';

it('[CT-07e] product_pool 数据源去掉 tags，原对象不变；别的数据源与非对象原样返回', () => {
  const pool = {
    id: 'p',
    type: 'product_grid',
    data_source: { kind: 'product_pool', pool_id: 'x', limit: 2, tags: ['新品'] },
  };
  const material = { id: 'm', type: 'product_grid', data_source: { kind: 'static', tags: ['a'] } };
  const plain = { id: 'q', type: 'product_grid', data_source: { kind: 'product_pool' } };

  expect(deliveredSection(pool)).toEqual({
    id: 'p',
    type: 'product_grid',
    data_source: { kind: 'product_pool', pool_id: 'x', limit: 2 },
  });
  expect(pool.data_source.tags).toEqual(['新品']);
  expect(deliveredSection(material)).toBe(material);
  expect(deliveredSection(plain)).toBe(plain);
  expect(deliveredSections([null, 'x', plain])).toEqual([null, 'x', plain]);
});
