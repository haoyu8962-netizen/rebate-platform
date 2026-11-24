import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  loadFundTermKeys,
  segmentsOfKey,
} from '../../../../packages/contracts-ts/scripts/fund-term-keys.ts';
import type { FundTermKeys } from '../../../../packages/contracts-ts/scripts/fund-term-keys.ts';

const textsFile = new URL('../../../../contracts/texts.default.json', import.meta.url);

const vendorTexts = [
  ['error.50301.realname_vendor', '实名核验服务暂时不可用，请稍后再试'],
  ['error.50301.bank_vendor', '银行卡核验服务暂时不可用，请稍后再试'],
] as const;

const rateLimitTexts = [
  ['login.get_code.wait', '{n} 秒后可获取验证码', ['{n}']],
  ['login.get_code.wait_min', '{m} 分钟后可获取验证码', ['{m}']],
  ['login.get_code.wait_hour', '{h} 小时后可获取验证码', ['{h}']],
  ['login.code.countdown_min', '{m} 分钟后可重新获取', ['{m}']],
  ['login.code.countdown_hour', '{h} 小时后可重新获取', ['{h}']],
  ['login.code.can_resend', '可以重新获取验证码', []],
] as const;

function readDefaultTexts(): Record<string, string | undefined> {
  const dictionary = JSON.parse(readFileSync(textsFile, 'utf8')) as {
    texts: Record<string, string | undefined>;
  };
  return dictionary.texts;
}

it('[AC-CT-26zr#1] [AC-CT-26zr#2] 50301 默认文案', () => {
  const texts = readDefaultTexts();

  expect(texts['error.50301']).toBe('{platform_name}维护中，请稍后再试');
  expect(texts['error.50301.maintenance']).toBe('{platform_name}维护中，请稍后再试');
  expect(texts['error.50301.not_launched']).toBe('{platform_name}返利即将开放');

  for (const [key, expected] of vendorTexts) {
    const text = texts[key];
    expect(text, key).toBe(expected);
    expect(text, key).not.toMatch(/[{}]/);
  }
});

it('[AC-CT-26zr#4] [AC-CT-26zr#5] 登录限流与倒计时文案', () => {
  const texts = readDefaultTexts();

  expect(texts['login.code.countdown']).toBe('{n} 秒后可重新获取');

  for (const [key, expected, placeholders] of rateLimitTexts) {
    const text = texts[key];
    expect(text, key).toBe(expected);
    const actualPlaceholders = text?.match(/\{[^{}]+\}/g) ?? [];
    expect(actualPlaceholders, key).toEqual(placeholders);
  }
});

it('[AC-CT-26zr#3] [AC-CT-26zr#6] 八个新键逐键归入普通文案', () => {
  const spec = loadFundTermKeys() as FundTermKeys;
  const { keys, prefixes } = spec.ordinary;
  const exemptKeys = spec.exempt.map(({ key }) => key);

  for (const [key] of [...vendorTexts, ...rateLimitTexts]) {
    const entries = keys.filter((entry) => entry === key);
    const coveredByPrefix = prefixes.some((prefix) => key.startsWith(prefix));

    expect(entries, key).toHaveLength(1);
    expect(coveredByPrefix, key).toBe(false);
    expect(segmentsOfKey(spec, key), key).toEqual(['ordinary']);
    expect(exemptKeys, key).not.toContain(key);
  }
});
