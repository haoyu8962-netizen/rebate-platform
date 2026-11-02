// 淘宝搜索官方优先、大淘客补充（B1-04zy，FU-TB-SEARCH-FALLBACK，D10-582；BR-PRICE-11）：回落判断、官方
// 这一步的限时与冷却取值、回落日志的形状；编排在 taobao-adapter.ts。规则测试
// test/spec/union/taobao-search-fallback/**。
//
// 开关：searchSource = official_first（UnionModule 保证此时有大淘客客户端，没有就拒绝启动）。官方、大淘客两种
// 模式不回落。
//
// ① 触发：只看第 1 页（cursor 为空）。官方这一步抛 upstream_unavailable、rate_limited、upstream_rejected（含
//   code 11；搜索与换算 ID 同样算）、到限时，或成功但 items 为空（含全部换不到 ID）。invalid_dto、
//   adapter_unimplemented、读推广位等清单外的失败、调用方取消都不回落，原样抛。
// ② 单一来源：回落时官方这一步的结果整个作废，items、nextCursor、quoted_at 全取大淘客这一次（quoted_at 是大淘客
//   收到响应的时刻，#dataokeSearch 自己取）。续页按游标前缀走，不回落、不换源，也不看冷却。
// ③ 限时：官方这一步（读推广位、搜索、换算 ID）单独限时，为这次调用预算的一半，到点取消官方请求并回落，大淘客用
//   剩余时间。回落在适配器内，熔断器看不到官方失败，所以要有这一步。预算取治理层同一份策略：
//   governed-adapter 按 ctx.purpose 选在线 / 离线，app.module 不传登记表覆盖（union.search 默认等于在线策略）；
//   那条 TODO 落地时这里要跟着读同一份。
// ④ 冷却：官方失败（限时算，0 条不算）后 60 秒内本实例的第 1 页直接走大淘客，不发官方请求；从失败时刻算，读注入
//   Clock，进程内每实例一份。冷却期不写回落日志（每个请求一条没有意义），只记大淘客那次的计数。
// ⑤ 日志：回落写 warn taobao_search_fallback，source = official，reason 是错误码、timeout 或 empty；大淘客也失败
//   再写 warn taobao_search_dataoke_failed，source = dataoke。都不含关键词，也不含上游文本。
import { unionPolicy } from '../../../platform/index.ts';
import { UnionError, type CallCtx, type UnionErrorCode } from '../../domain/types.ts';

/** How long after an official failure first pages skip the official search. */
export const TAOBAO_OFFICIAL_COOLDOWN_MS = 60_000;

/** The UnionError codes of a failed official step that fall back (see the header ①). */
const FALLBACK_CODES = ['upstream_unavailable', 'rate_limited', 'upstream_rejected'] as const;

type TaobaoSearchFailureReason = (typeof FALLBACK_CODES)[number];

/** Why the official step handed over; goes to the warn log, never to a metric label. */
export type TaobaoSearchFallbackReason = TaobaoSearchFailureReason | 'timeout' | 'empty';

/** One fallback, or the 大淘客 failure that ended it; never carries the keyword. */
export type TaobaoSearchFallbackWarning =
  | {
      readonly event: 'taobao_search_fallback';
      readonly source: 'official';
      readonly reason: TaobaoSearchFallbackReason;
    }
  | {
      readonly event: 'taobao_search_dataoke_failed';
      readonly source: 'dataoke';
      readonly reason: UnionErrorCode | 'unknown';
    };

/** The official step's own limit: half this call's budget (see the header ③). */
export function officialStepLimitMs(purpose: CallCtx['purpose']): number {
  return unionPolicy(purpose === 'online' ? 'online' : 'offline').timeoutMs / 2;
}

/** The fallback reason of what the official step threw; undefined: rethrow it as it is. */
export function officialFailureReason(error: unknown): TaobaoSearchFailureReason | undefined {
  const failed = error instanceof UnionError ? error.code : undefined;
  return FALLBACK_CODES.find((code) => code === failed);
}

/** The reason field of a 大淘客 failure: the code only, never the message. */
export function dataokeFailureReason(error: unknown): UnionErrorCode | 'unknown' {
  return error instanceof UnionError ? error.code : 'unknown';
}
