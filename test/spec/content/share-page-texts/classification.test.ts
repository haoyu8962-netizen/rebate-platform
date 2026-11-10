import { expect, it } from 'vitest';
import { FUND_TERM_KEYS } from '../../../../apps/api/src/modules/content/specs/fund-term-keys.gen.ts';
import {
  classifyTextKey,
  findBannedWords,
} from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import {
  checkFundTermDoc,
  isFundTermKey,
  keywordHits,
  segmentsOfKey,
} from '../../../../packages/contracts-ts/scripts/fund-term-keys.ts';
import {
  bannedWords,
  exemptEntries,
  expectNewKeysPresent,
  fundTermKeys,
  fundTermsFile,
  invalidKey,
  newKeys,
  quoteKey,
  segment,
  strings,
  templateCodes,
  text,
  textMap,
  yaml,
} from './kit.ts';

// 归类按 08 BR-TEXT-12 细则「资金术语键」认定规则：
// - 两句都只说链接能不能用、商品价格是什么时候取的，不说金额或提现状态（①）、不说有没有返利或推广收益（②）、
//   不在返利金额的位置（③）、没有金额变量（④，{time} 不是金额）→ 归普通。
// - 失效句用到术语表「用户词」的「已失效」（⑤ 的辅助核对），但说的是链接；08 同一细则把 link_landing.invalid
//   「链接已失效」列为例外表的例子（「说的是链接」），本句照此归普通并在例外表写理由。

it('[AC-F1-11b#7] 两个新键在 fund-term-keys.yaml 的 ordinary.keys 里各列一次，不落资金术语段', () => {
  const ordinary = strings(segment('ordinary')['keys'], 'ordinary.keys');
  const fund = strings(segment('fund_terms')['keys'], 'fund_terms.keys');
  const doc = fundTermKeys();
  for (const key of newKeys) {
    expect(
      ordinary.filter((item) => item === key),
      `${key} 必须在 ordinary.keys 里恰好列一次`,
    ).toHaveLength(1);
    expect(fund, `${key} 不能列在 fund_terms.keys`).not.toContain(key);
    expect(segmentsOfKey(doc, key), `${key} 只落普通段`).toEqual(['ordinary']);
    expect(isFundTermKey(doc, key), `${key} 守卫判定不是资金术语`).toBe(false);
    expect(classifyTextKey(key, doc), `${key} 后台按普通文案管理`).toBe('general');
  }
});

it('[AC-F1-11b#8] 链接失效句命中「已失效」，例外表有它一条理由，说明「已失效」说的是链接', () => {
  const value = text(invalidKey);
  expect(keywordHits(value), `${invalidKey} 的关键词核对结果`).toEqual(['已失效']);
  const entries = exemptEntries().filter((entry) => entry['key'] === invalidKey);
  expect(entries, `exempt 里 ${invalidKey} 必须恰好一条`).toHaveLength(1);
  const reason = entries[0]?.['reason'];
  expect(typeof reason, `${invalidKey} 的例外理由必须是字符串`).toBe('string');
  const why = String(reason);
  expect(why.trim(), `${invalidKey} 的例外理由不能为空`).not.toBe('');
  expect(why.includes('链接'), `${invalidKey} 的例外理由要说明「已失效」说的是链接`).toBe(true);
});

it('[AC-F1-11b#9] 取价时间句不命中关键词核对，也不进例外表', () => {
  const value = text(quoteKey);
  expect(keywordHits(value), `${quoteKey} 的关键词核对结果`).toEqual([]);
  const keys = exemptEntries().map((entry) => entry['key']);
  expect(keys, `${quoteKey} 不命中关键词，不能进 exempt`).not.toContain(quoteKey);
});

it('[AC-F1-11b#10] 加入新键后资金术语清单整体核对（每键恰好一段、例外表）无问题', () => {
  expectNewKeysPresent();
  expect(checkFundTermDoc(yaml(fundTermsFile), textMap(), templateCodes())).toEqual([]);
});

it('[AC-F1-11b#11] 生成的 fund-term-keys.gen.ts 与 YAML 同步含两个新键与失效句的例外理由', () => {
  const generatedOrdinary = FUND_TERM_KEYS.ordinary.keys as readonly string[];
  for (const key of newKeys) {
    expect(generatedOrdinary, `fund-term-keys.gen.ts 的 ordinary.keys 缺少 ${key}`).toContain(key);
  }
  expect([...generatedOrdinary]).toEqual(segment('ordinary')['keys']);
  expect([...(FUND_TERM_KEYS.fund_terms.keys as readonly string[])]).toEqual(
    segment('fund_terms')['keys'],
  );
  const generatedExempt = (
    FUND_TERM_KEYS.exempt as readonly { readonly key: string; readonly reason: string }[]
  ).map((entry) => ({ key: entry.key, reason: entry.reason }));
  expect(
    generatedExempt.map((entry) => entry.key),
    `fund-term-keys.gen.ts 的 exempt 缺少 ${invalidKey}`,
  ).toContain(invalidKey);
  expect(generatedExempt).toEqual(exemptEntries());
});

it('[AC-F1-11b#12] 两句过禁用词守卫，且不带返利、红包等利益表述（中间页不显示返利）', () => {
  const words = bannedWords();
  expect(words.length, '禁用词表不能为空').toBeGreaterThan(0);
  for (const key of newKeys) {
    const value = text(key);
    expect(findBannedWords({ fragments: [{ text: value }] }, words, 'user_visible'), key).toEqual(
      [],
    );
    expect(
      findBannedWords({ fragments: [{ key, text: value }] }, words, 'user_visible'),
      key,
    ).toEqual([]);
    // BR-PRICE（分享中间页不显示返利）与 BR-ATTR-05 细则（中间页文案不得带返利、红包等利益表述）。
    for (const word of ['返利', '红包', '佣金', '收益', '预估返']) {
      expect(value.includes(word), `${key} 不能出现「${word}」`).toBe(false);
    }
  }
});
