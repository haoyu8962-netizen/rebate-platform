import { expect, it } from 'vitest';
import {
  emptiedPoolSourceTagFields,
  normalizePoolSourceTags,
  normalizeSourceTags,
} from './pool-source-tags.ts';

const pool = (tags?: unknown) => ({
  id: 's',
  type: 'product_grid',
  data_source: {
    kind: 'product_pool',
    pool_id: 'p',
    limit: 5,
    ...(tags === undefined ? {} : { tags }),
  },
});

it('[CT-07f][D10-1777] 规范化：NFKC、去首尾空白、内部空白并一、丢空串、去重保序、大小写不折叠', () => {
  expect(normalizeSourceTags([' 新品 ', '新品', 'ＡＢ', 'ab', 'AB', '618　 大促', ' '])).toEqual([
    '新品',
    'AB',
    'ab',
    '618 大促',
  ]);
});

it('[CT-07f][D10-1777] 只改 product_pool 的字符串 tags，其余区块与输入原样', () => {
  const material = { data_source: { kind: 'static', tags: [' a '] } };
  const input = [pool([' a ', 'a']), pool(), material, pool([1]), 'x'];
  const frozen = structuredClone(input);
  expect(normalizePoolSourceTags(input)).toEqual([pool(['a']), pool(), material, pool([1]), 'x']);
  expect(input).toEqual(frozen);
  expect(normalizePoolSourceTags({ not: 'array' })).toEqual({ not: 'array' });
});

it('[CT-07f][D10-1986] 规范化后为空（[] 或全是空白）才报该数据源的 tags；缺省、非字符串数组不报', () => {
  expect(
    emptiedPoolSourceTagFields([pool(['a']), pool([' ', '　']), pool([]), pool(), pool([1])]),
  ).toEqual(['sections.1.data_source.tags', 'sections.2.data_source.tags']);
  expect(emptiedPoolSourceTagFields(null)).toEqual([]);
});
