import { expect, it } from 'vitest';
import { normalizePoolSourceTags, type PoolSourceTagsNormalizer } from './pool-source-tags.ts';

// CT-07g (D10-2034): content keeps no normalization of its own; these tests pin what it does with
// the injected one (app.module hands catalog's). The table of results is pinned by
// test/spec/catalog/pool-tags-normalize-single/**.

function pool(tags?: unknown) {
  return {
    id: 's',
    type: 'product_grid',
    data_source: {
      kind: 'product_pool',
      pool_id: 'p',
      limit: 5,
      ...(tags === undefined ? {} : { tags }),
    },
  };
}

function recording(answer: PoolSourceTagsNormalizer) {
  const calls: string[][] = [];
  const normalize: PoolSourceTagsNormalizer = (input) => {
    calls.push([...input]);
    return answer(input);
  };
  return { calls, normalize };
}

const mark: PoolSourceTagsNormalizer = (input) => input.map((tag) => `n:${tag}`);

it('[CT-07g][D10-2034] 只有 product_pool 的字符串 tags（含 []）交给注入函数，结果原样存；其余区块与输入原样', () => {
  const spy = recording((input) => (input.length === 0 ? ['x'] : mark(input)));
  const material = { data_source: { kind: 'static', tags: [' a '] } };
  const input = [pool([' a ', 'a']), pool(), material, pool([1]), 'x', pool([])];
  const frozen = structuredClone(input);
  expect(normalizePoolSourceTags(input, spy.normalize)).toEqual({
    ok: true,
    sections: [pool(['n: a ', 'n:a']), pool(), material, pool([1]), 'x', pool(['x'])],
  });
  expect(spy.calls).toEqual([[' a ', 'a'], []]);
  expect(input).toEqual(frozen);
});

it('[CT-07g][D10-2034] 注入函数答 null 或 [] → 拒，fields 依区块顺序为各数据源的 tags', () => {
  const spy = recording((input) =>
    input[0] === 'null' ? null : input[0] === 'empty' ? [] : input,
  );
  expect(
    normalizePoolSourceTags(
      [pool(['a']), pool(['null']), pool(), pool(['empty']), pool([1])],
      spy.normalize,
    ),
  ).toEqual({
    ok: false,
    fields: ['sections.1.data_source.tags', 'sections.3.data_source.tags'],
  });
  expect(spy.calls).toEqual([['a'], ['null'], ['empty']]);
});

it('[CT-07g][D10-2034] sections 不是数组：原样返回，不调注入函数', () => {
  const spy = recording(mark);
  expect(normalizePoolSourceTags({ not: 'array' }, spy.normalize)).toEqual({
    ok: true,
    sections: { not: 'array' },
  });
  expect(normalizePoolSourceTags(null, spy.normalize)).toEqual({ ok: true, sections: null });
  expect(spy.calls).toEqual([]);
});
