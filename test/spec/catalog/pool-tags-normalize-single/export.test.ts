// CT-07g (FU-POOL-TAGS-NORMALIZE-SINGLE, D10-2034) (a): the normalization of pool tags is taken from
// catalog's only public surface, catalog/index.ts, and gives the CT-07e / CT-07f table row by row:
// NFKC → trim → inner whitespace runs one space → blanks dropped → duplicates after normalization
// dropped, the first kept in place (case not folded); a list of blanks normalizes to [].
import { expect, it } from 'vitest';
import {
  normalizePoolTags,
  type PoolTagsNormalizer,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { TABLE } from './kit.ts';

it.each(TABLE)(
  '[CT-07g][D10-2034] catalog/index.ts 导出的规范化：$label',
  ({ input, expected }) => {
    const normalize: PoolTagsNormalizer = normalizePoolTags;
    const frozen = [...input];

    expect(normalize(input)).toEqual(expected);
    expect(input).toEqual(frozen);
  },
);

it('[CT-07g][D10-2034] catalog/index.ts 导出的规范化幂等：表中每行的结果再规范化一次不变', () => {
  for (const { label, expected } of TABLE) {
    expect(normalizePoolTags(expected), label).toEqual(expected);
  }
});
