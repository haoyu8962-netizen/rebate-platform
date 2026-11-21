import type { Server } from '../../admin-withdrawals/fixtures.ts';

/** The list reads (page_size other than '1'), in order; page_size=1 reads are tab counts. */
export function listReadsOf(server: Server): ReturnType<Server['reads']> {
  return server.reads().filter((read) => read.query['page_size'] !== '1');
}
/** The query of every list read (page_size other than '1'), in order. */
export function listQueries(server: Server): Record<string, string>[] {
  return listReadsOf(server).map((read) => read.query);
}
/** Plain code-unit order of two strings. */
export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
/** A key that does not depend on the order of the query parameters. */
export function queryKey(query: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(query).sort(([a], [b]) => byText(a, b)));
}
/** Queries sorted by queryKey. */
export function sortedQueries(list: readonly Record<string, string>[]): Record<string, string>[] {
  return [...list].sort((a, b) => byText(queryKey(a), queryKey(b)));
}
/** The query of every tab count read (page_size '1'), sorted. */
export function countQueries(server: Server): Record<string, string>[] {
  const counts = server.reads().filter((read) => read.query['page_size'] === '1');
  return sortedQueries(counts.map((read) => read.query));
}
/** The five tab count reads (全部 / 待审 / 驳回 / 手动 / 自动), each only its tab's quick filter, sorted. */
export function tabCounts(): Record<string, string>[] {
  return sortedQueries([
    { page: '1', page_size: '1' },
    { display_status: 'paid_manual', page: '1', page_size: '1' },
    { display_status: 'pending_review', page: '1', page_size: '1' },
    { display_status: 'rejected', page: '1', page_size: '1' },
    { page: '1', page_size: '1', status: 'PAID_API' },
  ]);
}
