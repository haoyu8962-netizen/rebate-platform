// CT-24zzk 工作台 adminGetDashboard 的 yesterday 可空（编排裁定 D10-1403 ③）的契约测试共用件。
// 独立预期来自任务书第 9 节，不从契约生成；静态读 contracts，用仓库现成的 Ajv2020 strict 校验
// （order-claims/kit.ts 的 compile），不连库、不 listen。
import { expect } from 'vitest';
import { at, compile, op, resolve, response, text, type Obj } from '../admin-order-actions/kit.ts';

export const path = '/admin/v1/dashboard';
export const operationId = 'adminGetDashboard';
export const yesterdayKeys = ['date', 'links', 'orders', 'est_rebate_fen', 'new_users', 'as_of'];
// minimum 0 的计数字段（est_rebate_fen 引用 Fen，不在此列）。
export const countKeys = ['links', 'orders', 'new_users'];
export const traceId = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';

// 最新一行恰是昨天的会计日。
export const yesterday = {
  date: '2026-11-12',
  links: 1284,
  orders: 312,
  est_rebate_fen: 158600,
  new_users: 46,
  as_of: '2026-11-13T00:30:00+08:00',
};
// 不晚于昨天的最新一行早于昨天（之后的聚合没成功）：date 与 as_of 如实，形状不变。
export const staleYesterday = {
  date: '2026-11-09',
  links: 0,
  orders: 0,
  est_rebate_fen: 0,
  new_users: 0,
  as_of: '2026-11-10T00:30:00+08:00',
};
export const todo = [
  { key: 'claim_review_pending', count: 0, route: '/claims?status=manual_review', oldest_at: null },
];
export const status = {
  payout_queue_paused: false,
  payout_channel_paused: [],
  settle_auto_enabled: true,
  balance_w_expired: null,
};

export function operation(doc: Obj): Obj {
  return op(doc, path, 'get');
}

// 200 响应整体（信封 + AdminDashboard）的校验器。
export function responseValidator(doc: Obj): ReturnType<typeof compile> {
  return compile(doc, response(doc, path, 'get'));
}

export function dashboardSchema(doc: Obj): Obj {
  return resolve(doc, at(response(doc, path, 'get'), 'properties', 'data'));
}

export function envelope(data: Obj): Obj {
  return { code: 0, msg: '', data, trace_id: traceId };
}

// 带给定 yesterday 值的 200 响应；withStatus 为真时模拟有 fund.view 的账号。
export function withYesterday(value: unknown, withStatus = false): Obj {
  return envelope({ todo, yesterday: value, ...(withStatus ? { status } : {}) });
}

// 描述里 `yesterday` 那一条（从「- `yesterday`」起，到下一条或段落结束），拼成一行。
export function yesterdayBullet(doc: Obj): string {
  const lines = text(operation(doc)['description']).split('\n');
  const isStart = (line: string): boolean => /^\s*-\s+`?yesterday\b/.test(line);
  expect(lines.filter(isStart), '描述里 `yesterday` 那一条').toHaveLength(1);
  const start = lines.findIndex(isStart);
  const parts = [lines[start]!.trim()];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line) || /^\s*-\s/.test(line)) break;
    parts.push(line.trim());
  }
  return parts.join(' ');
}
