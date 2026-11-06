import { expect, it, vi } from 'vitest';
import {
  DATAOKE_SEARCH_PATH,
  dataokeImageHost,
  mapDataokeSearchItem,
  reportDroppedImageHosts,
  type DataokeDroppedImageHosts,
} from './dataoke-search.ts';

// Local unit-test identifiers (B1-04zzj, D10-692 S2-6 / D10-706); synthetic addresses only.

const RECEIVED_AT = new Date('2026-11-06T01:00:00.000Z');

function candidate(n: number, mainPic: string, smallImages: readonly string[]) {
  return {
    goodsId: `syn-goods-${n}`,
    row: {
      goodsId: `syn-goods-${n}`,
      title: `合成商品 ${n}`,
      mainPic,
      smallImages,
      actualPrice: '10.00',
      couponPrice: '2.00',
      commissionRate: '10',
    },
  };
}

it('[B1-04zzj unit] ffquan.cn (大淘客图床) and its subdomains are accepted; look-alikes and userinfo are not', () => {
  expect(dataokeImageHost('https://img.ffquan.cn/syn-1.jpg')).toEqual({
    allowed: true,
    host: 'img.ffquan.cn',
  });
  expect(dataokeImageHost('https://ffquan.cn:443/syn-1.jpg').allowed).toBe(true);
  expect(dataokeImageHost('https://ffquan.cn.evil.test/syn-1.jpg')).toEqual({
    allowed: false,
    host: 'ffquan.cn.evil.test',
  });
  expect(dataokeImageHost('https://evilffquan.cn/syn-1.jpg').allowed).toBe(false);
  expect(dataokeImageHost('https://syn-user@img.ffquan.cn/syn-1.jpg')).toEqual({
    allowed: false,
    host: 'img.ffquan.cn',
  });
  expect(dataokeImageHost('https://img.example.test\\.alicdn.com/syn-1.jpg')).toEqual({
    allowed: false,
    host: 'img.example.test',
  });
});

it('[B1-04zzj unit] dropped images are tallied per host across the page and reported once per host, host and count only', () => {
  const dropped: DataokeDroppedImageHosts = new Map();
  const warn = vi.fn();
  const first = mapDataokeSearchItem(
    candidate(1, 'https://IMG.Example.test:8443/syn-main-1.jpg', [
      'https://img.ffquan.cn/syn-small-1.jpg',
      'https://img.example.test/syn-small-2.jpg',
    ]),
    'syn-item-1',
    RECEIVED_AT,
    warn,
    dropped,
  );
  const second = mapDataokeSearchItem(
    candidate(2, 'https://img.alicdn.com/syn-main-2.jpg', [
      'https://other.example.test/syn-small-3.jpg',
    ]),
    'syn-item-2',
    RECEIVED_AT,
    warn,
    dropped,
  );
  expect(Object.hasOwn(first, 'main_image_url')).toBe(false);
  expect(first.image_urls).toEqual(['https://img.ffquan.cn/syn-small-1.jpg']);
  expect(second.main_image_url).toBe('https://img.alicdn.com/syn-main-2.jpg');
  expect(Object.hasOwn(second, 'image_urls')).toBe(false);
  // Mapping itself reports nothing (no invalid_item); the page's tally goes out once.
  expect(warn).not.toHaveBeenCalled();

  reportDroppedImageHosts(warn, dropped);
  expect(warn.mock.calls.map(([event]) => event)).toEqual([
    {
      method: DATAOKE_SEARCH_PATH,
      code: 'dataoke_image_host_dropped',
      host: 'img.example.test',
      count: 2,
    },
    {
      method: DATAOKE_SEARCH_PATH,
      code: 'dataoke_image_host_dropped',
      host: 'other.example.test',
      count: 1,
    },
  ]);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('syn-');
});

it('[B1-04zzk unit] smallImages are filtered (validity, whitelist, duplicates) before the cut to 9; every dropped address is tallied', () => {
  const dropped: DataokeDroppedImageHosts = new Map();
  const allowed = Array.from(
    { length: 10 },
    (_, i) => `https://img.alicdn.com/syn-small-${String(i + 1)}.jpg`,
  );
  const foreign = (i: number) => `https://img.example.test/syn-foreign-${String(i)}.jpg`;
  const item = mapDataokeSearchItem(
    candidate(3, 'https://img.alicdn.com/syn-main-3.jpg', [
      foreign(1),
      foreign(2),
      'http://img.alicdn.com/syn-plain-http.jpg',
      allowed[0]!,
      foreign(1),
      allowed[0]!,
      ...allowed.slice(1),
      foreign(3),
    ]),
    'syn-item-3',
    RECEIVED_AT,
    undefined,
    dropped,
  );
  expect(item.image_urls).toEqual(allowed.slice(0, 9));
  expect(item.main_image_url).toBe('https://img.alicdn.com/syn-main-3.jpg');
  // Distinct foreign addresses, including the one past the cap.
  expect([...dropped]).toEqual([['img.example.test', 3]]);
});
