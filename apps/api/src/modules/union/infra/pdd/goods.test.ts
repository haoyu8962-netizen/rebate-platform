import { expect, it } from 'vitest';
import { UnionError } from '../../domain/types.ts';
import {
  checkQueryIdentity,
  feedCursor,
  mapPddGoods,
  parseFeedCursor,
  parseSearchCursor,
  searchCursor,
} from './goods.ts';

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof UnionError) return error.code;
    throw error;
  }
  throw new Error('expected a UnionError');
}

it('[AC-B1-04u-UNIT#1] 搜索游标往返保留页码与 list_id，畸形游标 invalid_dto', () => {
  expect(parseSearchCursor(searchCursor(2, 'unit-list/列表'))).toEqual({
    page: 2,
    listId: 'unit-list/列表',
  });
  expect(parseSearchCursor(searchCursor(3, null))).toEqual({ page: 3, listId: null });
  for (const bad of ['pdd-search:1:', 'pdd-search:0:', 'pdd-search:2:a+b', 'pdd-feed:20', '']) {
    expect(code(() => parseSearchCursor(bad))).toBe('invalid_dto');
  }
});

it('[AC-B1-04u-UNIT#2] 物料游标只接受正偏移', () => {
  expect(parseFeedCursor(feedCursor(40))).toBe(40);
  for (const bad of ['pdd-feed:0', 'pdd-feed:-1', 'pdd-feed:01', 'pdd-search:2:']) {
    expect(code(() => parseFeedCursor(bad))).toBe('invalid_dto');
  }
});

it('[AC-B1-04u-UNIT#3] 查询身份原样透传，非对象或缺字段 invalid_identity', () => {
  expect(checkQueryIdentity({ pid: 'unit-pid', customParameters: '{"uid":"u"}' })).toEqual({
    pid: 'unit-pid',
    custom_parameters: '{"uid":"u"}',
  });
  for (const bad of [null, 'x', { pid: 'unit-pid' }, { customParameters: '{}' }]) {
    expect(code(() => checkQueryIdentity(bad))).toBe('invalid_identity');
  }
});

it('[AC-B1-04zzf-UNIT#1] 商品行图片取 goods_image_url / goods_gallery_urls 并清洗，缩略图与同名字段不用', () => {
  const host = 'https://img.synthetic.invalid';
  const row = {
    goods_id: 1,
    goods_sign: 'unit-sign',
    goods_name: 'unit',
    min_group_price: 1000,
    coupon_discount: 0,
    promotion_rate: 100,
    goods_image_url: `${host}/main.jpg`,
    goods_gallery_urls: [`${host}/a.jpg`, 'http://x/b.jpg', `${host}/a.jpg`],
    goods_thumbnail_url: `${host}/thumb.jpg`,
    main_image_url: `${host}/spoof.jpg`,
    image_urls: [`${host}/spoof.jpg`],
  };
  const now = new Date('2026-11-04T00:00:00Z');
  const mapped = mapPddGoods(row, 'search', now, () => undefined);
  expect(mapped.main_image_url).toBe(`${host}/main.jpg`);
  expect(mapped.image_urls).toEqual([`${host}/a.jpg`]);
  const bare = mapPddGoods(
    { ...row, goods_image_url: null, goods_gallery_urls: undefined },
    'detail',
    now,
    () => undefined,
  );
  expect(Object.hasOwn(bare, 'main_image_url')).toBe(false);
  expect(Object.hasOwn(bare, 'image_urls')).toBe(false);
});
