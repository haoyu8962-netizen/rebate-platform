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
  NOW,
  fixture as rightsFixture,
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

/** 违规单：报文里根本没有 punish_status 这个成员。 */
export function withoutStatus(index: number, patch: Partial<UnionPunish> = {}): UnionPunish {
  const kept = Object.entries({ ...plain(index), ...patch }).filter(
    ([key]) => key !== 'punish_status',
  );
  return Object.fromEntries(kept) as unknown as UnionPunish;
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
