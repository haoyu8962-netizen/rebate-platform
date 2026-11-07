// B1-04zzp（D10-793 ①，FU-TB-ARCHIVE-FOREIGN-RIGHTS 的违规半边；规划变更 20261031-淘宝订单经大淘客 §1
// 「同步时按凑狸的推广位过滤，不入库别家订单」）：违规 get-foul-order-list 请求的归档只存去掉别家推广位行的
// 报文。本目录的小工具：违规报文（外层形状照冻结的 taobao-refunds/kit.ts 的 punishData / reply，可加外层
// 字段）、单号、别家计数。装配直接用 taobao-order-archive/kit.ts 的 wire（真实 createArchivingTransport +
// 真实 DataokeClient + 真实淘宝适配器，归档表是假的 insert）。报文与推广位全部合成，不读任何录制。
// Task-local AC labels ([AC-B1-04zzp#n]) identify this task's acceptance points, not business rules.
import type { Wired } from '../taobao-order-archive/kit.ts';
import {
  FOREIGN_ADZONE,
  SETTLE_MONTH,
  jsonText,
  num,
  punishData,
  punishOf,
} from '../taobao-refunds/kit.ts';

/** The tb_trade_id of punishOf(index). */
export function punishIdOf(index: number): string {
  return `${2900000000000002000n + BigInt(index)}`;
}

/** The punishment_id listPunishments gives punishOf(index) (`<tb_trade_id>:<settle_month>`). */
export function punishmentIdOf(index: number): string {
  return `${punishIdOf(index)}:${SETTLE_MONTH}`;
}

/** A punishment of another company's slot whose tk_adzone_id is a decimal string (still readable). */
export function foreignText(
  index: number,
  adzone: string = FOREIGN_ADZONE,
): Record<string, unknown> {
  return { ...punishOf(index, adzone), tk_adzone_id: adzone };
}

export interface PunishBodyOptions {
  /** data.total_count; rows.length by default, null leaves it out. */
  readonly total?: number | null;
  readonly pageNo?: number;
  /** Extra members of the outer object (next to time / code / msg / data). */
  readonly top?: Record<string, unknown>;
  /** Extra or replaced members of `data` (next to page_no / page_size / total_count / results). */
  readonly data?: Record<string, unknown>;
}

/** The body text of one punishment page holding `rows` (JSON number literals kept as written). */
export function punishBody(rows: readonly unknown[], options: PunishBodyOptions = {}): string {
  return jsonText({
    time: num('1793433600000'),
    code: num('0'),
    msg: '成功',
    ...options.top,
    data: {
      ...punishData(
        rows,
        options.total === undefined ? rows.length : options.total,
        options.pageNo,
      ),
      ...options.data,
    },
  });
}

/** The counts of the taobao_punish_foreign_slot warnings (one per page with rows of other slots). */
export function punishForeignCounts(wired: Wired): readonly (number | undefined)[] {
  return wired.punishWarn.mock.calls
    .map(([event]) => event)
    .filter((event) => event.event === 'taobao_punish_foreign_slot')
    .map((event) => event.count);
}
