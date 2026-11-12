import { existsSync, readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { BannedWord } from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import type { FundTermKeys } from '../../../../packages/contracts-ts/scripts/fund-term-keys.ts';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

// AC-CT-26zn#n 是本任务（编排裁定 D10-1315 ②(a)、D10-1354）验收点的本地分组，不新增业务 AC / BR。
// 预期只取自 SPEC_REF 62b5c99338f8 时点 08 BR-TEXT-14 表 C 第八批 15 行与 BR-TEXT-12 细则的原句
// （见 author-notes.md），不从被测文件推导。
export type Obj = Record<string, unknown>;
const root = new URL('../../../../', import.meta.url);

export const textsFile = 'contracts/texts.default.json';
export const fundTermsFile = 'specs/fund-term-keys.yaml';
export const bannedWordsFile = 'specs/banned-words.yaml';
export const opsFile = 'contracts/enums/ops.yaml';

/** 表 C 一行：`keys` 逐字取「场景」列里的键名写法，`line` 逐字取「文案」列（「｜」分隔，与键一一对应）。 */
export type TableRow = { readonly scene: string; readonly keys: string; readonly line: string };

/** BR-TEXT-14 表 C 第八批（2026-11-12 补登，D10-1315）的 15 行，顺序同 08。 */
export const tableRows: readonly TableRow[] = [
  {
    scene: 'AI 助手·对话页骨架',
    keys: 'agent.new_chat / agent.examples_title / agent.chip.orders / agent.input_placeholder / agent.stop',
    line: '新对话｜你可以这样问我｜查订单｜说说想买什么，或粘贴商品链接｜停止',
  },
  {
    scene: 'AI 助手·生成中与断线',
    keys: 'agent.streaming_hint / agent.disconnected / agent.disconnected_hint',
    line: '还在生成，其他商品查到后会继续显示｜连接中断｜已生成的内容保留在上面，点「重试」继续查询',
  },
  {
    scene: 'AI 助手·次数用完',
    keys: 'agent.quota.guest_hint / .phone_hint / .input_disabled',
    line: '登录并绑定手机号后，每天可以多问几次。｜绑定手机号后，每天可以多问几次。｜今日次数已用完，明天恢复',
  },
  {
    scene: 'AI 助手·去搜索',
    keys: 'agent.search / agent.search_q / agent.search_hint',
    line: '去搜索｜去搜索「{q}」｜会带上你这次输入的关键词，到搜索页继续找。',
  },
  {
    scene: 'AI 助手·登录与绑手机按钮',
    keys: 'agent.login / agent.bind_phone',
    line: '登录｜绑定手机号',
  },
  {
    scene: 'AI 助手·举报',
    keys: 'agent.report.title / .subtitle / .supplement / .submit / .reported / .toast',
    line: '举报这条回复｜选择原因后提交，我们会核实处理｜补充说明（选填）｜提交举报｜已举报｜举报已提交，我们会核实处理',
  },
  {
    scene: 'AI 助手·收益卡更新时间',
    keys: 'agent.earnings.updated_at',
    line: '更新于 {time}',
  },
  {
    scene: 'AI 助手·找回草稿卡订单号标签',
    keys: 'agent.card.claim_draft.order_no',
    line: '订单号',
  },
  {
    scene: 'AI 助手·规划已有叫法的界面字',
    keys: 'agent.back_to_bottom / agent.context.product / agent.context.order / agent.refresh_batch / agent.coupon_gone / agent.rule.view / agent.report.entry',
    line: '回到底部｜关于这个商品｜关于这笔订单｜换一批｜这个券已领完｜查看完整规则｜举报',
  },
  {
    scene: 'AI 助手·举报原因的预设选项',
    keys: 'agent.report.reason.misleading / .illegal / .vulgar / .infringe / .other',
    line: '内容不实或有误导｜含违法违规内容｜含低俗、冒犯内容｜侵犯他人权益｜其他问题',
  },
  {
    scene: 'AI 助手·输入与发送',
    keys: 'agent.send / agent.too_long',
    line: '发送｜最多输入 500 字',
  },
  {
    scene: 'AI 助手·停止与回复状态',
    keys: 'agent.stopping / agent.stopped / agent.cancelled / agent.limited / agent.incomplete',
    line: '正在停止｜已停止｜已停止生成｜回复内容过长，后面的内容不再显示｜这条回复不完整，正在重新获取',
  },
  {
    scene: 'AI 助手·历史消息与刷新',
    keys: 'agent.history.earlier / .none / .failed、agent.refresh',
    line: '加载更早的消息｜没有更早的消息｜加载失败，点此重试｜刷新',
  },
  {
    scene: 'AI 助手·卡片标签与未开放说明',
    keys: 'agent.order.title / agent.unavailable_hint',
    line: '订单｜可以先用搜索找货。',
  },
  {
    scene: 'AI 助手·举报半屏的校验与操作失败',
    keys: 'agent.report.too_long / .reason_error / .close、agent.action_failed',
    line: '补充说明太长了，请删减后再提交｜请重新选择举报原因｜关闭｜操作没有成功，请稍后再试',
  },
];

/**
 * 展开「场景」列的键名写法：键之间用「 / 」或「、」分隔；以「.」开头的 `.d` 沿用前一个键的前缀
 * （前一个键到最后一个「.」为止，`a.b.c / .d` → `a.b.d`）。
 */
export function expandKeys(spec: string): string[] {
  const out: string[] = [];
  for (const raw of spec.split(/ \/ |、/)) {
    const token = raw.trim();
    if (token.startsWith('.')) {
      const previous = out[out.length - 1] ?? '';
      expect(previous, `「${spec}」里的 ${token} 前面要有完整键`).not.toBe('');
      out.push(previous.slice(0, previous.lastIndexOf('.')) + token);
    } else {
      out.push(token);
    }
  }
  return out;
}

/** 按表 C 逐行展开得到的「键 → 文案」，与「｜」分隔的句子一一对应。 */
export function expectedEntries(): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const row of tableRows) {
    const keys = expandKeys(row.keys);
    const parts = row.line.split('｜');
    expect(parts.length, `表 C「${row.scene}」键数与句数要相等`).toBe(keys.length);
    keys.forEach((key, i) => entries.push([key, parts[i] ?? '']));
  }
  return entries;
}

/** 收益卡更新时间：在 agent.earnings. 前缀内，归资金术语（BR-TEXT-12 细则）。 */
export const updatedAtKey = 'agent.earnings.updated_at';
/** 资金术语段已有的前缀（BR-TEXT-12 细则 2026-10-05 补：agent.earnings.）。 */
export const earningsPrefix = 'agent.earnings.';
/** 去搜索「{q}」。 */
export const searchQKey = 'agent.search_q';

/** BR-TEXT-12 细则逐键写明归普通的 52 个键，顺序同 08。 */
export const ordinaryKeys: readonly string[] = [
  'agent.new_chat',
  'agent.examples_title',
  'agent.chip.orders',
  'agent.input_placeholder',
  'agent.stop',
  'agent.streaming_hint',
  'agent.disconnected',
  'agent.disconnected_hint',
  'agent.quota.guest_hint',
  'agent.quota.phone_hint',
  'agent.quota.input_disabled',
  'agent.search',
  'agent.search_q',
  'agent.search_hint',
  'agent.login',
  'agent.bind_phone',
  'agent.report.title',
  'agent.report.subtitle',
  'agent.report.supplement',
  'agent.report.submit',
  'agent.report.reported',
  'agent.report.toast',
  'agent.report.entry',
  'agent.report.reason.misleading',
  'agent.report.reason.illegal',
  'agent.report.reason.vulgar',
  'agent.report.reason.infringe',
  'agent.report.reason.other',
  'agent.report.too_long',
  'agent.report.reason_error',
  'agent.report.close',
  'agent.card.claim_draft.order_no',
  'agent.back_to_bottom',
  'agent.context.product',
  'agent.context.order',
  'agent.refresh_batch',
  'agent.coupon_gone',
  'agent.rule.view',
  'agent.send',
  'agent.too_long',
  'agent.stopping',
  'agent.stopped',
  'agent.cancelled',
  'agent.limited',
  'agent.incomplete',
  'agent.history.earlier',
  'agent.history.none',
  'agent.history.failed',
  'agent.refresh',
  'agent.order.title',
  'agent.unavailable_hint',
  'agent.action_failed',
];

/** 本批全部 53 个键（52 个普通 + agent.earnings.updated_at）。 */
export const newKeys: readonly string[] = [...ordinaryKeys, updatedAtKey];

/** 找回草稿卡上已归普通的其余键（「同卡其余键已归普通」），本单不改它们的归类。 */
export const claimDraftSiblings: readonly string[] = [
  'agent.card.claim_draft.open_times',
  'agent.card.claim_draft.paid_date',
  'agent.card.claim_draft.submit',
  'agent.card.claim_draft.title',
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

/** 53 个新键都在字典里（缺键即断言失败，列出全部缺的键）。 */
export function expectNewKeysPresent(): void {
  const dictionary = texts();
  const missing = newKeys.filter((key) => !Object.hasOwn(dictionary, key));
  expect(missing, `${textsFile} 缺少这些键`).toEqual([]);
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
