import { existsSync, readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import type {
  BannedWord,
  FundTermKeys,
} from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';

// AC-CT-24zy#n 是 CT-24zy（编排裁定 D10-882、couli #299）验收点的本地分组，不新增业务 AC / BR。
// 预期只来自 SPEC_REF 7666a46 的规划原文（行号指 规划/08_业务规则/12_TEXT_话术与格式.md，另注明的除外）
// 与 SPEC_REF 时点的契约现值；不从被测文件推导预期。
// 拼法（BR-TEXT-22 :1677）：「{BR-TEXT-02 状态文案或 BR-TEXT-05 标题}，详情见卡片。」。
// BR-AI-07（08_AI :313）引文里的句子都不带句末「。」（REFUND、order_list.summary 同样），
// 措辞与标点以 BR-TEXT-22 为准（BR-AI-07「包内默认与单独措辞维护在 BR-TEXT-22」）。
export type Obj = Record<string, unknown>;
const root = new URL('../../../../', import.meta.url);

export const textsFile = 'contracts/texts.default.json';
export const orderEnumsFile = 'contracts/enums/order.yaml';
export const bannedWordsFile = 'specs/banned-words.yaml';
export const fundTermsFile = 'specs/fund-term-keys.yaml';

const SUFFIX = '，详情见卡片。';

/** SPEC_REF 时点 contracts/enums/order.yaml 的 order_reason 全部 16 码，按文件顺序。 */
export const reasonCodes = [
  'REFUND',
  'RIGHTS',
  'PUNISH',
  'PRESALE_UNPAID',
  'COMMISSION_ZERO',
  'OTHER',
  'BLACKLIST',
  'PART_REFUND',
  'PRICE_COMPARE',
  'PRICE_PROTECT',
  'SETTLE_DIFF',
  'NOT_TRACKED',
  'EXPIRED_CLICK',
  'OTHER_TLJ',
  'RELATION_INVALID',
  'CANCELLED',
] as const;

/** SPEC_REF 时点 contracts/enums/order.yaml 的 display_status 全部 11 个值，按文件顺序。 */
export const displayStatuses = [
  'PAID',
  'DEPOSIT_PAID',
  'WAITING',
  'CREDITING',
  'REVIEWING',
  'RIGHTS_PENDING',
  'CREDITED',
  'CREDITED_PART_CLAWED',
  'NO_REBATE',
  'INVALID',
  'CLAWED_BACK',
] as const;

/** 本单之前已有的三条 summary（BR-TEXT-22 :1669–1671），本单不改。 */
export const previousSummaries: Record<string, string> = {
  'order_status.PAID.summary': '订单已跟踪到，确认收货后随联盟月度结算，详情见卡片。',
  'order_status.WAITING.summary': '已收货，等待联盟结算，预计结算月份见卡片。',
  'order_status.CREDITED.summary': '这笔返利已结算，可以去钱包提现，详情见卡片。',
};

export const reasonKey = (code: string): string => `order_reason.${code}.summary`;
export const statusKey = (status: string): string => `order_status.${status}.summary`;

/** 本单要新增的 24 个键：order_reason 16 码 + display_status 缺的 8 个。 */
export const newKeys: readonly string[] = [
  ...reasonCodes.map(reasonKey),
  ...displayStatuses.map(statusKey).filter((key) => !Object.hasOwn(previousSummaries, key)),
];

/**
 * order_reason.PRICE_COMPARE.summary：编排 D10-941 已定（选 a）——照 BR-TEXT-22 :1677 拼法取
 * 「比价订单，详情见卡片。」，并把本键加进 specs/banned-words.yaml「比价」条目的 allow_keys
 * （BR-TEXT-13 :810；写法同 agent.disclaimer.commission 例外键），禁用词检查照常执行、放行后应为空。
 */
export const priceCompareKey = reasonKey('PRICE_COMPARE');

/** 「比价」条目在本单之前已有的 7 个 allow_keys（SPEC_REF 时点的 specs/banned-words.yaml），只增不删。 */
export const previousPriceCompareAllowKeys: readonly string[] = [
  'order_reason.PRICE_COMPARE.title',
  'order_reason.PRICE_COMPARE.desc',
  'order_status.PAID.hint.price_compare',
  'no_rebate.price_compare',
  'no_rebate.price_compare.confirm',
  'order.price_compare.hint',
  'order.tag.price_compare',
];

/**
 * 逐字期望表：键 → [取值, 来源]。取值按拼法从规划原文算出，例外单列。
 */
export const expected: Record<string, readonly [string, string]> = {
  // order_reason：BR-TEXT-05 原因码表「标题（默认）」列 + 拼法。
  [reasonKey('REFUND')]: [`订单已退款或取消${SUFFIX}`, 'BR-TEXT-05 :457；BR-TEXT-22 :1677 例'],
  [reasonKey('RIGHTS')]: [`发起售后维权，返利取消${SUFFIX}`, 'BR-TEXT-05 :459'],
  [reasonKey('PUNISH')]: [`订单被联盟判定违规${SUFFIX}`, 'BR-TEXT-05 :460'],
  [reasonKey('PRESALE_UNPAID')]: [`预售尾款未付${SUFFIX}`, 'BR-TEXT-05 :469'],
  [reasonKey('COMMISSION_ZERO')]: [`返利已取消${SUFFIX}`, 'BR-TEXT-05 :470'],
  [reasonKey('OTHER')]: [`其他原因${SUFFIX}`, 'BR-TEXT-05 :471'],
  [reasonKey('BLACKLIST')]: [`订单未通过安全校验${SUFFIX}`, 'BR-TEXT-05 :468'],
  [reasonKey('PART_REFUND')]: [`部分退款${SUFFIX}`, 'BR-TEXT-05 :458'],
  // 「比价」由 banned-words.yaml allow_keys 放行本键（D10-941）。
  [reasonKey('PRICE_COMPARE')]: [`比价订单${SUFFIX}`, 'BR-TEXT-05 :461；BR-TEXT-22 :1677；D10-941'],
  [reasonKey('PRICE_PROTECT')]: [`商家价保退差${SUFFIX}`, 'BR-TEXT-05 :462'],
  [reasonKey('SETTLE_DIFF')]: [`结算金额调整${SUFFIX}`, 'BR-TEXT-05 :463'],
  // BR-AI-07 默认句（08_AI :313「未找到这笔订单的返利记录，详情见卡片」），句末「。」按 BR-TEXT-22 :1677。
  [reasonKey('NOT_TRACKED')]: [
    `未找到这笔订单的返利记录${SUFFIX}`,
    'BR-TEXT-05 :464；08_AI BR-AI-07 :313；BR-TEXT-22 :1677',
  ],
  // 说明列带 {click_valid_days}，标题不带变量，照拼法。
  [reasonKey('EXPIRED_CLICK')]: [`下单时链接已过期${SUFFIX}`, 'BR-TEXT-05 :465'],
  [reasonKey('OTHER_TLJ')]: [`订单归其他推广者${SUFFIX}`, 'BR-TEXT-05 :467'],
  [reasonKey('RELATION_INVALID')]: [`淘宝授权未完成或已失效${SUFFIX}`, 'BR-TEXT-05 :466'],
  // 契约码（待定、启用前不写入），旧编码 CANCELLED → REFUND（BR-TEXT-05 :497），与 REFUND 同值（D10-882 ②）。
  [reasonKey('CANCELLED')]: [`订单已退款或取消${SUFFIX}`, 'BR-TEXT-05 :497；D10-882 ②'],
  // order_status：BR-TEXT-02 映射表「状态文案」列 + 拼法。
  [statusKey('DEPOSIT_PAID')]: [`已付定金${SUFFIX}`, 'BR-TEXT-02 :287'],
  [statusKey('CREDITING')]: [`入账核对中${SUFFIX}`, 'BR-TEXT-02 :290'],
  [statusKey('RIGHTS_PENDING')]: [`售后处理中，入账暂停${SUFFIX}`, 'BR-TEXT-02 :291'],
  [statusKey('REVIEWING')]: [`入账核对中${SUFFIX}`, 'BR-TEXT-02 :292'],
  [statusKey('NO_REBATE')]: [`本单无返利${SUFFIX}`, 'BR-TEXT-02 :293'],
  // 状态文案「已结算（部分扣回 {z}）」带金额变量，不套拼法，单列（BR-TEXT-22 :1672，D10-882，#299）。
  [statusKey('CREDITED_PART_CLAWED')]: [
    '这笔返利已结算，其中部分已扣回，详情见卡片。',
    'BR-TEXT-22 :1672；BR-TEXT-02 :295',
  ],
  [statusKey('INVALID')]: [`已失效${SUFFIX}`, 'BR-TEXT-02 :296'],
  [statusKey('CLAWED_BACK')]: [`已扣回${SUFFIX}`, 'BR-TEXT-02 :297'],
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

export function texts(): Obj {
  const doc = object(JSON.parse(read(textsFile)) as unknown, textsFile);
  return object(doc['texts'], `${textsFile} 的 texts`);
}

/** 文案取值：先断言是字符串，缺键时以断言失败变红。 */
export function text(key: string): string {
  const value = texts()[key];
  expect(typeof value, `${textsFile} 缺少 ${key}`).toBe('string');
  return value as string;
}

/** contracts/enums/order.yaml 某枚举的值列表（保持文件顺序）。 */
export function enumValues(name: string): string[] {
  const doc = object(parseYamlLite(read(orderEnumsFile)), orderEnumsFile);
  const enums = object(doc['enums'], `${orderEnumsFile} 的 enums`);
  const def = object(enums[name], name);
  return Object.keys(object(def['values'], `${name}.values`));
}

export function bannedWords(): BannedWord[] {
  const doc = object(parseYamlLite(read(bannedWordsFile)), bannedWordsFile);
  expect(Array.isArray(doc['words']), `${bannedWordsFile} 的 words 必须是数组`).toBe(true);
  return doc['words'] as BannedWord[];
}

export function fundTermKeys(): FundTermKeys {
  return object(parseYamlLite(read(fundTermsFile)), fundTermsFile) as unknown as FundTermKeys;
}
