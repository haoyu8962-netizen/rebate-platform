// B1-05zg (D10-664 S-08): 每个出卡入口各钉一处 —— 同一淘宝有券商品（entry-quote-parity kit 的 PRICE：
// 券前 3990、券 1000、券后 2990，真实 commission 报价器单值 269）经搜索、识别（粘贴链接）、详情、收藏、
// 热销榜出的卡，购买按钮都是 btn.buy.rebate（08 BR-TEXT-12 细则「购买按钮」2026-11-05 v3：有券、无券
// 同一句，btn.buy.coupon 不再下发）。各入口沿用现有规则测试 kit（只读）。
import { expect, it } from 'vitest';
import { viaDetail, viaParse, viaRank, viaSearch } from '../entry-quote-parity/entries.ts';
import { quoterOf } from '../entry-quote-parity/kit.ts';
import { button, viaFavorites } from './kit.ts';

/** What every entry's card of PRICE shows as its buy button. */
const REBATE_BUTTON = {
  rebate_basis: 'normal',
  coupon_fen: 1000,
  cta: { text_key: 'btn.buy.rebate' },
} as const;

it('[AC-B1-05zg#3] BR-TEXT-12：搜索（GET /v1/products/search）有券单值卡按钮为 btn.buy.rebate', async () => {
  const search = await viaSearch(quoterOf('commission'));
  expect(search.cards.map(button)).toEqual([REBATE_BUTTON]);
});

it('[AC-B1-05zg#4] BR-TEXT-12：识别（粘贴链接解析）有券单值卡按钮为 btn.buy.rebate', async () => {
  const parse = await viaParse(quoterOf('commission'));
  expect(parse.cards.map(button)).toEqual([REBATE_BUTTON]);
});

it('[AC-B1-05zg#5] BR-TEXT-12：详情（GET /v1/products/{product_key}）有券单值卡按钮为 btn.buy.rebate', async () => {
  const detail = await viaDetail(quoterOf('commission'));
  expect(detail.cards.map(button)).toEqual([REBATE_BUTTON]);
});

it('[AC-B1-05zg#6] BR-TEXT-12：收藏列表的有效卡（收藏取卡端口）按钮为 btn.buy.rebate', async () => {
  const favorite = await viaFavorites(quoterOf('commission'));
  expect(favorite.view.invalid).toBe(false);
  expect(button(favorite.view.productCard)).toEqual(REBATE_BUTTON);
  expect(favorite.register).toHaveBeenCalledTimes(1);
});

it('[AC-B1-05zg#7] BR-TEXT-12：热销榜（GET /v1/rank/hot）有券单值卡按钮为 btn.buy.rebate', async () => {
  const rank = await viaRank(quoterOf('commission'));
  expect(rank.cards.map(button)).toEqual([REBATE_BUTTON]);
});
