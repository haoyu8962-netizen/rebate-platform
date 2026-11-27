import { expect, it } from 'vitest';
import { findBannedWords } from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import type { BannedWord } from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import { BANNED_WORDS } from '../../../../apps/api/src/modules/content/specs/banned-words.gen.ts';
import { FUND_TERM_KEYS } from '../../../../apps/api/src/modules/content/specs/fund-term-keys.gen.ts';
import { segmentsOfKey } from '../../../../packages/contracts-ts/scripts/fund-term-keys.ts';
import type { FundTermKeys } from '../../../../packages/contracts-ts/scripts/fund-term-keys.ts';
import { at, list, readMapping } from './kit.ts';

// D10-3434 / D10-3435，规划/08 BR-TEXT-14 表 C、BR-TEXT-12 与 BR-TEXT-13。
const copy = {
  'share.save_images.partial': '已保存 {succeeded}/{total} 张图片，其余保存失败',
  'share.save_images.failed': '图片保存失败，请稍后重试',
  'order_detail.price_compare.summary_title': '什么是比价订单',
  'order_detail.price_compare.summary_body':
    '当平台判定这笔订单属于比价订单时，返利会按平台规则降低或不予返利，是否构成比价以平台判定为准。',
  'order_detail.price_compare.view_article': '查看完整说明',
  'pdd.compare_reminder.btn': '收藏并稍后提醒',
  'pdd.compare_reminder.scheduled':
    '已收藏，将在 {minutes} 分钟后提醒你查看；是否构成比价以平台判定为准',
  'pdd.compare_reminder.no_perm': '已收藏商品（未开启系统通知，请稍后在收藏夹查看）',
  'pdd.compare_reminder.notify_title': '收藏商品提醒',
  'pdd.compare_reminder.notify_body':
    '你收藏的商品可以回凑狸查看了，是否构成比价及返利以平台下单判定为准',
};
const fundKeys = [
  'order_detail.price_compare.summary_title',
  'order_detail.price_compare.summary_body',
  'pdd.compare_reminder.scheduled',
  'pdd.compare_reminder.notify_body',
];
const previousAllowKeys = [
  'order_reason.PRICE_COMPARE.title',
  'order_reason.PRICE_COMPARE.desc',
  'order_status.PAID.hint.price_compare',
  'no_rebate.price_compare',
  'no_rebate.price_compare.confirm',
  'order.price_compare.hint',
  'order.tag.price_compare',
  'order_reason.PRICE_COMPARE.summary',
];

it('[AC-CT-26zs#1] 十条文案与占位符逐字匹配表 C', async () => {
  // 漏键、把 succeeded 改成 n、改标点或给提醒话术加收益承诺，逐字对比都会失败。
  const dictionary = at(await readMapping('contracts/texts.default.json'), 'texts');
  expect(dictionary).toMatchObject({
    ...copy,
    'share.save_images': '保存图片',
    'share.saved': '已保存 {n} 张图片到相册',
    'order.price_compare.hint': '这笔订单被平台判为比价订单，没有返利',
    'order.tag.price_compare': '比价订单',
  });
});

it('[AC-CT-26zs#2] 新文案各归一类', async () => {
  // 双重归类、漏登记，或用大前缀把普通键也归资金术语，均会失败。
  const doc = await readMapping('specs/fund-term-keys.yaml');
  const source = doc as unknown as FundTermKeys;
  for (const key of Object.keys(copy)) {
    const segment = fundKeys.includes(key) ? 'fund_terms' : 'ordinary';
    const entries = source[segment].keys.filter((entry) => entry === key);
    expect(entries, key).toHaveLength(1);
    expect(segmentsOfKey(source, key), key).toEqual([segment]);
  }
});

it('[AC-CT-26zs#3] 「比价」只为四个指定新增键放行', async () => {
  // 少放行、用通配符顶替精确键、放行普通键或其他禁用词均会失败。
  const source = await readMapping('specs/banned-words.yaml');
  const words = list(source['words'], 'banned-words.words') as BannedWord[];
  const compare = words.find(({ word }) => word === '比价');
  const allowKeys = compare?.allow_keys ?? [];
  expect(words.filter(({ word }) => word === '比价')).toHaveLength(1);
  expect(allowKeys).toEqual(expect.arrayContaining(previousAllowKeys));
  expect(allowKeys.filter((key) => Object.hasOwn(copy, key)).sort()).toEqual([...fundKeys].sort());
  for (const [key, text] of Object.entries(copy)) {
    for (const scope of ['user_visible', 'admin_report'] as const) {
      const raw = findBannedWords({ fragments: [{ text }] }, words, scope);
      expect(raw, `${scope}: ${key} 的原文命中`).toEqual(fundKeys.includes(key) ? ['比价'] : []);
      expect(findBannedWords({ fragments: [{ key, text }] }, words, scope), key).toEqual([]);
      if (!fundKeys.includes(key)) {
        const syntheticHit = findBannedWords({ fragments: [{ key, text: '比价' }] }, words, scope);
        expect(syntheticHit, key).toEqual(['比价']);
      }
    }
  }
});

it('[AC-CT-26zs#4] 两份文案生成物都含新增配置并与 YAML 完全同步', async () => {
  // 漏重生成任一文件，或者只改生成物不改来源，均会失败。
  expect(FUND_TERM_KEYS.fund_terms.keys).toEqual(expect.arrayContaining(fundKeys));
  expect(BANNED_WORDS.words.find(({ word }) => word === '比价')).toMatchObject({
    allow_keys: expect.arrayContaining(fundKeys),
  });
  expect(FUND_TERM_KEYS).toEqual(await readMapping('specs/fund-term-keys.yaml'));
  expect(BANNED_WORDS).toEqual(await readMapping('specs/banned-words.yaml'));
});
