import { existsSync, readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { BannedWord } from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import type { FundTermKeys } from '../../../../packages/contracts-ts/scripts/fund-term-keys.ts';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

// AC-CT-26zk#n 是本任务（编排裁定 D10-1248 ⑨、D10-1275 / D10-1276）验收点的本地分组，不新增业务 AC / BR。
// 预期只取自 SPEC_REF fd92f360e7b8 时点 08 BR-TEXT-14 表 C 与 BR-TEXT-12 细则的原句（见 author-notes.md），
// 不从被测文件推导。
export type Obj = Record<string, unknown>;
const root = new URL('../../../../', import.meta.url);

export const textsFile = 'contracts/texts.default.json';
export const fundTermsFile = 'specs/fund-term-keys.yaml';
export const bannedWordsFile = 'specs/banned-words.yaml';
export const opsFile = 'contracts/enums/ops.yaml';

/** 订单行复制按钮看得见的按钮文字。 */
export const labelKey = 'order_list.copy_label';
/** 订单行复制按钮的读屏名称，{no} 为本行完整订单号 order_no。 */
export const spokenKey = 'order_list.copy_spoken';
export const newKeys: readonly string[] = [labelKey, spokenKey];

/** BR-TEXT-14 表 C「订单行的复制按钮」行的文案列「复制｜复制订单号 {no}」，「｜」两侧依次是两键。 */
export const expectedTexts: Readonly<Record<string, string>> = {
  [labelKey]: '复制',
  [spokenKey]: '复制订单号 {no}',
};

/** 复制成功的提示仍用这个已有键（同一行「动作」列），本单不改。 */
export const doneKey = 'order_detail.copy.done';
export const doneText = '已复制订单号';

/** 几种完整订单号样例（淘宝 / 京东纯数字、拼多多带连字符），代入后须原样出现、不缩写不脱敏。 */
export const sampleOrderNos: readonly string[] = [
  '3721946850123456789',
  '298765432101',
  '250918-123456789012345',
];

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
