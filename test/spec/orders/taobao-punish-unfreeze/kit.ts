// B1-04zzab 淘宝违规解冻的处理器夹具（不连库、不联网）。取值依据：08 BR-FUND-22（处罚被平台解冻在实测证实前
// 不恢复、不补钱；「解冻」是映射表之外的信号，按 BR-FUND-02 进待处理表并告警，留下证据——负责人决-06 实测前 A）、
// BR-FUND-02（映射表外的码写待处理表并告警，不落任何正向状态）、规划/12 §1.3 处罚表「冻结」「解冻」两行、编排
// D10-2335 (c3) / D10-2412（任务书第 9 节：'0' 冻结照旧交写入方；'1' 解冻不交写入方、进待处理 UNFREEZE_SIGNAL；
// 0 / 1 以外的值进待处理 UNMAPPED_STATUS；缺字段照现状按处罚并单独计数）。
// 假适配器、假写入方、假水位与门控沿用 B1-04zza 的冻结夹具（../taobao-rights-sync/kit.ts，只读不改）；这里只加
// 假待处理端口与日志取数。UnionPunish 是联盟归一后的形状（合成值，不是平台报文）。
import { vi } from 'vitest';
import type {
  PunishPendingPort,
  PunishPendingSignal,
} from '../../../../apps/api/src/modules/orders/application/punish-pending.ts';
import type { RightsSyncHandlerDeps } from '../../../../apps/api/src/modules/orders/jobs/rights-sync.ts';
import type { UnionPunish } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  APP,
  DAY_MS,
  MINUTE_MS,
  NOW,
  NOW_MS,
  PUNISH_DAYS,
  fixture as rightsFixture,
  iso,
  punishWindow,
  type FixtureOptions,
} from '../taobao-rights-sync/kit.ts';

export {
  APP,
  NOW,
  PUNISH_JOB,
  TAOBAO_ACCOUNT,
  job,
  loggedValues,
  printed,
  punishWindow,
  punishment,
} from '../taobao-rights-sync/kit.ts';

/** 违规窗口结束日志（B1-04zza 的 `${event}_done`）。 */
export const DONE_EVENT = 'order_punish_sync_window_done';
/** 解冻信号的告警（warn 级，一窗一条，带本窗解冻条数）。 */
export const UNFREEZE_EVENT = 'order_punish_sync_window_unfreeze_signal';
/** punish_status 是 0 / 1 以外的值的告警（warn 级，一窗一条，带条数）。 */
export const UNMAPPED_EVENT = 'order_punish_sync_window_unmapped_punish_status';

/** 窗口结束日志里的新计数项（任务书 9.2 第 2、5、6 条）。 */
export const UNFREEZE_COUNT = 'unfreeze_signal';
export const UNMAPPED_COUNT = 'unmapped_punish_status';
export const MISSING_COUNT = 'missing_punish_status';

/** 一条能看出是否漏进日志的金额（分）。 */
export const MARKED_FEN = 98_765_431n;

/** 违规单：冻结（'0'，夹具默认）。 */
export function frozen(index: number, patch: Partial<UnionPunish> = {}): UnionPunish {
  return { ...plain(index), punish_status: '0', ...patch };
}

/** 违规单：解冻（'1'）。 */
export function unfrozen(index: number, patch: Partial<UnionPunish> = {}): UnionPunish {
  return { ...plain(index), punish_status: '1', ...patch };
}

/** 违规单：报文里没有 punish_status（适配器归一后为 null，union/infra/taobao/punishments.ts）。 */
export function missingStatus(index: number, patch: Partial<UnionPunish> = {}): UnionPunish {
  return { ...plain(index), punish_status: null, ...patch };
}

/**
 * 订单号「转成 Number 再打印与原串相同」的 index（19 位、末三位 000：双精度间隔 512 < 1000，最短十进制
 * 表示就是原串）；其余 index 的订单号转 Number 后会打印成别的数（任务书 11.2 第 7 条）。
 */
export const ROUND_TRIP_INDEXES = [0, 1000] as const;

/**
 * 窗口在 NOW 前 12 分钟结束、注入时钟仍是 NOW（任务产生于 03:48、04:00 才执行）：detected_at /
 * occurred_at 必须取注入时钟，不取窗口结束时刻（任务书 11.2 第 5 条）。
 */
export const LAG_MS = 12 * MINUTE_MS;
export function lateWindow() {
  return punishWindow({
    window_start: iso(NOW_MS - LAG_MS - PUNISH_DAYS * DAY_MS),
    window_end: iso(NOW_MS - LAG_MS),
  });
}

/** 与冻结夹具 punishment(index) 同形的一条，单号按 index 区分（结算月 202610）。 */
function plain(index: number): UnionPunish {
  const orderId = `${2900000000000006000n + BigInt(index)}`;
  return {
    order_id: orderId,
    punishment_id: `${orderId}:202610`,
    deduction_fen: null,
    punish_status: '0',
    violation_type: '1',
    settle_month: '202610',
  };
}

/** 交给写入方的目标（订单号即子订单号）。 */
export function targetOf(p: Pick<UnionPunish, 'order_id'>) {
  return { app_id: APP, platform: 'taobao', sub_order_id: p.order_id };
}

/** 冻结行交给写入方的条目（B1-04zza #32 的口径）。 */
export function punishItem(p: Pick<UnionPunish, 'punishment_id'>) {
  return {
    type: 'PUNISH',
    status: 'SUCCEEDED',
    amount_fen: null,
    deduction_commission_fen: null,
    occurred_at: new Date(NOW),
    platform_rights_no: p.punishment_id,
  };
}

/** 交给待处理端口的一条信号。 */
export function signalOf(
  p: Pick<UnionPunish, 'order_id'>,
  reason: PunishPendingSignal['reason'],
  raw: string,
): PunishPendingSignal {
  return {
    app_id: APP,
    platform: 'taobao',
    sub_order_id: p.order_id,
    reason,
    raw_status: raw,
    detected_at: new Date(NOW),
  };
}

interface MockLike {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}

/** pino 风格调用里，消息为 `event` 的那些行的字段。 */
export function linesOf(fn: MockLike, event: string): Record<string, unknown>[] {
  return fn.mock.calls
    .filter((call) => call[1] === event)
    .map((call) => call[0])
    .filter(
      (fields): fields is Record<string, unknown> => typeof fields === 'object' && fields !== null,
    );
}

/** 一个日志参数里的全部叶子值，打印成文本：字符串原样，数值 / bigint / 布尔按十进制，Date 按 ISO；递归。 */
export function leaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    out.push(String(value));
  } else if (value instanceof Date) out.push(value.toISOString());
  else if (Array.isArray(value)) for (const item of value) leaves(item, out);
  else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) leaves(item, out);
  }
  return out;
}

/** 一个日志参数里的全部字段名（递归）。 */
export function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) keysOf(item, out);
  else if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      keysOf(item, out);
    }
  }
  return out;
}

/** 看起来是金额的字段名。 */
export const AMOUNT_KEY = /fen|amount|deduction/i;

/**
 * 日志里不许出现的东西：订单号、违规单号（订单号:结算月），以及它们转成 Number 再打印的样子（含与
 * 结算月重新拼出的违规单号），金额（扣款分）的十进制。
 */
export function markersOf(rows: readonly UnionPunish[]): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    const numeric = String(Number(row.order_id));
    out.add(row.order_id);
    out.add(row.punishment_id);
    out.add(numeric);
    out.add(`${numeric}:${row.settle_month}`);
    if (row.deduction_fen !== null) out.add(row.deduction_fen.toString());
  }
  return [...out];
}

/** 这些 mock 的全部调用里，含禁用标记的叶子值与像金额的字段名（应为空）。 */
export function leaksIn(fns: readonly MockLike[], markers: readonly string[]) {
  const values: string[] = [];
  const amountKeys: string[] = [];
  for (const fn of fns) {
    for (const call of fn.mock.calls) {
      for (const arg of call) {
        for (const leaf of leaves(arg)) {
          if (markers.some((marker) => leaf.includes(marker))) values.push(leaf);
        }
        amountKeys.push(...keysOf(arg).filter((key) => AMOUNT_KEY.test(key)));
      }
    }
  }
  return { values, amountKeys };
}

/** 冻结夹具 + 假待处理端口：`handler` 注入了它，`bare` 是没注入的装配（9.2 第 7 条后半句）。 */
export function fixture(options: FixtureOptions = {}) {
  const base = rightsFixture(options);
  const record = vi.fn<PunishPendingPort['record']>(async () => undefined);
  const pending: PunishPendingPort = { record };
  const handler: RightsSyncHandlerDeps = { ...base.handler, pending };
  const bare: RightsSyncHandlerDeps = base.handler;
  return {
    ...base,
    record,
    pending,
    handler,
    bare,
    /** 交给待处理端口的信号，按调用先后。 */
    signals: () => record.mock.calls.map(([signal]) => signal),
    /** 写入方收到的 [target, item, extras]。 */
    writesWithExtras: () =>
      base.write.mock.calls.map(([target, item, extras]) => ({ target, item, extras })),
    /** 窗口结束日志（info）。 */
    done: () => linesOf(base.logger.info, DONE_EVENT),
    /** 某个告警事件的 warn 行。 */
    warned: (event: string) => linesOf(base.logger.warn, event),
    /** 别的级别上出现的同名事件（告警只认 warn 级）。 */
    elsewhere: (event: string) => [
      ...linesOf(base.logger.info, event),
      ...linesOf(base.logger.error, event),
    ],
  };
}
export type Fixture = ReturnType<typeof fixture>;
