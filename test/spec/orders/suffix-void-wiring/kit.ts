// B1-09z (FU-SUFFIX-VOID-WIRING) rule-test kit, 08 BR-ATTR-26 ①. The switch under test is read by
// the production assembly (AppModule.forEntry({ entry: 'worker' }) → orderSyncPorts →
// suffixVoidEnabled → the pipeline's step ③), so nothing here injects a switch value: the only way
// in is a config_items row of the order's App. Every order goes through the pipeline of the real
// worker that ../rebate-wiring/kit.ts builds (real field keyring, real risk blocklist ports, real
// settlement BLACKLIST_HIT, real content reader); only its job queue is a stub.
// The orders are taobao (the only platform of the suffix dimension): paid (taobao.csv code 12),
// attributed through an active union_bindings row of the relation id, attr_at = paid_at.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import type { OrderSyncRuntime } from '../../../../apps/api/src/modules/orders/index.ts';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { BEFORE, level, PAID } from '../../commission/resolver/kit.ts';
import { seedVersion, version } from '../../commission/snapshot/fixtures.ts';
import { capture, order } from '../attribution/kit.ts';
import { keyedWorker, SYNCED } from '../rebate-wiring/kit.ts';
import { runtime } from '../wiring/context-kit.ts';
import { account, at, pid, user } from '../wiring/db-kit.ts';

export { TIMEOUT } from '../rebate-wiring/kit.ts';

export const SWITCH = 'attr.blacklist.order_suffix_void_enabled';
/** The blocklist value of the suffix dimension (08's example). */
export const SUFFIX = '123456';
/** A parent order number whose last 6 characters are SUFFIX (08's example). */
export const PARENT_HIT = '3301987654123456';
/** taobao.csv: 12 = PLATFORM_PAID. */
const TAOBAO_PAID = '12';
const BOUND_AT = at('2026-10-01T00:00:00.000Z');

export interface TaobaoApp {
  readonly appId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly relationId: string;
}

/** A taobao app: union account, promotion slot, owner bound to a relation id, rule version. */
async function seedTaobaoApp(db: Kysely<DB>): Promise<TaobaoApp> {
  const a = await account(db, { platform: 'taobao' });
  const owner = await user(db, a.app_id);
  await pid(db, a);
  await level(db, a.app_id, owner.id, 'L1', BEFORE);
  await seedVersion(db, a.app_id, version());
  const relationId = `rel-${randomUUID().slice(0, 8)}`;
  await db
    .insertInto('union_bindings')
    .values({
      id: randomUUID(),
      app_id: a.app_id,
      user_id: owner.id,
      platform: 'taobao',
      union_account_id: a.id,
      relation_id: relationId,
      status: 'active',
      bound_at: BOUND_AT,
      released_at: null,
      cooldown_until: null,
      created_at: BOUND_AT,
      updated_at: BOUND_AT,
    })
    .execute();
  return { appId: a.app_id, userId: owner.id, accountId: a.id, relationId };
}

/** One production worker over `db`, any number of taobao apps; the caller closes it. */
export async function world(db: Kysely<DB>) {
  const worker = await keyedWorker(db);
  try {
    const r: OrderSyncRuntime = await runtime(worker.context);
    const clock = worker.clock;
    clock.set(SYNCED);
    let sequence = 0;

    /** One new taobao sub-order of `app` through the production pipeline; it must go through. */
    async function sync(app: TaobaoApp, patch: Partial<UnionOrder> = {}): Promise<void> {
      sequence += 1;
      clock.advanceMs(60_000);
      const incoming = order({
        platform: 'taobao',
        order_id: randomUUID(),
        sub_order_id: randomUUID(),
        parent_order_id: PARENT_HIT,
        raw_status: TAOBAO_PAID,
        attr_params: { relation_id: app.relationId, sub_union_id: null, custom_parameters: null },
        commission_fen: 1000n,
        est_commission_fen: 1000n,
        paid_at: PAID,
        modified_at: at('2026-10-20T03:00:00.000Z'),
        raw_payload_id: `${100 + sequence}`,
        ...patch,
      });
      const result = await capture(() =>
        r.pipeline.process(incoming, {
          app_id: app.appId,
          platform: 'taobao',
          union_account_id: app.accountId,
          query_kind: 'increment',
          scene: '-',
          window_start: '2026-10-01T02:03:04.000Z',
          window_end: clock.now().toISOString(),
          requestId: randomUUID(),
        }),
      );
      expect(result).toMatchObject({ ok: true });
    }

    return {
      seed: () => seedTaobaoApp(db),
      sync,
      close: worker.close,
      /** The app's only order. */
      row: (app: TaobaoApp) =>
        db
          .selectFrom('orders')
          .selectAll()
          .where('app_id', '=', app.appId)
          .executeTakeFirstOrThrow(),
      hits: (app: TaobaoApp) =>
        db
          .selectFrom('risk_hits')
          .selectAll()
          .where('app_id', '=', app.appId)
          .orderBy('risk_action')
          .execute(),
      splits: (app: TaobaoApp) =>
        db.selectFrom('commission_splits').selectAll().where('app_id', '=', app.appId).execute(),
      async eventNames(app: TaobaoApp) {
        const rows = await db
          .selectFrom('event_log')
          .select('name')
          .where('app_id', '=', app.appId)
          .execute();
        return rows.map((event) => event.name);
      },
      /** The switch as content stores it: one config_items row of the app. */
      async setSwitch(app: TaobaoApp, value: unknown) {
        await db
          .insertInto('config_items')
          .values({
            app_id: app.appId,
            key: SWITCH,
            value: JSON.stringify(value),
            version: 1,
            updated_by: 'fixture',
          })
          .execute();
      },
      /** An active suffix entry (taobao, SUFFIX) of the app. */
      async blockSuffix(app: TaobaoApp) {
        await db
          .insertInto('blocklist')
          .values({
            id: randomUUID(),
            app_id: app.appId,
            dimension: 'order_no_suffix',
            value: SUFFIX,
            value_hmac: null,
            platform: 'taobao',
            union_account_id: null,
            start_at: null,
            end_at: null,
            expire_at: null,
            status: 'active',
            violation_type: 'other',
            created_by: 'fixture-admin',
            created_at: BOUND_AT,
            updated_at: BOUND_AT,
          })
          .execute();
      },
      /** An active channel entry of the app's relation id, covering attr_at. */
      async blockChannel(app: TaobaoApp) {
        await db
          .insertInto('blocklist')
          .values({
            id: randomUUID(),
            app_id: app.appId,
            dimension: 'channel',
            value: app.relationId,
            value_hmac: null,
            platform: 'taobao',
            union_account_id: app.accountId,
            start_at: BOUND_AT,
            end_at: null,
            expire_at: null,
            status: 'active',
            violation_type: 'other',
            created_by: 'fixture-admin',
            created_at: BOUND_AT,
            updated_at: BOUND_AT,
          })
          .execute();
      },
    };
  } catch (error) {
    await worker.close();
    throw error;
  }
}

export type World = Awaited<ReturnType<typeof world>>;

/** Runs `test` on a fresh worker and always closes it. */
export async function withWorld(db: Kysely<DB>, test: (w: World) => Promise<void>): Promise<void> {
  const w = await world(db);
  try {
    await test(w);
  } finally {
    await w.close();
  }
}
