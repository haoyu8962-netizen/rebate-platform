// F1-08fb: reuse the frozen ledger GET server, intercept exports at the fetch boundary.
// Requests still traverse the real data provider; responses follow adminCreateExport.
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  EXPORTS,
  TRACE_ID,
  createServer as createLedgerServer,
  denied,
  grants,
  ok,
  type ServerOptions,
} from '../admin-ledger-readonly/fixtures.ts';

export const EXPORTER = grants('fund.view', 'export');
export const EXPORT_LABEL = '导出当前筛选';
export type ExportTask = Schema<'AdminExport'>;
export type ExportFilters = Schema<'AdminExportLedgerFilters'>;

export interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly headers: Headers;
  readonly body: unknown;
}
type Reply = () => Response | Promise<Response>;

export function task(id: string, resource: ExportTask['resource'] = 'ledger'): ExportTask {
  return {
    id,
    resource,
    filters_summary: '测试用户的已生效筛选',
    masked: true,
    created_by: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4fa001',
    created_by_name: '运营',
    created_at: '2026-11-17T01:00:00Z',
    status: 'pending',
    progress: null,
    failure_reason: null,
    file_name: null,
    row_count: null,
    expires_at: null,
  };
}

export function accepted(row: ExportTask): Response {
  return Response.json({ code: 0, msg: '', data: row, trace_id: TRACE_ID }, { status: 202 });
}

export function createServer(options: ServerOptions = { permissions: ['fund.view', 'export'] }) {
  const ledger = createLedgerServer(options);
  const requests: SentRequest[] = [];
  const records: ExportTask[] = [];
  const replies: Reply[] = [];
  let pending = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    pending += 1;
    try {
      const raw = await request.text();
      const sent: SentRequest = {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: request.headers,
        body: raw === '' ? undefined : (JSON.parse(raw) as unknown),
      };
      requests.push(sent);
      if (sent.path !== EXPORTS) return await ledger.fetch(input, init);
      if (sent.method === 'GET')
        return ok({ items: records, page: 1, page_size: 20, total: records.length });
      if (sent.method !== 'POST') return denied();
      const reply = replies.shift();
      if (reply !== undefined) return await reply();
      const permissions = options.permissions ?? [];
      if (
        !options.isSuper &&
        (!permissions.includes('export') ||
          !(permissions.includes('fund.view') || permissions.includes('user.lookup')))
      )
        return denied();
      const row = task(`EX20261117${String(records.length + 1).padStart(6, '0')}`);
      records.push(row);
      return accepted(row);
    } finally {
      pending -= 1;
    }
  };
  return {
    ...ledger,
    fetch,
    requests,
    records,
    get pending() {
      return pending;
    },
    exportPosts(): SentRequest[] {
      return requests.filter((sent) => sent.method === 'POST' && sent.path === EXPORTS);
    },
    replyNext(reply: Reply): void {
      replies.push(reply);
    },
  };
}
export type Server = ReturnType<typeof createServer>;
