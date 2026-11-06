import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect } from 'vitest';

// CT-26w（D10-745，F1-01x 前置）：H5 八个页面标题键。独立预期只来自 SPEC_REF 的 08 BR-TEXT-13 原文
// （禁用词与匹配规则）、BR-TEXT-12 细则「资金术语键」（已有前缀覆盖的新键照前缀）与编排者说明；
// 标题取值 08 还没登记，这里不钉。不从被测文件推导预期。
export type Obj = Record<string, unknown>;
const root = new URL('../../../../', import.meta.url);
const testRequire = createRequire(import.meta.url);
const { parseYamlLite } = testRequire('../../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};

export const textsFile = 'contracts/texts.default.json';
export const fundTermsFile = 'specs/fund-term-keys.yaml';

/** 编排者说明列的八个新键（contracts/texts.default.json 的 texts 段）。 */
export const pageTitleKeys = [
  'find_order.title',
  'ledger.title',
  'messages.title',
  'invite.title',
  'rules.title',
  'help.title',
  'notice.title',
  'agreement.title',
] as const;

/**
 * 08 BR-TEXT-12 细则：新键已有前缀覆盖的照前缀；`ledger.` 是 fund_terms 的前缀（08 原文列出），
 * 故 ledger.title 归 fund_terms，其余七个是页面名、无前缀覆盖，归 ordinary（编排者说明）。
 */
export const fundTermPageTitleKeys = ['ledger.title'] as const;
export const ordinaryPageTitleKeys = pageTitleKeys.filter(
  (key) => !(fundTermPageTitleKeys as readonly string[]).includes(key),
);

/** 08 BR-TEXT-14 表 C 已有的收益看板标题，本任务不动。 */
export const earningsTitle = { key: 'earnings.title', value: '收益看板' } as const;

/**
 * 08 BR-TEXT-13 原文逐词抄录的禁用词（任务书第 2 节，不自行扩充）。
 * 「比价」只允许出现在 allow_keys 所列字段，这八个键不在其列，按禁用处理。
 */
export const bannedWords = [
  // 价格与返利类
  '全网最低',
  '历史最低',
  '最低价',
  '最便宜',
  '最高返利',
  '稳赚',
  '必返',
  '返利最高',
  '最高返',
  '原价',
  // 榜单类
  '高佣',
  '收益榜',
  // 资金类
  '返利到账',
  '佣金',
  '待结算',
  '结算中',
  '返现',
  '充值',
  '备付金',
  // 只许 allow_keys 字段
  '比价',
] as const;

/**
 * BR-TEXT-13 匹配前的归一化：NFKC，去掉默认可忽略字符、组合附加符（类别 M 全部）、空白、标点、符号、
 * 格式字符（含零宽），英文转小写。只用于匹配。
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\p{Default_Ignorable_Code_Point}\p{M}\p{White_Space}\p{Z}\p{P}\p{S}\p{Cf}]/gu, '')
    .toLowerCase();
}

export function read(path: string): string {
  const file = new URL(path, root);
  // 文件不存在时在测试体内断言失败，不能让 ENOENT 冒充先红。
  expect(existsSync(file), `缺少契约文件 ${path}`).toBe(true);
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

export function texts(): Obj {
  const doc = object(JSON.parse(read(textsFile)) as unknown, textsFile);
  return object(doc['texts'], `${textsFile} 的 texts`);
}

/** texts 段里 key 的默认文案：必须存在且是字符串。 */
export function text(key: string): string {
  const dictionary = texts();
  expect(Object.hasOwn(dictionary, key), `${textsFile} 缺少 ${key}`).toBe(true);
  const value = dictionary[key];
  expect(typeof value, `${key} 的默认文案必须是字符串`).toBe('string');
  return value as string;
}

export type Segment = { prefixes: string[]; keys: string[] };

export function segment(name: 'fund_terms' | 'ordinary'): Segment {
  const doc = object(parseYamlLite(read(fundTermsFile)), fundTermsFile);
  const part = object(doc[name], `${fundTermsFile} 的 ${name}`);
  const prefixes = list(part['prefixes'], `${name}.prefixes`).map(String);
  const keys = list(part['keys'], `${name}.keys`).map(String);
  return { prefixes, keys };
}

/** 前缀或单列命中（fund-term-keys.yaml 文件头的规则）。 */
export function hits(part: Segment, key: string): boolean {
  return part.keys.includes(key) || part.prefixes.some((prefix) => key.startsWith(prefix));
}
