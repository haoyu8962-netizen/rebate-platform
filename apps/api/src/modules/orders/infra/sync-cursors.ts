// B1-08g: app.sync_cursors store (规划/04 §3.2, 02 §7.1). advance() runs in one transaction: a
// compare-and-set from window_start to window_end, or an insert when the stream has no row yet.
// A stale, duplicate or out-of-order window changes nothing and resolves false.
// B1-04zt: rewind() moves an increment stream's start; see SyncCursorStore.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { instantAt, parseInstantMs } from '../domain/sync-window.ts';
import type {
  OrderSyncWindow,
  RescanCursorStore,
  RescanStream,
  SyncCursorStore,
  SyncStream,
} from '../application/sync-ports.ts';

export function createSyncCursorStore(db: Kysely<DB>, clock: Clock): SyncCursorStore {
  const app = db.withSchema('app');
  return {
    async read(stream: SyncStream) {
      const row = await app
        .selectFrom('sync_cursors')
        .select('cursor_at')
        .where('app_id', '=', stream.app_id)
        .where('platform', '=', stream.platform)
        .where('union_account_id', '=', stream.union_account_id)
        .where('query_kind', '=', stream.query_kind)
        .where('scene', '=', stream.scene)
        .executeTakeFirst();
      if (row === undefined) return null;
      // node-postgres returns timestamptz as a Date.
      return row.cursor_at.toISOString();
    },
    async advance(win: OrderSyncWindow) {
      const now = clock.now();
      const start = instantAt(now, parseInstantMs(win.window_start, 'window_start'));
      const end = instantAt(now, parseInstantMs(win.window_end, 'window_end'));
      return db.transaction().execute(async (trx) => {
        const t = trx.withSchema('app');
        // READ COMMITTED: a concurrent winner's commit makes this re-check cursor_at and miss.
        const updated = await t
          .updateTable('sync_cursors')
          .set({ cursor_at: end, updated_at: now })
          .where('app_id', '=', win.app_id)
          .where('platform', '=', win.platform)
          .where('union_account_id', '=', win.union_account_id)
          .where('query_kind', '=', win.query_kind)
          .where('scene', '=', win.scene)
          .where('cursor_at', '=', start)
          .executeTakeFirst();
        if (updated.numUpdatedRows > 0n) return true;
        const inserted = await t
          .insertInto('sync_cursors')
          .values({
            app_id: win.app_id,
            platform: win.platform,
            union_account_id: win.union_account_id,
            query_kind: win.query_kind,
            scene: win.scene,
            cursor_at: end,
            updated_at: now,
          })
          .onConflict((oc) =>
            oc
              .columns(['app_id', 'platform', 'union_account_id', 'query_kind', 'scene'])
              .doNothing(),
          )
          .executeTakeFirst();
        return (inserted.numInsertedOrUpdatedRows ?? 0n) > 0n;
      });
    },
    async rewind(stream: SyncStream, expected: string | null, to: string) {
      const now = clock.now();
      const target = instantAt(now, parseInstantMs(to, 'to'));
      if (expected === null) {
        // One statement: of two concurrent inserts the loser resolves false, it never raises.
        const inserted = await app
          .insertInto('sync_cursors')
          .values({
            app_id: stream.app_id,
            platform: stream.platform,
            union_account_id: stream.union_account_id,
            query_kind: stream.query_kind,
            scene: stream.scene,
            cursor_at: target,
            updated_at: now,
          })
          .onConflict((oc) =>
            oc
              .columns(['app_id', 'platform', 'union_account_id', 'query_kind', 'scene'])
              .doNothing(),
          )
          .executeTakeFirst();
        return (inserted.numInsertedOrUpdatedRows ?? 0n) > 0n;
      }
      // One statement, one transaction; a concurrent advance's commit makes this re-check and miss.
      const updated = await app
        .updateTable('sync_cursors')
        .set({ cursor_at: target, updated_at: now })
        .where('app_id', '=', stream.app_id)
        .where('platform', '=', stream.platform)
        .where('union_account_id', '=', stream.union_account_id)
        .where('query_kind', '=', stream.query_kind)
        .where('scene', '=', stream.scene)
        .where('cursor_at', '=', instantAt(now, parseInstantMs(expected, 'expected')))
        .executeTakeFirst();
      return updated.numUpdatedRows > 0n;
    },
  };
}

/** B1-04zm: createSyncCursorStore plus rewind(); see RescanCursorStore. */
export function createRescanCursorStore(db: Kysely<DB>, clock: Clock): RescanCursorStore {
  return {
    ...createSyncCursorStore(db, clock),
    async rewind(stream: RescanStream, expected: string, to: string) {
      const now = clock.now();
      // One statement, one transaction; a concurrent advance's commit makes this re-check and miss.
      const updated = await db
        .withSchema('app')
        .updateTable('sync_cursors')
        .set({ cursor_at: instantAt(now, parseInstantMs(to, 'to')), updated_at: now })
        .where('app_id', '=', stream.app_id)
        .where('platform', '=', stream.platform)
        .where('union_account_id', '=', stream.union_account_id)
        .where('query_kind', '=', stream.query_kind)
        .where('scene', '=', stream.scene)
        .where('cursor_at', '=', instantAt(now, parseInstantMs(expected, 'expected')))
        .executeTakeFirst();
      return updated.numUpdatedRows > 0n;
    },
  };
}
