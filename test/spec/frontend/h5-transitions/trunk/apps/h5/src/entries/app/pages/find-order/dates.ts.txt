import type { DailyBlock } from './model.ts';

// ---- 日期（BR-TEXT-11，Asia/Shanghai） ----

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 上海时区的 YYYY-MM-DD 与 HH:mm。 */
function shanghai(ms: number): { date: string; time: string } {
  const iso = new Date(ms + SHANGHAI_OFFSET_MS).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** 今天的上海日期 YYYY-MM-DD（日期选择的上限）。 */
export function shanghaiToday(nowMs: number): string {
  return shanghai(nowMs).date;
}

/** 上海时间下一个 0 点距 nowMs 的毫秒数（当天置灰到点解除用）。 */
export function msUntilNextShanghaiDay(nowMs: number): number {
  const DAY = 24 * 60 * 60 * 1000;
  const sinceMidnight = (((nowMs + SHANGHAI_OFFSET_MS) % DAY) + DAY) % DAY;
  return DAY - sinceMidnight;
}

// ---- 30203 / 30206 当天置灰 ----

/** 记录仍属今天（上海日期）时返回提示；跨日或没有记录时为 null。 */
export function activeBlockMessage(
  block: DailyBlock | null | undefined,
  nowMs: number,
): string | null {
  if (block === null || block === undefined) return null;
  return block.day === shanghaiToday(nowMs) ? block.message : null;
}
