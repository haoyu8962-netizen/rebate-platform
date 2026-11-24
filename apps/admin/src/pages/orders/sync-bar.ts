// The reads behind the sync status bar (F1-07edb, BR-ID-46). The bar shows only what
// GET /admin/v1/order-syncs?page=1&page_size=1 answers: nothing from a create answer is merged in.
// Every read takes the next sequence number and only the answer to the latest read sent may reach
// the bar; an answer to an earlier read (success or failure) arriving later is dropped.
import type { SyncItem, SyncOutcome, SyncPage } from './model.ts';

/** The sync status bar: reading, the latest request (none: undefined) or a failed read. */
export type SyncBarState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly item: SyncItem | undefined }
  | { readonly status: 'failed' };

/** Reads the latest sync record; `show` gets the answer of the latest read only. */
export interface SyncBarReader {
  /** Sends one read; any read sent before it can no longer reach the bar. */
  readonly load: () => void;
  /** No answer reaches the bar any more (the bar is gone). */
  readonly stop: () => void;
}

export function syncBarReader(
  read: () => Promise<SyncPage>,
  show: (state: SyncBarState) => void,
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
          if (latest(mine)) show({ status: 'ready', item: page.items[0] });
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

/** Whether a manual sync submit refreshes the bar: only an accepted one (created or reused). */
export function refreshesSyncBar(outcome: SyncOutcome): boolean {
  return outcome.kind === 'created' || outcome.kind === 'reused';
}
