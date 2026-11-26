import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assigned, fixture, open, type Harness } from '../admin-assign/db-kit.ts';
import { fixture as claimFixture, success } from '../claims-review/kit.ts';

let database: TestDatabase | undefined;
let h: Harness;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-08zza#18] 订单约束接收 link、拒绝未知值，后台指派保留场景依据', async () => {
  const f = await fixture(h);
  const seeded = f.order({
    platform: 'pdd',
    buy_type: 'share',
    scene_basis: 'link',
    rebate_status: 'VOID',
    platform_status: 'INVALID',
  });
  // 漏改 CHECK 时插入会被库拒绝，放开整个 CHECK 时未知值会写入成功。
  await expect(seeded).resolves.toMatchObject({ scene_basis: 'link', user_basis: null });
  const order = await seeded;
  const invalid = h.db
    .updateTable('orders')
    .set({ scene_basis: 'unknown-scene-basis' })
    .where('app_id', '=', f.appId)
    .where('order_id', '=', order.order_id);
  await expect(invalid.execute()).rejects.toMatchObject({
    code: '23514',
    constraint: 'orders_scene_basis_check',
  });

  assigned(await f.assign(order));
  // 错把 admin 同时写入场景依据，或重算分类，都会使约束拒绝或使落库值不同。
  expect((await f.state()).orders).toMatchObject([
    { user_id: f.subject.user_id, user_basis: 'admin', scene_basis: 'link', buy_type: 'share' },
  ]);
});

it('[AC-B1-08zza#19] 找回通过只写用户依据 claim，保留订单的 link 与 buy_type', async () => {
  const f = await claimFixture(h);
  const seeded = f.order({ scene_basis: 'link', buy_type: 'share', platform: 'pdd' });
  await expect(seeded).resolves.toMatchObject({ user_id: null, scene_basis: 'link' });
  const claim = await f.claim({ platform: 'pdd', order_no_type: 'sub' });
  const item = await f.item(claim, await seeded);
  expect(success(await f.review('approve', item)).status).toBe('approved');

  // 错把找回用户依据覆盖到场景依据，或把原链接分类重判成兜底，会改变订单原值。
  expect((await f.state()).orders).toMatchObject([
    { user_id: claim.user_id, user_basis: 'claim', scene_basis: 'link', buy_type: 'share' },
  ]);
});
