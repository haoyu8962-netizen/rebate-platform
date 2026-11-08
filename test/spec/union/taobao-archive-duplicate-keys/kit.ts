// B1-04zgb（FU-TB-ARCHIVE-EDGE ①，B1-04zzc 只读复核 S2 ①；规划变更 20261031-淘宝订单经大淘客 §1「不入库别家
// 订单」）：淘宝订单详情 / 违规 / 维权的归档改写原先只看 JSON.parse 后的树——树里没有可删的行就整页原样存。
// 上游正文若在同一对象里出现重复键，JSON.parse 取最后一份；被覆盖的那一份（可能装着别家行）随原文进了归档。
// 新行为：正文任一层任一对象有重复键时，归档存按 JSON.parse 语义（后出现者胜）重新序列化、再按各自口径过滤的
// 报文——被覆盖那一份的内容与重复键本身都不在 gunzip 后的 payload 里；数字原文、外层字段、读不出推广位 / 单号的
// 行照旧。
// 本目录的小工具：手写 JSON 文本的拼装（重复键报文只能手写，JSON.stringify 生成不出）、重复键检测、「这些串一个
// 也不在」断言。装配、归档表与行夹具只读复用 taobao-order-archive/kit.ts、taobao-refunds/kit.ts、
// taobao-refund-archive/kit.ts（不改）。订单行的数字用 taobao-orders 那套 WireNumber，违规 / 维权行用
// taobao-refunds 那套，两套 jsonText 不能混用，所以这里分 order* / afterSales* 两组。
// 报文与推广位、单号全部合成，不读任何录制。
// Task-local AC labels ([AC-B1-04zgb#n]) identify this task's acceptance points, not business rules.
import { expect } from 'vitest';
import { jsonText } from '../taobao-order-archive/kit.ts';
import { jsonText as afterSalesJson, num, positionOf, punishData } from '../taobao-refunds/kit.ts';

// ---------------------------------------------------------------------------------------------
// 手写 JSON 文本（带空白，便于同时钉住「正常报文逐字节原样」）
// ---------------------------------------------------------------------------------------------

/** One hand-written member `"name": value`; `value` is JSON text, `name` is written verbatim. */
export function member(name: string, value: string): string {
  return `"${name}": ${value}`;
}

/** A hand-written JSON object of `members` (duplicates kept as written). */
export function object(...members: readonly string[]): string {
  return `{ ${members.join(', ')} }`;
}

/** A hand-written JSON array of `items` (each JSON text). */
export function array(...items: readonly string[]): string {
  return `[ ${items.join(', ')} ]`;
}

/** A JSON string literal of plain text (no quote or backslash in it). */
export function str(text: string): string {
  expect(/["\\]/.test(text), 'str() takes plain text only').toBe(false);
  return `"${text}"`;
}

/** `text` (a non-empty JSON object) with `extra` hand-written members appended after its own. */
function appended(text: string, extra: readonly string[]): string {
  expect(text.startsWith('{') && text.endsWith('}') && text !== '{}', 'a non-empty object').toBe(
    true,
  );
  return `${text.slice(0, -1)}, ${extra.join(', ')} }`;
}

/**
 * The JSON text of an order fixture row (taobao-orders kit: number literals as written) with
 * `extra` hand-written members appended after its own: a later duplicate wins under JSON.parse.
 */
export function orderRowWith(
  row: Readonly<Record<string, unknown>>,
  ...extra: readonly string[]
): string {
  return appended(jsonText(row), extra);
}

/** Like orderRowWith, for a punishment / refund fixture row (taobao-refunds kit numbers). */
export function afterSalesRowWith(
  row: Readonly<Record<string, unknown>>,
  ...extra: readonly string[]
): string {
  return appended(afterSalesJson(row), extra);
}

/** The order position_index taobao-orders/kit.ts pageData gives by default. */
export const ORDER_POSITION = '1793300000_SYNa0|1793300001_SYNb0';

/** The outer members of an order body as taobao-order-archive/kit.ts orderBody writes them. */
export function orderEnvelope(...members: readonly string[]): string {
  return object(
    member('time', '1793600000000'),
    member('code', '0'),
    member('msg', str('成功')),
    ...members,
  );
}

/** An order page's data object: pageData's page members, then `members` (results …). */
export function orderDataText(...members: readonly string[]): string {
  return object(
    member('has_next', 'false'),
    member('has_pre', 'false'),
    member('page_no', '1'),
    member('page_size', '100'),
    member('position_index', str(ORDER_POSITION)),
    ...members,
  );
}

/** `{ "publisher_order_dto": [rows] }` (rows are JSON texts). */
export function dtoList(...rows: readonly string[]): string {
  return object(member('publisher_order_dto', array(...rows)));
}

/** The outer members of a punishment / refund body (time 1793433600000, as the frozen kits). */
export function afterSalesEnvelope(...members: readonly string[]): string {
  return object(
    member('time', '1793433600000'),
    member('code', '0'),
    member('msg', str('成功')),
    ...members,
  );
}

/** A punishment page's data object: punishData's page_no / page_size, then `members`. */
export function punishDataText(...members: readonly string[]): string {
  return object(member('page_no', '1'), member('page_size', '10'), ...members);
}

/** A refund page's data object: refundData's page members (default position), then `members`. */
export function refundDataText(...members: readonly string[]): string {
  return object(
    member('has_next', 'false'),
    member('has_pre', 'false'),
    member('next_page', '2'),
    member('pre_page', '0'),
    member('page_no', '1'),
    member('page_size', '100'),
    member('position_index', str(positionOf(9, 9))),
    ...members,
  );
}

/** JSON texts of order fixture rows (taobao-orders kit jsonText). */
export function orderTexts(rows: readonly unknown[]): string[] {
  return rows.map((row) => jsonText(row));
}

/** JSON texts of punishment / refund fixture rows (taobao-refunds kit jsonText). */
export function afterSalesTexts(rows: readonly unknown[]): string[] {
  return rows.map((row) => afterSalesJson(row));
}

/** The tb_trade_id of punishOf(index) (taobao-refunds kit). */
export function punishIdOf(index: number): string {
  return `${2900000000000002000n + BigInt(index)}`;
}

export interface PunishExpectedOptions {
  /** Extra members of the outer object (next to time / code / msg / data). */
  readonly top?: Record<string, unknown>;
  /** Extra members of `data` (next to page_no / page_size / total_count / results). */
  readonly data?: Record<string, unknown>;
}

/**
 * A punishment page body without duplicate keys (the frozen taobao-refunds kit's punishData inside
 * the recorded outer shape): what the archive is compared with.
 */
export function punishExpected(
  rows: readonly unknown[],
  total: number,
  options: PunishExpectedOptions = {},
): string {
  return afterSalesJson({
    time: num('1793433600000'),
    code: num('0'),
    msg: '成功',
    ...options.top,
    data: { ...punishData(rows, total), ...options.data },
  });
}

// ---------------------------------------------------------------------------------------------
// 重复键
// ---------------------------------------------------------------------------------------------

/**
 * The member names that appear more than once in the same object of JSON text `text` (decoded as
 * JSON.parse decodes them, so `"a_b"` and `"a_b"` are one name), in order of the repeats.
 * Assumes `text` is JSON.
 */
export function duplicateKeys(text: string): string[] {
  const repeats: string[] = [];
  /** One entry per open container: the names seen so far (an object) or null (an array). */
  const open: (Set<string> | null)[] = [];
  let expectName = false;
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (char === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const names = open[open.length - 1];
      if (expectName && names !== undefined && names !== null) {
        const name = JSON.parse(text.slice(at, end + 1)) as string;
        if (names.has(name)) repeats.push(name);
        else names.add(name);
      }
      expectName = false;
      at = end + 1;
      continue;
    }
    if (char === '{') {
      open.push(new Set());
      expectName = true;
    } else if (char === '[') {
      open.push(null);
      expectName = false;
    } else if (char === '}' || char === ']') {
      open.pop();
      expectName = false;
    } else if (char === ',') {
      const names = open[open.length - 1];
      expectName = names !== undefined && names !== null;
    }
    at += 1;
  }
  return repeats;
}

/** The archived text has no object with a repeated member name. */
export function expectNoDuplicateKeys(text: string): void {
  expect(duplicateKeys(text), 'the archived payload has no duplicate key').toEqual([]);
}

/** None of `needles` (content of an overwritten copy) is anywhere in the archived text. */
export function expectNoneOf(text: string, needles: readonly string[]): void {
  for (const needle of needles) {
    expect(text, `overwritten content ${needle} is not archived`).not.toContain(needle);
  }
}
