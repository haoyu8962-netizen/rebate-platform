import { expect, it } from 'vitest';
import type { UnionItemDetail } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { dtkRow, expectTrueIdentities, searchRows, type Row } from '../taobao-search/kit.ts';

// Task-local AC labels ([AC-B1-04zzj#n]) identify this task's acceptance points, not business rules.
// D10-692 S2-6：大淘客搜索的 mainPic → main_image_url、smallImages → image_urls，在 normalizeItemImages
// （https、无空白控制字符、≤2048）之上再要求主机名（authority 去掉端口后小写比较；带 userinfo 直接拒）
// 等于 alicdn.com / taobaocdn.com 或以 .alicdn.com / .taobaocdn.com 结尾。其余主机一律视为无图：
// main_image_url 缺省、image_urls 去掉该项（全去掉则缺省）；该条照常返回，不报错、不跳行。
// 地址全是合成路径，不抄录制原值。

const OK_MAIN = 'https://img.alicdn.com/imgextra/syn-main-1.jpg';
const OK_SMALL_A = 'https://img.alicdn.com/imgextra/syn-small-1.jpg';
const OK_SMALL_B = 'https://gw.alicdn.com/bao/uploaded/syn-small-2.jpg';

/** Hosts outside the whitelist (look-alikes included); every one is "no image". */
const FOREIGN: [string, string][] = [
  ['后缀伪装 alicdn.com.evil.test', 'https://alicdn.com.evil.test/imgextra/syn-1.jpg'],
  ['前缀粘连 evilalicdn.com', 'https://evilalicdn.com/imgextra/syn-1.jpg'],
  ['子域伪装 img.alicdn.com.evil.test', 'https://img.alicdn.com.evil.test/imgextra/syn-1.jpg'],
  ['后缀伪装 taobaocdn.com.evil.test', 'https://taobaocdn.com.evil.test/syn-1.jpg'],
  ['前缀粘连 xtaobaocdn.com', 'https://xtaobaocdn.com/syn-1.jpg'],
  ['无关主机', 'https://img.example.test/syn-1.jpg'],
  ['alicdn 只在路径里', 'https://img.example.test/.alicdn.com/syn-1.jpg'],
  ['alicdn 只在查询串里', 'https://img.example.test?h=img.alicdn.com'],
  ['alicdn 只在片段里', 'https://img.example.test#.alicdn.com'],
  ['带 userinfo（主机是 alicdn）', 'https://syn-user@img.alicdn.com/imgextra/syn-1.jpg'],
  ['带空 userinfo', 'https://:@img.alicdn.com/imgextra/syn-1.jpg'],
  ['userinfo 里放 alicdn', 'https://img.alicdn.com@img.example.test/syn-1.jpg'],
  ['userinfo 里放 alicdn 带端口', 'https://img.alicdn.com:443@img.example.test/syn-1.jpg'],
  ['反斜杠夹 @', 'https://img.example.test\\@img.alicdn.com/syn-1.jpg'],
];

/** Whitelisted spellings that must be kept exactly as given. */
const ACCEPTED: [string, string][] = [
  ['img.alicdn.com', 'https://img.alicdn.com/imgextra/syn-2.jpg'],
  ['裸域 alicdn.com', 'https://alicdn.com/imgextra/syn-2.jpg'],
  ['多级子域', 'https://a.b.alicdn.com/imgextra/syn-2.jpg'],
  ['大写主机', 'https://IMG.ALICDN.COM/imgextra/syn-2.jpg'],
  ['带端口', 'https://img.alicdn.com:443/imgextra/syn-2.jpg'],
  ['裸域 taobaocdn.com', 'https://taobaocdn.com/syn-2.jpg'],
  ['img01.taobaocdn.com', 'https://img01.taobaocdn.com/bao/uploaded/syn-2.jpg'],
  ['带查询串', 'https://img.alicdn.com/imgextra/syn-2.jpg?x=1'],
];

function row(n: number, overrides: Row = {}): Row {
  return dtkRow(n, { mainPic: OK_MAIN, smallImages: [], ...overrides });
}

async function searchedDetails(rows: readonly Row[]) {
  const { h, page } = await searchRows(rows);
  return { h, page, items: page.items as readonly UnionItemDetail[] };
}

it.each(FOREIGN)(
  '[AC-B1-04zzj#8] mainPic 主机 %s → 该条照常返回、main_image_url 缺省；不报错、不跳行、不告警 invalid_item',
  async (_label, url) => {
    const { h, page, items } = await searchedDetails([row(1), row(2, { mainPic: url }), row(3)]);
    expect(expectTrueIdentities(page)).toEqual([1, 2, 3]);
    expect(Object.hasOwn(items[1]!, 'main_image_url')).toBe(false);
    expect(items[0]!.main_image_url).toBe(OK_MAIN);
    expect(items[2]!.main_image_url).toBe(OK_MAIN);
    expect(h.warn).not.toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_item' }));
  },
);

it.each(FOREIGN)(
  '[AC-B1-04zzj#9] smallImages 里主机 %s 的一项被去掉，白名单内的项保持原顺序',
  async (_label, url) => {
    const { items } = await searchedDetails([
      row(4, { smallImages: [OK_SMALL_A, url, OK_SMALL_B] }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.image_urls).toEqual([OK_SMALL_A, OK_SMALL_B]);
    expect(items[0]!.main_image_url).toBe(OK_MAIN);
  },
);

it('[AC-B1-04zzj#10] smallImages 全是白名单外主机 → image_urls 缺省；mainPic 也在白名单外 → 两个图片字段都缺省，该条照常返回', async () => {
  const foreign = FOREIGN.map(([, url]) => url);
  const { page, items } = await searchedDetails([
    row(5, { smallImages: foreign }),
    row(6, { mainPic: 'https://evilalicdn.com/syn-6.jpg', smallImages: foreign }),
  ]);
  expect(expectTrueIdentities(page)).toEqual([5, 6]);
  expect(items[0]!.main_image_url).toBe(OK_MAIN);
  expect(Object.hasOwn(items[0]!, 'image_urls')).toBe(false);
  expect(Object.hasOwn(items[1]!, 'main_image_url')).toBe(false);
  expect(Object.hasOwn(items[1]!, 'image_urls')).toBe(false);
});

it.each(ACCEPTED)(
  '[AC-B1-04zzj#11] 白名单写法 %s 原样保留（主图与多图都是），同列表里的白名单外主机被去掉',
  async (_label, url) => {
    const { items } = await searchedDetails([
      row(7, { mainPic: url, smallImages: [url, 'https://alicdn.com.evil.test/syn-7.jpg'] }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.main_image_url).toBe(url);
    expect(items[0]!.image_urls).toEqual([url]);
  },
);
