import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture, expectSnapshot, seedVersion, version } from './db-kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it.each([
  { ac: 5, status: 'normal', expected: 'active' },
  { ac: 6, status: 'deleted', expected: 'forfeited' },
])(
  '[AC-B1-08w#$ac] 生产 PAID 入库生成真实快照，直推 $status，历史取 paid_at',
  async ({ status, expected }) => {
    const f = await fixture(db, status);
    try {
      const { seedPddLink } = await import('../pdd-link-fixture/seed.ts');
      await seedPddLink(db, {
        app_id: f.appId,
        user_id: f.owner,
        lk: 'b108zzf',
        raw_item_id: 'b108zzf-goods-sign',
        pid_scene: 'share',
        created_at: new Date('2026-10-01T00:00:00.000Z'),
      });
      Object.assign(f.incoming, {
        goods_sign: 'b108zzf-goods-sign',
        attr_params: {
          relation_id: null,
          sub_union_id: null,
          custom_parameters: JSON.stringify({
            ...(JSON.parse(f.incoming.attr_params?.custom_parameters ?? '{}') as Record<
              string,
              unknown
            >),
            lk: 'b108zzf',
          }),
        },
      });
      const rules = version();
      await seedVersion(db, f.appId, rules);
      await f.process();
      const before = await expectSnapshot(f, expected);
      expect(before[0]!.rule_version_id).toBe(rules.rule_version_id);
      expect((await f.orders())[0]!.platform_status).toBe('PAID');
      expect(await f.pending()).toEqual([]);
      // 相同已归一订单重投、随后更新到收货都经过同一个生产处理器。
      f.clock.advanceMs(60_000);
      await f.process();
      expect(await f.splits()).toEqual(before);
      f.clock.advanceMs(60_000);
      await f.process({
        ...f.incoming,
        raw_status: '2',
        received_at: f.clock.now(),
        modified_at: f.clock.now(),
        raw_payload_id: '202',
      });
      expect((await f.orders())[0]!.platform_status).toBe('RECEIVED');
      expect(await f.splits()).toEqual(before);
    } finally {
      await f.context.close();
    }
  },
);

it('[AC-B1-08w#7] 空规则库留下待处理，发布版本后生产 snapshot-retry 生成快照并关闭原行', async () => {
  const f = await fixture(db);
  try {
    const { seedPddLink } = await import('../pdd-link-fixture/seed.ts');
    await seedPddLink(db, {
      app_id: f.appId,
      user_id: f.owner,
      lk: 'b108zzf',
      raw_item_id: 'b108zzf-goods-sign',
      pid_scene: 'share',
      created_at: new Date('2026-10-01T00:00:00.000Z'),
    });
    Object.assign(f.incoming, {
      goods_sign: 'b108zzf-goods-sign',
      attr_params: {
        relation_id: null,
        sub_union_id: null,
        custom_parameters: JSON.stringify({
          ...(JSON.parse(f.incoming.attr_params?.custom_parameters ?? '{}') as Record<
            string,
            unknown
          >),
          lk: 'b108zzf',
        }),
      },
    });
    await f.process();
    expect(await f.splits()).toEqual([]);
    const pending = await f.pending();
    expect(pending).toEqual([
      expect.objectContaining({
        reason: 'RULE_VERSION_PLATFORM_MISSING',
        status: 'open',
        resolved_at: null,
      }),
    ]);
    const rules = version();
    await seedVersion(db, f.appId, rules);
    f.clock.advanceMs(60 * 60_000 + 1);
    await f.retry();
    const snapshots = await expectSnapshot(f);
    expect(snapshots[0]!.rule_version_id).toBe(rules.rule_version_id);
    const closed = await f.pending();
    expect(closed).toEqual([
      expect.objectContaining({
        id: pending[0]!.id,
        reason: pending[0]!.reason,
        status: 'resolved',
        created_at: pending[0]!.created_at,
        resolved_at: f.clock.now(),
        resolved_by: null,
      }),
    ]);
    f.clock.advanceMs(60 * 60_000);
    await f.retry();
    expect(await f.splits()).toEqual(snapshots);
    expect(await f.pending()).toEqual(closed);
  } finally {
    await f.context.close();
  }
});

it('[AC-B1-08w#8] 生产更新步骤在规则恢复后使用真实快照端口处置 pending', async () => {
  const f = await fixture(db);
  try {
    const { seedPddLink } = await import('../pdd-link-fixture/seed.ts');
    await seedPddLink(db, {
      app_id: f.appId,
      user_id: f.owner,
      lk: 'b108zzf',
      raw_item_id: 'b108zzf-goods-sign',
      pid_scene: 'share',
      created_at: new Date('2026-10-01T00:00:00.000Z'),
    });
    Object.assign(f.incoming, {
      goods_sign: 'b108zzf-goods-sign',
      attr_params: {
        relation_id: null,
        sub_union_id: null,
        custom_parameters: JSON.stringify({
          ...(JSON.parse(f.incoming.attr_params?.custom_parameters ?? '{}') as Record<
            string,
            unknown
          >),
          lk: 'b108zzf',
        }),
      },
    });
    await f.process();
    expect(await f.splits()).toEqual([]);
    const pending = await f.pending();
    expect(pending).toEqual([
      expect.objectContaining({
        reason: 'RULE_VERSION_PLATFORM_MISSING',
        status: 'open',
      }),
    ]);
    await seedVersion(db, f.appId, version());
    f.clock.advanceMs(60_000);
    await f.process({
      ...f.incoming,
      raw_status: '2',
      received_at: f.clock.now(),
      modified_at: f.clock.now(),
      raw_payload_id: '202',
    });
    await expectSnapshot(f);
    expect((await f.orders())[0]!.platform_status).toBe('RECEIVED');
    expect(await f.pending()).toEqual([
      expect.objectContaining({
        id: pending[0]!.id,
        status: 'resolved',
        resolved_at: f.clock.now(),
      }),
    ]);
  } finally {
    await f.context.close();
  }
});
