// B1-05zg (D10-664 S-08): Agent 卡的购买按钮与最终 rebate_basis 一致（08 BR-TEXT-12 细则「购买按钮」
// 2026-11-05 v3；BR-AI-11 游客 login_required）。search_products 在游客开关下把选中的卡遮罩为
// login_required（未知金额的卡同样变 login_required）时，cta 随之为 rebate_login_to_view；不遮罩的
// amount_unknown 卡为 btn.buy.rebate_unknown、入口已给 login_required 的卡为 rebate_login_to_view；
// normal 卡保持 btn.buy.rebate。卡片入口是 test/spec/agent/tools-search/kit.ts 的替身（只读），
// 它按 quotes 里的卡原样交回，cta 是入口给的值。
import { expect, it } from 'vitest';
import { candidate, card, context, fixture, items } from '../tools-search/kit.ts';

function shown(cards: readonly object[], platform: string) {
  const found = cards.find((c) => (c as { platform?: unknown }).platform === platform) as
    Record<string, unknown> | undefined;
  expect(found, platform).toBeDefined();
  return {
    rebate_basis: found?.['rebate_basis'],
    rebate_min_fen: found?.['rebate_min_fen'],
    rebate_max_fen: found?.['rebate_max_fen'],
    est_net_price_fen: found?.['est_net_price_fen'],
    cta: found?.['cta'],
  };
}

it('[AC-B1-05zg#8] BR-AI-11 / BR-TEXT-12：游客开关开的平台，Agent 搜索卡遮罩为 login_required 时按钮为 rebate_login_to_view；开关关的平台 normal 卡仍为 btn.buy.rebate', async () => {
  const tb = candidate('tb:synthetic-a', 1000, 'taobao', { price_fen: 1200n, coupon_fen: 200n });
  const jd = candidate('jd:synthetic-b', 1000, 'jd');
  const h = fixture([tb, jd]);
  // What catalog sends for a normal single-amount card since 2026-11-05.
  const rebateButton = { text_key: 'btn.buy.rebate' };
  h.quotes.set(tb.ref.productKey, card(tb, { est_net_price_fen: 900, cta: rebateButton }));
  h.quotes.set(jd.ref.productKey, card(jd, { est_net_price_fen: 900, cta: rebateButton }));
  h.settings.set('agent.guest_login_to_view.taobao', true);
  h.settings.set('agent.guest_login_to_view.jd', false);
  const cards = items(await h.run({ q: '合成商品' }, context(null)));
  expect({ taobao: shown(cards, 'taobao'), jd: shown(cards, 'jd') }).toEqual({
    taobao: {
      rebate_basis: 'login_required',
      rebate_min_fen: null,
      rebate_max_fen: null,
      est_net_price_fen: null,
      cta: { text_key: 'rebate_login_to_view' },
    },
    jd: {
      rebate_basis: 'normal',
      rebate_min_fen: 100,
      rebate_max_fen: 100,
      est_net_price_fen: 900,
      cta: { text_key: 'btn.buy.rebate' },
    },
  });
});

it('[AC-B1-05zg#9] BR-AI-11 / BR-TEXT-12：游客开关开时未知金额（amount_unknown）的卡也变 login_required，按钮同步为 rebate_login_to_view', async () => {
  const pdd = candidate('pdd:synthetic-unknown', 1000, 'pdd');
  const h = fixture([pdd]);
  // What catalog sends for an amount_unknown card since 2026-11-05.
  h.quotes.set(
    pdd.ref.productKey,
    card(pdd, {
      rebate_basis: 'amount_unknown',
      rebate_min_fen: null,
      rebate_max_fen: null,
      cta: { text_key: 'btn.buy.rebate_unknown' },
    }),
  );
  h.settings.set('agent.guest_login_to_view.pdd', true);
  const cards = items(await h.run({ q: '合成商品' }, context(null)));
  expect(shown(cards, 'pdd')).toEqual({
    rebate_basis: 'login_required',
    rebate_min_fen: null,
    rebate_max_fen: null,
    est_net_price_fen: null,
    cta: { text_key: 'rebate_login_to_view' },
  });
});

it('[AC-B1-05zg#10] BR-TEXT-12：不遮罩时按钮按最终状态取键 —— amount_unknown 卡为 btn.buy.rebate_unknown，入口已是 login_required 的卡为 rebate_login_to_view', async () => {
  const pdd = candidate('pdd:synthetic-unknown', 1000, 'pdd');
  const tb = candidate('tb:synthetic-hidden');
  const h = fixture([pdd, tb]);
  // The search kit's card double carries a placeholder button key; the delivered card must not.
  h.quotes.set(
    pdd.ref.productKey,
    card(pdd, { rebate_basis: 'amount_unknown', rebate_min_fen: null, rebate_max_fen: null }),
  );
  h.quotes.set(
    tb.ref.productKey,
    card(tb, { rebate_basis: 'login_required', rebate_min_fen: null, rebate_max_fen: null }),
  );
  const cards = items(await h.run({ q: '合成商品' }, context(null)));
  expect({ pdd: shown(cards, 'pdd'), taobao: shown(cards, 'taobao') }).toEqual({
    pdd: {
      rebate_basis: 'amount_unknown',
      rebate_min_fen: null,
      rebate_max_fen: null,
      est_net_price_fen: null,
      cta: { text_key: 'btn.buy.rebate_unknown' },
    },
    taobao: {
      rebate_basis: 'login_required',
      rebate_min_fen: null,
      rebate_max_fen: null,
      est_net_price_fen: null,
      cta: { text_key: 'rebate_login_to_view' },
    },
  });
});
