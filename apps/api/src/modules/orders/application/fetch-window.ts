// B1-04zt: every page of one order window, for the increment, rescan and manual window jobs
// (规划/02 §7.1; 09 CAP-JD-07). When the upstream calls a window too large (UnionError.windowTooLarge,
// at any page) the window is halved and each half queried from its first page, down to
// WINDOW_HALVING_MIN_SPAN_MS; below that, and for any other failure, the error goes to the caller
// as it is. Pages already handed to onPage stay handed: the caller's counts keep them, and the
// pipeline settles the rows a half returns again. Moving a cursor is the caller's, after this
// resolves.
import {
  UnionError,
  type CallCtx,
  type Page,
  type TimeWindow,
  type UnionAdapter,
  type UnionOrder,
} from '../../union/index.ts';
import { halveWindow } from '../domain/sync-window.ts';

export interface WindowQuery {
  readonly adapter: Pick<UnionAdapter, 'listOrders'>;
  readonly call: CallCtx;
  /** Called for each page in order, across every half; its counts survive a throw from here. */
  readonly onPage: (orders: readonly UnionOrder[]) => Promise<void>;
}

export async function fetchWindow(range: TimeWindow, query: WindowQuery): Promise<void> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    let page: Page<UnionOrder>;
    try {
      page = await query.adapter.listOrders(
        range,
        cursor === undefined ? { queryMode: 'increment' } : { cursor, queryMode: 'increment' },
        query.call,
      );
    } catch (error) {
      const halves =
        error instanceof UnionError && error.windowTooLarge ? halveWindow(range) : null;
      if (halves === null) throw error;
      for (const half of halves) await fetchWindow(half, query);
      return;
    }
    await query.onPage(page.items);
    if (page.nextCursor === null) return;
    // A cursor seen before would loop forever; fail the window instead.
    if (seen.has(page.nextCursor)) throw new Error('order_sync_cursor_repeated');
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
