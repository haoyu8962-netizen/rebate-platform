import { expect, it } from 'vitest';
import { FUND_TERM_KEYS } from '../../../../apps/api/src/modules/content/specs/fund-term-keys.gen.ts';
import {
  classifyTemplate,
  classifyTextKey,
  findBannedWords,
} from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import type { BannedWord } from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import {
  checkFundTermDoc,
  isFundTermKey,
  segmentsOfTemplate,
} from '../../../../packages/contracts-ts/scripts/fund-term-keys.ts';
import type { FundTermKeys } from '../../../../packages/contracts-ts/scripts/fund-term-keys.ts';
import {
  bannedWordsFile,
  code,
  fundTermsFile,
  list,
  ordinaryTemplates,
  previousFundTemplates,
  segment,
  strings,
  templateValues,
  text,
  texts,
  titles,
  yaml,
} from './kit.ts';

function fundTermKeys(): FundTermKeys {
  return yaml(fundTermsFile) as unknown as FundTermKeys;
}

function bannedWords(): BannedWord[] {
  return list(yaml(bannedWordsFile)['words'], `${bannedWordsFile} 的 words`) as BannedWord[];
}

it('[AC-CT-26za#8] fund_terms.notify_templates 加 SETTLE_ADJUSTED，原有资金类模板一个不少', () => {
  const fund = strings(segment('fund_terms')['notify_templates'], 'fund_terms.notify_templates');
  expect(
    fund.filter((item) => item === code),
    `${code} 必须恰好列一次`,
  ).toHaveLength(1);
  expect(fund.filter((item) => previousFundTemplates.includes(item))).toEqual(
    previousFundTemplates,
  );
});

it('[AC-CT-26za#9] ordinary.notify_templates 不变且不含 SETTLE_ADJUSTED，每个模板编码只落一段', () => {
  const codes = Object.keys(templateValues());
  expect(codes, `notify_template_code 缺少 ${code}`).toContain(code);
  expect(strings(segment('ordinary')['notify_templates'], 'ordinary.notify_templates')).toEqual(
    ordinaryTemplates,
  );
  const doc = fundTermKeys();
  for (const item of codes) {
    expect(segmentsOfTemplate(doc, item), item).toHaveLength(1);
  }
  expect(segmentsOfTemplate(doc, code)).toEqual(['fund_terms']);
  expect(classifyTemplate(code, doc)).toBe('fund_terms');
});

it('[AC-CT-26za#10] 生成的 fund-term-keys.gen.ts 与 YAML 同步含 SETTLE_ADJUSTED', () => {
  const generated = FUND_TERM_KEYS.fund_terms.notify_templates as readonly string[];
  expect(generated, `fund-term-keys.gen.ts 缺少 ${code}`).toContain(code);
  expect([...generated]).toEqual(segment('fund_terms')['notify_templates']);
  expect([...FUND_TERM_KEYS.ordinary.notify_templates]).toEqual(
    segment('ordinary')['notify_templates'],
  );
});

it('[AC-CT-26za#11] 资金术语清单整体核对（键与模板归类、例外表）在新增后无问题', () => {
  const dictionary = texts();
  for (const key of Object.keys(titles)) {
    expect(Object.hasOwn(dictionary, key), `缺少 ${key}`).toBe(true);
  }
  const codes = Object.keys(templateValues());
  expect(codes, `notify_template_code 缺少 ${code}`).toContain(code);
  const textMap = Object.fromEntries(
    Object.entries(dictionary).map(([key, value]) => [key, String(value)]),
  );
  expect(checkFundTermDoc(yaml(fundTermsFile), textMap, codes)).toEqual([]);
});

it.each(Object.keys(titles))(
  '[AC-CT-26za#12] %s 归资金术语且过禁用词检查（不出现被禁的资金措辞）',
  (key) => {
    const value = text(key);
    const doc = fundTermKeys();
    expect(classifyTextKey(key, doc)).toBe('fund_terms');
    expect(isFundTermKey(doc, key)).toBe(true);
    const words = bannedWords();
    expect(words.length, '禁用词表不能为空').toBeGreaterThan(0);
    expect(findBannedWords({ fragments: [{ text: value }] }, words, 'user_visible')).toEqual([]);
    expect(
      findBannedWords(
        { template_code: code, fragments: [{ key, text: value }] },
        words,
        'user_visible',
      ),
    ).toEqual([]);
  },
);
