import type { Clock } from '../clock/index.ts';

export interface ChannelMismatchSnapshot {
  readonly open: Readonly<Record<string, number>>;
}

export interface SettleBillMismatchSnapshot {
  readonly bills: Readonly<
    Record<string, { readonly amountMismatch: number; readonly generatedAtSeconds: number }>
  >;
}

export function cacheChannelMismatchCollector(
  collect: () => Promise<ChannelMismatchSnapshot>,
  clock: Clock,
): () => Promise<ChannelMismatchSnapshot> {
  void collect;
  void clock;
  throw new Error('NotImplemented: cacheChannelMismatchCollector');
}

export function cacheSettleBillMismatchCollector(
  collect: () => Promise<SettleBillMismatchSnapshot>,
  clock: Clock,
): () => Promise<SettleBillMismatchSnapshot> {
  void collect;
  void clock;
  throw new Error('NotImplemented: cacheSettleBillMismatchCollector');
}
