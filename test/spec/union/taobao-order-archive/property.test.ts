// B1-04zzc（D10-776 方案 A）：任意顺序的自家 / 别家 / 坏行混合页（至少一行别家）：订单详情的归档恰好一行，
// 内容等于去掉别家行后的原序列（坏行、自家在用与已停用推广位的行都在，顺序不变，外层字段不变）。
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import {
  COLLECT,
  FOREIGN_ADZONE,
  OTHER_FOREIGN_ADZONE,
  OUR_ADZONE,
  RETIRED_ADZONE,
  answer,
  foreign,
  num,
  orderBody,
  ours,
  parseLiterals,
  win,
  wire,
  type ArchivedRow,
} from './kit.ts';

const KINDS = [
  'ours',
  'retired',
  'foreign',
  'foreignText',
  'otherForeign',
  'noSlot',
  'badSlot',
  'zeroSlot',
  'text',
  'number',
  'null',
  'array',
] as const;
type Kind = (typeof KINDS)[number];
const FOREIGN_KINDS: readonly Kind[] = ['foreign', 'foreignText', 'otherForeign'];

const BUILD: Readonly<Record<Kind, (index: number) => unknown>> = {
  ours: (index) => ours(index),
  retired: (index) => ours(index, RETIRED_ADZONE),
  foreign: (index) => foreign(index),
  foreignText: (index) => foreign(index, FOREIGN_ADZONE, true),
  otherForeign: (index) => foreign(index, OTHER_FOREIGN_ADZONE),
  noSlot: (index) => ours(index, OUR_ADZONE, { adzone_id: undefined }),
  badSlot: (index) => ours(index, OUR_ADZONE, { adzone_id: `synthetic-slot-${index}` }),
  zeroSlot: (index) => ours(index, OUR_ADZONE, { adzone_id: num('0') }),
  text: (index) => `synthetic-row-${index}`,
  number: (index) => num(`${2900000000000001000n + BigInt(index)}`),
  null: () => null,
  array: (index) => [foreign(index)],
};

/** Row kinds in page order, with one row of another slot inserted somewhere. */
const pages = fc
  .record({
    kinds: fc.array(fc.constantFrom(...KINDS), { maxLength: 10 }),
    at: fc.nat(),
    extra: fc.constantFrom(...FOREIGN_KINDS),
  })
  .map(({ kinds, at, extra }) => {
    const all: Kind[] = [...kinds];
    all.splice(at % (kinds.length + 1), 0, extra);
    return all;
  });

/** The stored payload as a literal tree, or undefined when it is not gzip of JSON. */
function storedTree(row: ArchivedRow): unknown {
  const payload = row.values['payload'];
  if (!(payload instanceof Uint8Array)) return undefined;
  try {
    return parseLiterals(gunzipSync(payload).toString('utf8'));
  } catch {
    return undefined;
  }
}

it('[AC-B1-04zzc#5] 任意顺序的自家 / 别家 / 坏行混合页：归档恰好一行，等于去掉别家行后的原序列', async () => {
  await expect(
    fc.assert(
      fc.asyncProperty(pages, async (kinds) => {
        const rows = kinds.map((kind, index) => BUILD[kind](index + 1));
        const kept = rows.filter((_row, index) => !FOREIGN_KINDS.includes(kinds[index]!));
        const body = { hasNext: true, position: 'arc-prop-1_SYN|arc-prop-2_SYN' };
        const h = wire(() => answer(orderBody(rows, body)));
        let failure: unknown;
        try {
          await h.adapter.listOrders(win, {}, COLLECT);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeUndefined();
        expect(h.database.inserted).toHaveLength(1);
        expect(storedTree(h.database.inserted[0]!)).toStrictEqual(
          parseLiterals(orderBody(kept, body)),
        );
        return true;
      }),
      propParams(),
    ),
  ).resolves.toBeUndefined();
}, 900_000);
