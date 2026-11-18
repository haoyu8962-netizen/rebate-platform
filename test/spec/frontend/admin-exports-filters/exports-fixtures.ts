// F1-08fd fixtures (D10-1994 (二), D10-2061): the frozen fake /admin/v1 server of
// admin-audit-logs/audit-fixtures.ts answers adminListExports page by page and filters, as the
// contract says, by `status`, `resource`, `from` (inclusive) and `to` (exclusive) on created_at.
// The copy below is the page's current wording (apps/admin/src/texts/exports.ts, BR-TEXT-25
// admin_dict.export_status) and the field names the task fixes, each compared as a whole string.
import { expect } from 'vitest';
import {
  EXPORTER,
  EXPORTS,
  NOW,
  createServer,
  exportRow,
  type ExportRow,
  type ExportStatus,
  type Server,
} from '../admin-audit-logs/audit-fixtures.ts';

export { EXPORTER, EXPORTS, NOW, createServer, exportRow };
export type { ExportRow, ExportStatus, Server };

export const COPY = {
  /** The Select of the source list (export_resource). */
  source: '来源页面',
  /** The RangePicker (or start / end date inputs in one form item) on created_at. */
  time: '发起时间',
  query: '查询',
  reexport: '重新导出',
  download: '下载',
  retry: '重试',
  forbiddenTitle: '无权限查看导出记录',
  loadFailed: '导出任务加载失败',
} as const;

/** The status tabs, in order: 全部, then export_status in enum order; never a count. */
export const TAB_NAMES: readonly string[] = [
  '全部',
  '排队中',
  '生成中',
  '已完成',
  '失败',
  '已过期',
  '已取消',
];

/** 来源页面 options: 全部, then export_resource in enum order (no name: the code is shown). */
export const SOURCE_OPTIONS: readonly string[] = [
  '全部',
  '用户列表',
  '操作日志',
  'tax_withdrawals',
  '余额流水',
];

/** page_size the page sends (texts unchanged since F1-10j). */
export const PAGE_SIZE = '20';

/** 发起时间 2026-10-18 … 2026-10-19 in Beijing days: from the first day's 00:00 (inclusive). */
export const FROM_DAY = '2026-10-18';
export const TO_DAY = '2026-10-19';
export const FROM_SENT = '2026-10-18T00:00:00+08:00';
/** … to the day after the last day, 00:00 (exclusive). */
export const TO_SENT = '2026-10-20T00:00:00+08:00';

/** The whole query of one list read: page 1, the page size, plus `extra`. */
export function listQuery(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { page: '1', page_size: PAGE_SIZE, ...extra };
}

function pad(index: number): string {
  return String(index).padStart(4, '0');
}

/** `count` tasks `<prefix>0001`… in one status. */
export function series(
  prefix: string,
  count: number,
  status: ExportStatus,
  patch: Partial<ExportRow> = {},
): ExportRow[] {
  return Array.from({ length: count }, (_, index) =>
    exportRow(`${prefix}${pad(index + 1)}`, status, patch),
  );
}

export function ids(rows: readonly ExportRow[]): string[] {
  return rows.map((row) => row.id);
}

/** Changes a task on the fake server; the next read answers it. */
export function update(server: Server, id: string, patch: Partial<ExportRow>): void {
  const found = server.state.tasks.find((task) => task.id === id);
  expect(found, `task ${id} on the fake server`).toBeDefined();
  Object.assign(found!, patch);
}

/** A failed read (server error envelope). */
export function unavailable(): Response {
  return Response.json(
    {
      code: 50001,
      msg: '服务暂时不可用',
      data: null,
      trace_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b',
    },
    { status: 500 },
  );
}

/** A done task turned done on the server by a reread (download window still open at NOW). */
export const DONE_PATCH: Partial<ExportRow> = {
  status: 'done',
  progress: null,
  file_name: 'export.csv',
  row_count: 30,
  expires_at: '2026-10-21T02:00:00Z',
};
