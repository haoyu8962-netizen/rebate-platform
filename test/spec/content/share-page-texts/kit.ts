import { existsSync, readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { BannedWord } from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import type { FundTermKeys } from '../../../../packages/contracts-ts/scripts/fund-term-keys.ts';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

// AC-F1-11b#n 是编排裁定 D10-1246 验收点的本地分组，不新增业务 AC / BR。
// 预期只取自 SPEC_REF 时点的 08 原句（见 author-notes.md），不从被测文件推导。
export type Obj = Record<string, unknown>;
const root = new URL('../../../../', import.meta.url);

export const textsFile = 'contracts/texts.default.json';
export const fundTermsFile = 'specs/fund-term-keys.yaml';
export const bannedWordsFile = 'specs/banned-words.yaml';
export const opsFile = 'contracts/enums/ops.yaml';

/** 分享中间页链接失效 / 不可用时的说明句。 */
export const invalidKey = 'share_page.invalid';
/** 分享中间页取价时间句（报价降级时显示，BR-PRICE-11）。 */
export const quoteKey = 'share_page.quote_time';
export const newKeys: readonly string[] = [invalidKey, quoteKey];

/**
 * 逐字取 08：
 * - 失效句：BR-ATTR-05 正文「中间页统一显示“分享链接已失效，请联系分享者重新分享”」，细则「别人的分享 link
 *   不可用」「H5 中间页按正文显示「分享链接已失效，请联系分享者重新分享」」。
 * - 取价时间句：BR-PRICE-11 正文「age_sec > 300 或 stale=true 时……显示「取价 HH:mm · 价格可能已变化，
 *   以下单页为准」（按 +08:00；不是当天则写 MM-DD HH:mm）」，HH:mm 换成变量 {time}。
 */
export const expectedTexts: Readonly<Record<string, string>> = {
  [invalidKey]: '分享链接已失效，请联系分享者重新分享',
  [quoteKey]: '取价 {time} · 价格可能已变化，以下单页为准',
};

/** BR-PRICE-11 细则「例」的降级显示原句（取价 09:30）。 */
export const quoteExample = '取价 09:30 · 价格可能已变化，以下单页为准';

/** F1-11a 暂借的两个键与它们在 SPEC_REF 时点的默认文案；它们仍归 App 内 LinkLanding 与钱包使用，本单不改。 */
export const borrowedTexts: Readonly<Record<string, string>> = {
  'link_landing.invalid': '链接已失效',
  'earnings.as_of': '统计截至 {time}',
};

/** 新键 → 它替换的暂借键。 */
export const replaces: Readonly<Record<string, string>> = {
  [invalidKey]: 'link_landing.invalid',
  [quoteKey]: 'earnings.as_of',
};

export function read(path: string): string {
  const file = new URL(path, root);
  // 文件缺失时在测试体内断言失败，不能让 ENOENT 冒充先红。
  expect(existsSync(file), `缺少文件 ${path}`).toBe(true);
  return readFileSync(file, 'utf8');
}

export function object(value: unknown, label = '值'): Obj {
  expect(value, `${label} 不能为 null`).not.toBeNull();
  expect(typeof value, `${label} 必须是对象`).toBe('object');
  expect(Array.isArray(value), `${label} 不能是数组`).toBe(false);
  return value as Obj;
}

export function list(value: unknown, label = '值'): unknown[] {
  expect(Array.isArray(value), `${label} 必须是数组`).toBe(true);
  return value as unknown[];
}

export function strings(value: unknown, label = '值'): string[] {
  const items = list(value, label);
  for (const item of items) expect(typeof item, `${label} 的元素必须是字符串`).toBe('string');
  return items as string[];
}

export function yaml(path: string): Obj {
  return object(parseYamlLite(read(path)), path);
}

/** contracts/texts.default.json 的 texts（保持文件里的键顺序）。 */
export function texts(): Obj {
  const doc = object(JSON.parse(read(textsFile)) as unknown, textsFile);
  return object(doc['texts'], `${textsFile} 的 texts`);
}

/** 全部文案转成字符串表，供 checkFundTermDoc 与 checkTextVariables 使用。 */
export function textMap(): Record<string, string> {
  return Object.fromEntries(Object.entries(texts()).map(([key, value]) => [key, String(value)]));
}

/** 文案取值：先断言是字符串，缺键时以断言失败变红。 */
export function text(key: string): string {
  const value = texts()[key];
  expect(typeof value, `${textsFile} 缺少 ${key}`).toBe('string');
  return value as string;
}

/** 两个新键都在字典里（缺一即断言失败）。 */
export function expectNewKeysPresent(): void {
  const dictionary = texts();
  for (const key of newKeys) {
    expect(Object.hasOwn(dictionary, key), `${textsFile} 缺少 ${key}`).toBe(true);
  }
}

export function fundTermKeys(): FundTermKeys {
  return yaml(fundTermsFile) as unknown as FundTermKeys;
}

export function segment(name: 'fund_terms' | 'ordinary'): Obj {
  return object(yaml(fundTermsFile)[name], `${fundTermsFile} 的 ${name}`);
}

export function exemptEntries(): Obj[] {
  return list(yaml(fundTermsFile)['exempt'], `${fundTermsFile} 的 exempt`).map((entry, i) =>
    object(entry, `exempt[${String(i)}]`),
  );
}

export function bannedWords(): BannedWord[] {
  return list(yaml(bannedWordsFile)['words'], `${bannedWordsFile} 的 words`) as BannedWord[];
}

/** contracts/enums/ops.yaml 的 notify_template_code 编码。 */
export function templateCodes(): string[] {
  const enums = object(yaml(opsFile)['enums'], `${opsFile} 的 enums`);
  const def = object(enums['notify_template_code'], 'notify_template_code');
  return Object.keys(object(def['values'], 'notify_template_code.values'));
}

/** 文案里的 {name} 变量名（按出现顺序，含重复）。 */
export function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] ?? '');
}
