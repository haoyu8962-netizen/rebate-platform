import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { it } from 'vitest';
import { row, sources } from '../pdd-goods/kit.ts';
import { catRow, expectL1, expectNoCategory, L1, L1_SHAPE, mapped } from './kit.ts';

const positive = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
const tail = fc.array(fc.oneof(positive, fc.jsonValue()), { maxLength: 4 });
const source = fc.constantFrom(...sources);

it('[AC-B1-04zzw#10] 任意正安全整数首项 → category_l1_id 恰为其十进制字符串；后续项、cat_id 与同名冒充键都不影响', () => {
  fc.assert(
    fc.property(
      source,
      positive,
      tail,
      fc.jsonValue(),
      fc.jsonValue(),
      (from, first, rest, catId, spoof) => {
        const item = mapped(
          from,
          row({
            cat_ids: [first, ...rest],
            cat_id: catId,
            category_l1_id: spoof,
            category_l1_name: spoof,
          }),
        );
        expectL1(item, String(first));
        return true;
      },
    ),
    propParams(),
  );
}, 900_000);

/** 首项只要不是正安全整数、也不是合格形状的十进制字符串（后者本单不钉），一律不出。 */
function plainlyBad(value: unknown): boolean {
  if (typeof value === 'number') return !(Number.isSafeInteger(value) && value > 0);
  if (typeof value === 'string') return !L1_SHAPE.test(value);
  return true;
}

const badFirst = fc
  .oneof(
    fc.jsonValue(),
    fc.double(),
    fc.integer({ min: Number.MIN_SAFE_INTEGER, max: 0 }),
    fc.string(),
    fc.stringMatching(/^0[0-9]{1,6}$/),
  )
  .filter(plainlyBad);

it('[AC-B1-04zzw#11] 任意不合格首项 → 不出 category_l1_id，即使后面有合格项也不回退', () => {
  for (const from of sources) expectL1(mapped(from, catRow()), L1);
  fc.assert(
    fc.property(
      source,
      badFirst,
      fc.array(positive, { minLength: 1, maxLength: 4 }),
      (from, first, rest) => {
        expectNoCategory(mapped(from, row({ cat_ids: [first, ...rest] })));
        return true;
      },
    ),
    propParams(),
  );
}, 900_000);

it('[AC-B1-04zzw#12] cat_ids 不是数组（任意 JSON 值）→ 不出 category_l1_id', () => {
  for (const from of sources) expectL1(mapped(from, catRow()), L1);
  fc.assert(
    fc.property(
      source,
      fc.jsonValue().filter((value) => !Array.isArray(value)),
      (from, raw) => {
        expectNoCategory(mapped(from, row({ cat_ids: raw })));
        return true;
      },
    ),
    propParams(),
  );
}, 900_000);
