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
  newKeys,
  segment,
  strings,
  templateCodes,
  text,
  textMap,
  yaml,
} from './kit.ts';

// 归类按 08 BR-TEXT-12 细则「资金术语键」的「普通」一句：「2026-11-12 新增的 `order_list.copy_label`、
// `order_list.copy_spoken`（D10-1275）……也归普通」。08 是逐键写的，不是整组前缀，所以两键逐键列在
// ordinary.keys（与 order_list.claim_entry、order_list.other_product 等同列），不新增 order_list. 前缀。
// 两句只说复制订单号，不带金额变量（{no} 是订单号），不用术语表用户词，也不含关键词 → 不进例外表。

it('[AC-CT-26zk#8] 两个新键在 fund-term-keys.yaml 的 ordinary.keys 里各列一次，不落资金术语段', () => {
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

it('[AC-CT-26zk#9] 两句都不命中关键词核对，也不进例外表', () => {
  for (const key of newKeys) {
    const value = text(key);
    expect(keywordHits(value), `${key} 的关键词核对结果`).toEqual([]);
  }
  const keys = exemptEntries().map((entry) => entry['key']);
  for (const key of newKeys) {
    expect(keys, `${key} 不命中关键词，不能进 exempt`).not.toContain(key);
  }
});

it('[AC-CT-26zk#10] 加入新键后资金术语清单整体核对（每键恰好一段、例外表）无问题', () => {
  expectNewKeysPresent();
  expect(checkFundTermDoc(yaml(fundTermsFile), textMap(), templateCodes())).toEqual([]);
});

it('[AC-CT-26zk#11] 生成的 fund-term-keys.gen.ts 与 YAML 同步含两个新键', () => {
  const generatedOrdinary = FUND_TERM_KEYS.ordinary.keys as readonly string[];
  for (const key of newKeys) {
    expect(generatedOrdinary, `fund-term-keys.gen.ts 的 ordinary.keys 缺少 ${key}`).toContain(key);
  }
  expect([...generatedOrdinary]).toEqual(segment('ordinary')['keys']);
  expect([...(FUND_TERM_KEYS.ordinary.prefixes as readonly string[])]).toEqual(
    segment('ordinary')['prefixes'],
  );
  expect([...(FUND_TERM_KEYS.fund_terms.keys as readonly string[])]).toEqual(
    segment('fund_terms')['keys'],
  );
  expect([...(FUND_TERM_KEYS.fund_terms.prefixes as readonly string[])]).toEqual(
    segment('fund_terms')['prefixes'],
  );
  const generatedExempt = (
    FUND_TERM_KEYS.exempt as readonly { readonly key: string; readonly reason: string }[]
  ).map((entry) => ({ key: entry.key, reason: entry.reason }));
  expect(generatedExempt).toEqual(exemptEntries());
});

it('[AC-CT-26zk#12] 两句过禁用词守卫', () => {
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
  }
});
