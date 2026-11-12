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
  claimDraftSiblings,
  earningsPrefix,
  exemptEntries,
  expectNewKeysPresent,
  fundTermKeys,
  fundTermsFile,
  newKeys,
  ordinaryKeys,
  segment,
  strings,
  templateCodes,
  text,
  textMap,
  updatedAtKey,
  yaml,
} from './kit.ts';

// 归类按 08 BR-TEXT-12 细则「资金术语键」：
// - 「2026-11-12 裁定回写第八批……在 BR-TEXT-14 表 C 补登的 AI 助手页界面文案键归普通（只说界面状态、操作入口、
//   次数用完后的引导与举报，不说金额、提现状态或有没有返利）」逐键列出 52 个键 → 逐键列在 ordinary.keys，不加前缀。
// - 「同批的 agent.earnings.updated_at（「更新于 {time}」）在 agent.earnings. 前缀内，归资金术语」→ 由已有前缀
//   agent.earnings. 覆盖，不再单列（单列会被 checkFundTermDoc 报「already covered by a prefix」）。

it('[AC-CT-26zn#8] 52 个普通键在 fund-term-keys.yaml 的 ordinary.keys 里各列一次，不落资金术语段、不靠前缀', () => {
  const ordinary = strings(segment('ordinary')['keys'], 'ordinary.keys');
  const ordinaryPrefixes = strings(segment('ordinary')['prefixes'], 'ordinary.prefixes');
  const fund = strings(segment('fund_terms')['keys'], 'fund_terms.keys');
  const doc = fundTermKeys();
  expect(ordinaryKeys).toHaveLength(52);
  const unlisted = ordinaryKeys.filter((key) => !ordinary.includes(key));
  expect(unlisted, 'ordinary.keys 缺少这些键').toEqual([]);
  for (const key of ordinaryKeys) {
    expect(
      ordinary.filter((item) => item === key),
      `${key} 必须在 ordinary.keys 里恰好列一次`,
    ).toHaveLength(1);
    expect(fund, `${key} 不能列在 fund_terms.keys`).not.toContain(key);
    expect(
      ordinaryPrefixes.filter((prefix) => key.startsWith(prefix)),
      `${key} 逐键列出，不能被 ordinary 前缀覆盖`,
    ).toEqual([]);
    expect(segmentsOfKey(doc, key), `${key} 只落普通段`).toEqual(['ordinary']);
    expect(isFundTermKey(doc, key), `${key} 守卫判定不是资金术语`).toBe(false);
    expect(classifyTextKey(key, doc), `${key} 后台按普通文案管理`).toBe('general');
  }
  // agent.card.claim_draft.order_no 并到已有的找回草稿卡下，同卡其余键已归普通。
  for (const key of claimDraftSiblings) {
    expect(segmentsOfKey(doc, key), `${key} 仍只落普通段`).toEqual(['ordinary']);
  }
});

it('[AC-CT-26zn#9] agent.earnings.updated_at 入字典后由 agent.earnings. 前缀归资金术语，不单列、不落普通段', () => {
  expect(text(updatedAtKey)).toBe('更新于 {time}');
  const doc = fundTermKeys();
  const fundPrefixes = strings(segment('fund_terms')['prefixes'], 'fund_terms.prefixes');
  expect(fundPrefixes, `fund_terms.prefixes 仍含 ${earningsPrefix}`).toContain(earningsPrefix);
  expect(strings(segment('fund_terms')['keys'], 'fund_terms.keys')).not.toContain(updatedAtKey);
  expect(strings(segment('ordinary')['keys'], 'ordinary.keys')).not.toContain(updatedAtKey);
  expect(segmentsOfKey(doc, updatedAtKey), `${updatedAtKey} 只落资金术语段`).toEqual([
    'fund_terms',
  ]);
  expect(isFundTermKey(doc, updatedAtKey), `${updatedAtKey} 守卫判定是资金术语`).toBe(true);
  expect(classifyTextKey(updatedAtKey, doc), `${updatedAtKey} 后台按资金术语管理`).toBe(
    'fund_terms',
  );
  // 归资金术语，不进例外表（例外表只收归普通、命中关键词的键）。
  expect(exemptEntries().map((entry) => entry['key'])).not.toContain(updatedAtKey);
});

it('[AC-CT-26zn#10] 52 句普通文案都不命中关键词核对、不带金额说法，也不进例外表', () => {
  expectNewKeysPresent();
  const exempted = exemptEntries().map((entry) => entry['key']);
  for (const key of ordinaryKeys) {
    const value = text(key);
    expect(keywordHits(value), `${key} 的关键词核对结果`).toEqual([]);
    for (const word of ['返利', '收益', '提现', '佣金', '金额', '¥', '￥']) {
      expect(value.includes(word), `${key} 不能说「${word}」`).toBe(false);
    }
    expect(exempted, `${key} 不命中关键词，不能进 exempt`).not.toContain(key);
  }
  expect(keywordHits(text(updatedAtKey)), `${updatedAtKey} 的关键词核对结果`).toEqual([]);
});

it('[AC-CT-26zn#11] 加入 53 个新键后资金术语清单整体核对（每键恰好一段、例外表）无问题', () => {
  expectNewKeysPresent();
  expect(checkFundTermDoc(yaml(fundTermsFile), textMap(), templateCodes())).toEqual([]);
});

it('[AC-CT-26zn#12] 重新生成的 fund-term-keys.gen.ts 与 YAML 同步，含 52 个普通键与 agent.earnings. 前缀', () => {
  const generatedOrdinary = FUND_TERM_KEYS.ordinary.keys as readonly string[];
  const missing = ordinaryKeys.filter((key) => !generatedOrdinary.includes(key));
  expect(missing, 'fund-term-keys.gen.ts 的 ordinary.keys 缺少这些键').toEqual([]);
  expect(FUND_TERM_KEYS.fund_terms.prefixes as readonly string[]).toContain(earningsPrefix);
  expect(FUND_TERM_KEYS.fund_terms.keys as readonly string[]).not.toContain(updatedAtKey);
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

it('[AC-CT-26zn#13] 53 句都过禁用词守卫', () => {
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
