import { existsSync, readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

// AC-CT-26za#n 是编排裁定 D10-773（本单 A 的部分）验收点的本地分组，不新增业务 AC / BR。
// 独立预期只来自任务书 9.2 的逐字定案与 SPEC_REF 时点的现有契约值（CLAWBACK 先例）；不从被测文件推导预期。
export type Obj = Record<string, unknown>;
const root = new URL('../../../../', import.meta.url);

export const opsFile = 'contracts/enums/ops.yaml';
export const textsFile = 'contracts/texts.default.json';
export const fundTermsFile = 'specs/fund-term-keys.yaml';
export const bannedWordsFile = 'specs/banned-words.yaml';

export const code = 'SETTLE_ADJUSTED';
export const codeLabel = '结算调整（入账后结算负差调减）';

/** 本单之前 notify_template_code 的全部值，按文件顺序（SPEC_REF 时点的 contracts/enums/ops.yaml）。 */
export const previousCodes = [
  'ORDER_TRACKED',
  'ORDER_INVALID',
  'CREDITED',
  'CLAWBACK',
  'WD_SUCCESS',
  'WD_REJECTED',
  'WD_FAILED',
  'WD_OVERDUE',
  'CLAIM_RESULT',
  'RISK_STATE_CHANGED',
  'APPEAL_RESULT',
  'DELETION_PROGRESS',
  'BALANCE_ADJUSTED',
  'SMS_CODE',
  'UNION_AUTH_EXPIRING',
  'UNION_AUTH_EXPIRED',
  'DATA_COPY_READY',
  'DATA_COPY_CODE',
];

/** 9.2-2：三个站内信短标题，逐字。 */
export const titles: Record<string, string> = {
  'inbox.title.SETTLE_ADJUSTED.self': '返利已调整',
  'inbox.title.SETTLE_ADJUSTED.share': '推广收益已调整',
  'inbox.title.SETTLE_ADJUSTED.invite': '邀请奖励已调整',
};

/** 本单之前 texts.default.json 的全部 inbox.title.* 键与值，本单一个不改、不删。 */
export const previousInboxTitles: Record<string, string> = {
  'inbox.title.APPEAL_RESULT': '申诉结果',
  'inbox.title.BALANCE_ADJUSTED': '余额调整',
  'inbox.title.CLAIM_RESULT': '找回结果',
  'inbox.title.CLAWBACK.promo': '推广收益扣回',
  'inbox.title.CLAWBACK.self': '返利扣回',
  'inbox.title.CREDITED.mixed': '收益结算',
  'inbox.title.CREDITED.promo': '推广收益结算',
  'inbox.title.CREDITED.self': '返利结算',
  'inbox.title.DELETION_PROGRESS': '注销进度',
  'inbox.title.ORDER_INVALID.invite': '邀请订单失效',
  'inbox.title.ORDER_INVALID.self': '订单失效',
  'inbox.title.ORDER_INVALID.share': '分享订单失效',
  'inbox.title.ORDER_TRACKED.invite': '邀请订单',
  'inbox.title.ORDER_TRACKED.self': '跟单成功',
  'inbox.title.ORDER_TRACKED.share': '分享订单',
  'inbox.title.RISK_STATE_CHANGED': '账号状态',
  'inbox.title.WD_FAILED': '提现打款未成功',
  'inbox.title.WD_OVERDUE': '提现审核中',
  'inbox.title.WD_REJECTED': '提现未通过',
  'inbox.title.WD_SUCCESS': '提现到账',
};

/** 本单之前 fund_terms.notify_templates，按文件顺序。 */
export const previousFundTemplates = [
  'ORDER_TRACKED',
  'ORDER_INVALID',
  'CREDITED',
  'CLAWBACK',
  'WD_SUCCESS',
  'WD_REJECTED',
  'WD_FAILED',
  'CLAIM_RESULT',
  'WD_OVERDUE',
  'BALANCE_ADJUSTED',
  'RISK_STATE_CHANGED',
  'APPEAL_RESULT',
  'DELETION_PROGRESS',
];

/** ordinary.notify_templates 本单不变。 */
export const ordinaryTemplates = [
  'SMS_CODE',
  'UNION_AUTH_EXPIRING',
  'UNION_AUTH_EXPIRED',
  'DATA_COPY_READY',
  'DATA_COPY_CODE',
];

export function read(path: string): string {
  const file = new URL(path, root);
  // 文件缺失时在测试体内断言失败，不能让 ENOENT 冒充先红。
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

export function strings(value: unknown, label = '值'): string[] {
  const items = list(value, label);
  for (const item of items) expect(typeof item, `${label} 的元素必须是字符串`).toBe('string');
  return items as string[];
}

export function yaml(path: string): Obj {
  return object(parseYamlLite(read(path)), path);
}

/** contracts/enums/ops.yaml 的 notify_template_code.values（编码 → 中文名，保持文件顺序）。 */
export function templateValues(): Obj {
  const enums = object(yaml(opsFile)['enums'], `${opsFile} 的 enums`);
  const def = object(enums['notify_template_code'], 'notify_template_code');
  return object(def['values'], 'notify_template_code.values');
}

export function texts(): Record<string, unknown> {
  const doc = object(JSON.parse(read(textsFile)) as unknown, textsFile);
  return object(doc['texts'], `${textsFile} 的 texts`);
}

/** 文案取值：先断言是字符串，缺键时以断言失败变红。 */
export function text(key: string): string {
  const value = texts()[key];
  expect(typeof value, `${textsFile} 缺少 ${key}`).toBe('string');
  return value as string;
}

export function segment(name: 'fund_terms' | 'ordinary'): Obj {
  return object(yaml(fundTermsFile)[name], `${fundTermsFile} 的 ${name}`);
}

/** 断言 SETTLE_ADJUSTED 在列表里恰好一次、紧随 CLAWBACK，且原有值保持原相对顺序。 */
export function expectInserted(values: readonly string[], previous: readonly string[]): void {
  expect(
    values.filter((value) => value === code),
    `${code} 必须恰好出现一次`,
  ).toHaveLength(1);
  expect(values[values.indexOf('CLAWBACK') + 1], `${code} 必须紧随 CLAWBACK`).toBe(code);
  expect(
    values.filter((value) => previous.includes(value)),
    '原有值一个不少、相对顺序不变',
  ).toEqual(previous);
}
