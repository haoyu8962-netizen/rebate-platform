// B1-04zzp（D10-793 ①）：任意顺序的自家 / 别家 / 读不出推广位的行混合页（至少一行别家），任意 total_count：
// 违规归档恰好一行，内容等于去掉别家行后的原序列（读不出推广位的行、自家在用与已停用推广位的行都在，顺序不变，
// 外层字段与 total_count 不变）；listPunishments 返回的条目只有自家行。
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  PLAIN,
  PUNISH_PATH,
  answer,
  expectArchivedAs,
  onlyArchiveOf,
  win,
  wire,
} from '../taobao-order-archive/kit.ts';
import {
  FOREIGN_ADZONE,
  OTHER_FOREIGN_ADZONE,
  RETIRED_ADZONE,
  listed,
  num,
  punishOf,
} from '../taobao-refunds/kit.ts';
import { foreignText, punishBody, punishIdOf, punishmentIdOf } from './kit.ts';

const KINDS = [
  'ours',
  'retired',
  'foreign',
  'foreignText',
  'otherForeign',
  'noSlot',
  'badSlot',
  'nullSlot',
  'text',
  'number',
  'null',
  'array',
] as const;
type Kind = (typeof KINDS)[number];
const FOREIGN_KINDS: readonly Kind[] = ['foreign', 'foreignText', 'otherForeign'];
const OUR_KINDS: readonly Kind[] = ['ours', 'retired'];

const BUILD: Readonly<Record<Kind, (index: number) => unknown>> = {
  ours: (index) => punishOf(index),
  retired: (index) => punishOf(index, RETIRED_ADZONE),
  foreign: (index) => punishOf(index, FOREIGN_ADZONE),
  foreignText: (index) => foreignText(index),
  otherForeign: (index) => punishOf(index, OTHER_FOREIGN_ADZONE),
  noSlot: (index) => ({ ...punishOf(index), tk_adzone_id: undefined }),
  badSlot: (index) => ({ ...punishOf(index), tk_adzone_id: `synthetic-slot-${index}` }),
  nullSlot: (index) => ({ ...punishOf(index), tk_adzone_id: null }),
  text: (index) => `synthetic-punish-row-${index}`,
  number: (index) => num(punishIdOf(index)),
  null: () => null,
  array: (index) => [punishOf(index, FOREIGN_ADZONE)],
};

/** Row kinds in page order with one row of another slot inserted somewhere, and extra total_count. */
const pages = fc
  .record({
    kinds: fc.array(fc.constantFrom(...KINDS), { maxLength: 9 }),
    at: fc.nat(),
    extra: fc.constantFrom(...FOREIGN_KINDS),
    more: fc.nat({ max: 20 }),
  })
  .map(({ kinds, at, extra, more }) => {
    const all: Kind[] = [...kinds];
    all.splice(at % (kinds.length + 1), 0, extra);
    return { kinds: all, more };
  });

it('[AC-B1-04zzp#10] 任意顺序的自家 / 别家 / 读不出推广位的行混合页：违规归档恰好一行，等于去掉别家行后的原序列，total_count 不变', async () => {
  await expect(
    fc.assert(
      fc.asyncProperty(pages, async ({ kinds, more }) => {
        const rows = kinds.map((kind, index) => BUILD[kind](index + 1));
        const kept = rows.filter((_row, index) => !FOREIGN_KINDS.includes(kinds[index]!));
        const options = {
          total: rows.length + more,
          top: { request_id: 'synthetic-punish-prop-request' },
          data: { synthetic_note: '合成属性页' },
        };
        const h = wire(() => answer(punishBody(rows, options)));

        const page = await listed(h.adapter.listPunishments(win, PLAIN));

        expect(page.items.map((item) => item.punishment_id)).toEqual(
          kinds.flatMap((kind, index) =>
            OUR_KINDS.includes(kind) ? [punishmentIdOf(index + 1)] : [],
          ),
        );
        expect(h.database.inserted).toHaveLength(1);
        expectArchivedAs(onlyArchiveOf(h.database, PUNISH_PATH), punishBody(kept, options));
      }),
      propParams(),
    ),
  ).resolves.toBeUndefined();
}, 900_000);
