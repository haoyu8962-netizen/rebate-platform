import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import type { UnionItemDetail } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { dtkRow, mainPicOf, one, type Row } from '../taobao-search/kit.ts';

// Task-local AC labels ([AC-B1-04zzk#n]) identify this task's acceptance points, not business rules.
// D10-725 ①：大淘客搜索的 smallImages → image_urls 先过 normalizeItemImages 的合法性检查与去重，再按
// 图床白名单（DATAOKE_IMAGE_HOSTS，B1-04zzj）去掉白名单外的地址，最后才截到 9 张：白名单外与重复项都
// 不占 9 张的名额，结果是「合法 + 白名单内 + 去重」后按上游顺序的前 9 个。主图不受影响。
// 地址全是合成路径，不抄录制原值。

const LIMIT = 9;

/** Distinct whitelisted addresses (alicdn.com subdomain), in a fixed order. */
const ALLOWED = Array.from(
  { length: 12 },
  (_, i) => `https://img.synthetic.alicdn.com/dtk/followup-${String(i + 1).padStart(2, '0')}.jpg`,
);
const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED);

/** Well-formed https addresses whose host is outside the whitelist. */
const FOREIGN = [
  'https://img.example.test/syn-foreign-1.jpg',
  'https://alicdn.com.evil.test/syn-foreign-2.jpg',
  'https://evilalicdn.com/syn-foreign-3.jpg',
  'https://img.alicdn.com@img.example.test/syn-foreign-4.jpg',
];

/** Entries normalizeItemImages drops anyway (not https, whitespace, empty, not a string). */
const INVALID: unknown[] = [
  'http://img.synthetic.alicdn.com/dtk/plain-http.jpg',
  'https://img.synthetic.alicdn.com/dtk/has space.jpg',
  '',
  42,
  null,
];

const A = (n: number): string => ALLOWED[n - 1]!;
const F = (n: number): string => FOREIGN[n - 1]!;

/** Reference: valid whitelisted entries, first occurrence kept, upstream order, at most 9. */
function expectedImages(list: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry === 'string' && ALLOWED_SET.has(entry) && !out.includes(entry)) {
      out.push(entry);
    }
  }
  return out.slice(0, LIMIT);
}

async function imagesOf(n: number, smallImages: readonly unknown[]): Promise<UnionItemDetail> {
  const row: Row = dtkRow(n, { smallImages: [...smallImages] });
  return one(row);
}

it('[AC-B1-04zzk#4] 3 个白名单外地址在前、其后 9 个白名单内地址 → image_urls 恰为这 9 个（顺序不变）', async () => {
  const nine = ALLOWED.slice(0, LIMIT);
  const item = await imagesOf(41, [F(1), F(2), F(3), ...nine]);
  expect(item.image_urls).toEqual(nine);
  expect(item.main_image_url).toBe(mainPicOf(41));
});

it('[AC-B1-04zzk#5] 白名单外、重复与不合格项夹杂：结果是过滤 + 去重后的前 9 个', async () => {
  const list: unknown[] = [
    A(1),
    F(1),
    A(1),
    INVALID[0],
    A(2),
    F(2),
    A(3),
    A(2),
    F(3),
    A(4),
    INVALID[1],
    A(5),
    F(4),
    A(6),
    A(7),
    A(3),
    A(8),
    A(9),
    A(10),
    A(11),
  ];
  const item = await imagesOf(42, list);
  expect(item.image_urls).toEqual([A(1), A(2), A(3), A(4), A(5), A(6), A(7), A(8), A(9)]);
});

it('[AC-B1-04zzk#6] 前 9 个合法地址都在白名单外、第 10 个起才有白名单内地址 → 白名单内的照样进 image_urls', async () => {
  const foreign = [F(1), F(2), F(3), F(4), F(1), F(2), F(3), F(4)].map((url, i) => `${url}?n=${i}`);
  const item = await imagesOf(43, [...foreign, F(1), A(1), A(2)]);
  expect(item.image_urls).toEqual([A(1), A(2)]);
  expect(item.main_image_url).toBe(mainPicOf(43));
});

it('[AC-B1-04zzk#7] 属性：白名单外地址排在前面、白名单内去重后不少于 9 个，夹杂重复与不合格项 → image_urls 恰为参照口径的 9 个', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom(...FOREIGN), { minLength: 1, maxLength: 4 }),
      fc.shuffledSubarray(ALLOWED, { minLength: LIMIT }),
      fc.array(fc.tuple(fc.nat(), fc.constantFrom<unknown>(...FOREIGN, ...INVALID, ...ALLOWED)), {
        maxLength: 6,
      }),
      async (head, allowed, extras) => {
        const list: unknown[] = [...head, ...allowed];
        for (const [at, value] of extras) list.splice(at % (list.length + 1), 0, value);
        const want = expectedImages(list);
        expect(want).toHaveLength(LIMIT);
        const item = await imagesOf(44, list);
        expect(item.image_urls).toEqual(want);
      },
    ),
    propParams(),
  );
}, 900_000);
