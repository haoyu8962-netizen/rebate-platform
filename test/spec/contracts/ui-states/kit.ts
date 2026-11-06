import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect } from 'vitest';

// AC-CT-09s#n 是 D10-643 ⑤（UI-STATES 甲）验收点的本地分组，不新增业务 AC / BR。
// 独立预期只来自 SPEC_REF 的 08 BR-TEXT-14 表 C 与其后「通用状态键」小节、BR-TEXT-10 细则「金额缺失」、
// BR-TEXT-12 细则「资金术语键」，以及编排者定的 ui-states.yaml 结构；不从被测文件推导预期。
export type Obj = Record<string, unknown>;
const root = new URL('../../../../', import.meta.url);
const testRequire = createRequire(import.meta.url);
const { parseYamlLite } = testRequire('../../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};

export const statesFile = 'specs/ui-states.yaml';
export const textsFile = 'contracts/texts.default.json';
export const fundTermsFile = 'specs/fund-term-keys.yaml';

export const requiredNames = [
  'first_load',
  'load_failed',
  'load_failed_with_code',
  'read_timeout',
  'offline_no_cache',
  'offline_with_cache',
  'write_unknown',
  'value_missing',
  'value_missing_block',
  'empty',
  'page_maintenance',
  'platform_maintenance',
  'force_update',
] as const;

export const components = [
  'Skeleton',
  'LoadingProgress',
  'ErrorState',
  'EmptyState',
  'Toast',
  'NoticeBar',
  'ForceUpdate',
  'WebPage',
  'Inline',
];
export const errorKinds = ['load_failed', 'network', 'maintenance', 'custom'];
export const emphases = ['primary', 'secondary'];
export const announceModes = ['polite', 'assertive', 'none'];
export const retryModes = ['none', 'manual', 'auto_once_then_manual'];
export const idempotencies = ['same_key', 'n/a'];
export const rowFields = [
  'id',
  'name',
  'trigger',
  'component',
  'kind',
  'title_key',
  'desc_key',
  'actions',
  'announce',
  'retry',
  'timeout_ms',
  'on_timeout',
  'refs',
];
// 只有这两行的 desc_key 可以写模式串 error.<code>[.<reason>]。
export const patternRows = ['load_failed_with_code', 'platform_maintenance'];

// 08 BR-TEXT-14 表 C 七个 state.* 行的默认文案（逐字抄自 SPEC_REF 原文）。
export const stateTexts: Record<string, string> = {
  'state.loading': '加载中',
  'state.load_failed.title': '加载失败',
  'state.load_failed.desc': '内容没有加载出来，请重试',
  'state.timeout': '网络不稳定，请重试',
  'state.retry': '重试',
  'state.empty.default': '暂无内容',
  'state.value_missing.a11y': '暂时取不到',
};

export function read(path: string): string {
  const file = new URL(path, root);
  // 文件尚未建立时在测试体内断言失败，不能让 ENOENT 冒充先红。
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

export function yaml(path: string): Obj {
  return object(parseYamlLite(read(path)), path);
}

export function texts(): Obj {
  const doc = object(JSON.parse(read(textsFile)) as unknown, textsFile);
  return object(doc['texts'], `${textsFile} 的 texts`);
}

export function catalog(): Obj {
  return yaml(statesFile);
}

export function states(): Obj[] {
  const rows = list(catalog()['states'], 'states');
  expect(rows.length, 'states 不能为空').toBeGreaterThan(0);
  return rows.map((row, index) => object(row, `states[${index}]`));
}

export function row(name: string): Obj {
  const matches = states().filter((item) => item['name'] === name);
  expect(matches.length, `状态目录里 ${name} 必须恰好一行`).toBe(1);
  return matches[0] as Obj;
}

export function actions(item: Obj): Obj[] {
  return list(item['actions'], `${String(item['name'])}.actions`).map((action, index) =>
    object(action, `${String(item['name'])}.actions[${index}]`),
  );
}

export function announce(item: Obj): Obj {
  return object(item['announce'], `${String(item['name'])}.announce`);
}

export function retry(item: Obj): Obj {
  return object(item['retry'], `${String(item['name'])}.retry`);
}

/** 行里出现的全部文案键（含模式串），按 title_key、desc_key、actions[].key、announce.key 的顺序。 */
export function keysOf(item: Obj): unknown[] {
  return [
    item['title_key'],
    item['desc_key'],
    ...actions(item).map((action) => action['key']),
    announce(item)['key'],
  ].filter((key) => key !== null);
}

/** 标题或说明里的文案键（不含按钮与读屏）。 */
export function textKeysOf(item: Obj): unknown[] {
  return [item['title_key'], item['desc_key']].filter((key) => key !== null);
}

export function isPattern(key: string): boolean {
  return key.includes('<') || key.includes('[');
}
