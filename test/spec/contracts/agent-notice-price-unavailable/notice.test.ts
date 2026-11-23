import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { classifyTextKey } from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import { FUND_TERM_KEYS } from '../../../../apps/api/src/modules/content/specs/fund-term-keys.gen.ts';
import {
  loadFundTermKeys,
  segmentsOfKey,
} from '../../../../packages/contracts-ts/scripts/fund-term-keys.ts';
import type { FundTermKeys } from '../../../../packages/contracts-ts/scripts/fund-term-keys.ts';

const noticeKey = 'agent.notice.price_unavailable';
const textsFile = new URL('../../../../contracts/texts.default.json', import.meta.url);

it('[AC-CT-26zq#1] 默认价格查询提示文案逐字匹配且没有变量', () => {
  const dictionary = JSON.parse(readFileSync(textsFile, 'utf8')) as {
    texts: Record<string, unknown>;
  };
  const notice = dictionary.texts[noticeKey];

  expect(notice).toBe('暂时查不到这件商品的价格，请稍后再试。');
  expect(notice).not.toMatch(/[{}]/);
});

it('[AC-CT-26zq#2] 资金术语清单逐键将价格查询提示归入普通文案', () => {
  const spec = loadFundTermKeys() as FundTermKeys;

  expect(spec.ordinary.keys.filter((key) => key === noticeKey)).toHaveLength(1);
  expect(spec.ordinary.prefixes.some((prefix) => noticeKey.startsWith(prefix))).toBe(false);
  expect(segmentsOfKey(spec, noticeKey)).toEqual(['ordinary']);
  expect(spec.exempt.map(({ key }) => key)).not.toContain(noticeKey);
});

it('[AC-CT-26zq#3] 运行时生成清单逐键收录价格查询提示，分类结果为普通文案', () => {
  expect(FUND_TERM_KEYS.ordinary.keys).toContain(noticeKey);
  expect(classifyTextKey(noticeKey, FUND_TERM_KEYS)).toBe('general');
});
