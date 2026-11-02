import type { Clock, JobPayload, JobQueue, RootLogger } from '../../platform/index.ts';
import type { RegisteredPlatform, UnionAdapter } from '../../union/index.ts';

export interface SyncStream {
  readonly app_id: string;
  readonly platform: RegisteredPlatform;
  readonly union_account_id: string;
  readonly query_kind: string;
  readonly scene: string;
}

export interface OrderSyncWindow extends SyncStream, JobPayload {
  readonly query_kind: 'increment';
  readonly scene: '-';
  readonly window_start: string;
  readonly window_end: string;
}

/** B1-04zm: one account's rescan stream; its cursor is independent of the increment stream's. */
export interface RescanStream extends SyncStream {
  readonly query_kind: 'rescan';
  readonly scene: '-';
}

export interface OrderRescanWindow extends RescanStream, JobPayload {
  readonly window_start: string;
  readonly window_end: string;
}

export interface SyncAccount {
  readonly app_id: string;
  readonly platform: RegisteredPlatform;
  readonly union_account_id: string;
  readonly sync_start_at: string | null;
}

export interface SyncCursorStore {
  read(stream: SyncStream): Promise<string | null>;
  /** One transaction: insert if absent, otherwise CAS from window_start to window_end. */
  advance(window: OrderSyncWindow | OrderRescanWindow): Promise<boolean>;
  /**
   * B1-04zt: one statement moves this stream's cursor to `to`. `expected` a string: CAS of the
   * existing row, a missing row or another cursor_at writes nothing and resolves false. `expected`
   * null: insert when the stream has no row, an existing row stays and resolves false. Optional
   * only for test fakes: without it the scheduler does not dispatch a start that must be moved.
   */
  rewind?(stream: SyncStream, expected: string | null, to: string): Promise<boolean>;
}

/**
 * B1-04zm: a cursor store that can also move a rescan stream back to the start of a round. Apart
 * from SyncCursorStore so the increment path and its fakes keep the two methods they use.
 */
export interface RescanCursorStore extends SyncCursorStore {
  /**
   * One transaction: CAS of this stream's existing row from `expected` to `to`, in either direction
   * (a new round moves it back, a cursor older than the rescan range moves it forward). A missing
   * row or another cursor_at writes nothing and resolves false.
   */
  rewind(stream: RescanStream, expected: string, to: string): Promise<boolean>;
}

export interface SyncAccessPort {
  listEnabledAccounts(): Promise<readonly SyncAccount[]>;
  siteAuthAvailable(account: SyncAccount | SyncStream): Promise<boolean>;
  /** Status of the offline governor, never the online governor. */
  offlineCircuitOpen(platform: RegisteredPlatform): Promise<boolean>;
  /**
   * The union_account_id whose credentials this deployment's adapter for `platform` actually
   * queries (registry.get(platform) holds one credential set per platform); null when the
   * platform has no queryable account. When provided, the scheduler dispatches windows only for
   * that account and the handler refuses windows of any other account, so account B's cursor is
   * never advanced by a fetch of account A's orders (D10-36).
   * Optional only for test fakes: the production wiring (B1-08n) MUST provide it.
   */
  queryableAccount?(platform: RegisteredPlatform): Promise<string | null>;
}

export interface SyncSchedulerDeps {
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly cursors: SyncCursorStore;
  readonly access: SyncAccessPort;
  /** Flat fields only (platform, account, window bounds); never order numbers or buyers. */
  readonly logger?: SyncLogger;
}

export type SyncLogger = Pick<RootLogger, 'info' | 'warn' | 'error'>;

export interface SyncRegistry {
  get(platform: RegisteredPlatform): Pick<UnionAdapter, 'listOrders' | 'getPddOrderDetail'>;
}
