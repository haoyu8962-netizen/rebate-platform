// The reads behind the sync status bar (F1-07edb, BR-ID-46). The bar shows only what
// GET /admin/v1/order-syncs?page=1&page_size=1 answers, read on the first load and on each click
// of its 【刷新】; nothing else (a manual sync submit included) reads it or changes it. Every read
// takes the next sequence number and only the answer to the latest read sent may reach the bar;
// an answer to an earlier read (success or failure) arriving later is dropped. A successful
// answer carries the moment it arrived, shown as 「更新于 HH:mm:ss」 in Beijing time.
import { beijingClock, type SyncItem, type SyncPage } from './model.ts';

/** The sync status bar: reading, the latest request (none: undefined) or a failed read. */
export type SyncBarState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly item: SyncItem | undefined;
      /** When the read succeeded (ISO, UTC). */
      readonly readAt: string;
    }
  | { readonly status: 'failed' };

/** Reads the latest sync record; `show` gets the answer of the latest read only. */
export interface SyncBarReader {
  /** Sends one read; any read sent before it can no longer reach the bar. */
  readonly load: () => void;
  /** No answer reaches the bar any more (the bar is gone). */
  readonly stop: () => void;
}

/** The console's wall clock (the admin front end has no injected Clock). */
const SYSTEM_NOW = (): number => Date.now();

export function syncBarReader(
  read: () => Promise<SyncPage>,
  show: (state: SyncBarState) => void,
  now: () => number = SYSTEM_NOW,
): SyncBarReader {
  let sequence = 0;
  let stopped = false;
  const latest = (mine: number): boolean => !stopped && mine === sequence;
  return {
    load: () => {
      sequence += 1;
      const mine = sequence;
      read().then(
        (page) => {
          if (latest(mine)) {
            show({ status: 'ready', item: page.items[0], readAt: new Date(now()).toISOString() });
          }
        },
        () => {
          if (latest(mine)) show({ status: 'failed' });
        },
      );
    },
    stop: () => {
      stopped = true;
    },
  };
}

/** HH:mm:ss (24-hour) in Beijing of the moment a read succeeded. */
export function syncBarUpdated(readAt: string): string {
  return beijingClock(readAt, true);
}
