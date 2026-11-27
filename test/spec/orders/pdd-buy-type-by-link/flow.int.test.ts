import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Insertable, Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readOrderAttributionLink } from '../../../../apps/api/src/modules/linking/index.ts';
import { createOrderSourcePorts } from '../../../../apps/api/src/modules/orders/application/source-ports.ts';
import { platformRules } from '../../../../apps/api/src/modules/orders/domain/platform-rules/index.ts';
import {
  createOrderPipeline,
  type OrderPipelineDeps,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type { UnionAdapter, UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { at, ATTR, fixture, order, RECEIVED, traceQueries } from '../attribution/kit.ts';
import { scenario } from '../platform-status/kit.ts';
import { config } from '../source-wiring/db-kit.ts';
import { wired } from '../source-wiring/kit.ts';
import { job } from '../sync/kit.ts';
import { account, built, pid, START, user } from '../wiring/db-kit.ts';
import { GOODS_ID, GOODS_SIGN, LK, params, seedLink } from './kit.ts';

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

const FALLBACK = { buy_type: 'self', scene_basis: 'fallback' };
const SHARE_BY_LINK = { buy_type: 'share', scene_basis: 'link' };
const SHARE_BY_PID = { buy_type: 'share', scene_basis: 'pid' };

async function setup(fields: Record<string, unknown> = { lk: LK, sc: 'share' }) {
  const f = await fixture(db, {
    goods_id: GOODS_ID,
    goods_sign: GOODS_SIGN,
    attr_params: params(fields),
  });
  const owner = { app_id: f.ctx.app_id, user_id: f.userId };
  const deps: OrderPipelineDeps = {
    ...f.deps,
    readBuyTypeLink: vi.fn(readOrderAttributionLink),
    sources: createOrderSourcePorts({
      keyPrefix: async () => 'pp',
      linkLogs: async () => [],
      configValue: async () => null,
    }),
  };
  return {
    ...f,
    deps,
    seed: (patch?: Partial<Insertable<DB['links']>>) => seedLink(db, owner, patch),
  };
}

async function readOrder(f: Awaited<ReturnType<typeof fixture>>, incoming = f.incoming) {
  return db
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', f.ctx.app_id)
    .where('sub_order_id', '=', incoming.sub_order_id!)
    .executeTakeFirstOrThrow();
}

async function ingest(
  f: Awaited<ReturnType<typeof fixture>>,
  deps: OrderPipelineDeps = f.deps,
  incoming = f.incoming,
) {
  const result = await createOrderPipeline(deps).process(incoming, f.ctx);
  expect(result.kind).toBe('inserted');
  return readOrder(f, incoming);
}

it('[AC-B1-08zza#4] goods_sign 相同即认分享链接，以 uid 归属，推广位与 sc 均冲突', async () => {
  const f = await setup({ lk: LK, sc: 'self_buy' });
  f.findPid.mockResolvedValue([{ pid_scene: 'self_buy', status: 'active', site_id: null }]);
  await f.seed({ scene: 'detail', created_at: at(ATTR) });
  // 误用 goods_id、要求商品键也相同、受来源开关控制或使用推广位/sc/入口 scene，都会丢失 share / link。
  expect(await ingest(f)).toMatchObject({
    ...SHARE_BY_LINK,
    user_id: f.userId,
    user_basis: 'param',
  });
  expect(f.deps.readBuyTypeLink).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ isTransaction: true }),
    { appId: f.ctx.app_id, lk: LK },
  );
});

it('[AC-B1-08zza#5] 自购链接仍记 self / link，回传 sc=share 不能改判', async () => {
  const f = await setup();
  await f.seed({ scene: 'detail', pid_scene: 'self_buy' });
  // 误用 share 推广位、sc 或把自购标成 fallback，都会写出不同的 buy_type / scene_basis。
  expect(await ingest(f)).toMatchObject({ buy_type: 'self', scene_basis: 'link' });
});

it('[AC-B1-08zza#6] 链接用户与 uid 用户不一致时按兜底，订单仍归属 uid 用户', async () => {
  const f = await setup();
  const other = await user(db, f.ctx.app_id, { attr_code: 'wxyz5678' });
  await f.seed({ user_id: other.id });
  // 略过用户校验会判 share / link，拿链接用户覆盖 uid 会写错归属。
  expect(await ingest(f)).toMatchObject({ ...FALLBACK, user_id: f.userId, user_basis: 'param' });
});

it('[AC-B1-08zza#7] 平台不是拼多多的同码链接走 self / fallback', async () => {
  const f = await setup();
  await f.seed({ platform: 'jd' });
  // 只核用户、商品与时间会把这条京东链接误判为 share / link。
  expect(await ingest(f)).toMatchObject(FALLBACK);
});

it('[AC-B1-08zza#8] goods_sign 与 product_key 都不等走 self / fallback', async () => {
  const f = await setup();
  await f.seed({ raw_item_id: 'different-goods-sign', product_key: 'pp:different' });
  // 忽略商品校验会误判 share / link。
  expect(await ingest(f)).toMatchObject(FALLBACK);
});

it('[AC-B1-08zza#9] goods_sign 不等但 product_key 相等仍按分享链接判', async () => {
  const f = await setup();
  await f.seed({ raw_item_id: 'rotated-goods-sign', product_key: `pp:${GOODS_ID}` });
  // 只比 goods_sign 或丢掉平台商品键推导会误判 self / fallback。
  expect(await ingest(f)).toMatchObject(SHARE_BY_LINK);
});

it('[AC-B1-08zza#10] 链接创建晚于付款一毫秒走 self / fallback', async () => {
  const f = await setup();
  await f.seed({ created_at: at('2026-10-15T16:00:00.001Z') });
  // 漏比 paid_at 或误用处理时钟（此时链接已创建）会误判 share / link。
  expect(await ingest(f)).toMatchObject(FALLBACK);
});

it('[AC-B1-08zza#11] 有 lk 但查无记录走 self / fallback', async () => {
  const f = await setup();
  // 错把未知链接当成缺 lk，或继续用回传 sc，都会按分享入库。
  expect(await ingest(f)).toMatchObject(FALLBACK);
});

it('[AC-B1-08zza#12] 按本 App 查 lk，忽略别处同码的链接', async () => {
  const f = await setup();
  const other = await fixture(db);
  await seedLink(db, { app_id: other.ctx.app_id, user_id: other.userId });
  const scope = { appId: f.ctx.app_id, lk: LK };
  // 仅按 lk 查会返回另一 App 的记录，即使下游的用户校验也会拒绝它。
  await expect(readOrderAttributionLink(db, scope)).resolves.toBeNull();
  const local = await f.seed();
  await expect(readOrderAttributionLink(db, scope)).resolves.toMatchObject(local);
});

it.each([null, '', 1234])(
  '[AC-B1-08zza#13] 回传 lk=%j 是不能匹配的短码，走 self / fallback',
  async (lk) => {
    const f = await setup({ lk, sc: 'share' });
    // 把无效的 lk 当作完全没带 lk，就会按 share 推广位判定。
    expect(await ingest(f)).toMatchObject(FALLBACK);
  },
);

it('[AC-B1-08zza#14] 完全缺 lk 且规则默认 pid，沿用推广位及原本的 sc 回退', async () => {
  const f = await setup({ sc: 'self_buy' });
  // 默认提前切到 self 会将 share / pid 错判成 self / fallback。
  expect(platformRules('pdd').missingLinkBuyTypeBasis).toBe('pid');
  expect(await ingest(f)).toMatchObject(SHARE_BY_PID);
  expect(f.deps.readBuyTypeLink).not.toHaveBeenCalled();

  const byParam = await setup({ sc: 'share' });
  byParam.findPid.mockResolvedValue([{ pid_scene: 'fallback', status: 'active', site_id: null }]);
  // 只保留 pid 直判会丢掉旧推广位为 fallback 时的 param 判定。
  expect(await ingest(byParam)).toMatchObject({ buy_type: 'share', scene_basis: 'param' });

  const byFallback = await setup({ sc: 'fallback' });
  byFallback.findPid.mockResolvedValue([
    { pid_scene: 'fallback', status: 'active', site_id: null },
  ]);
  expect(await ingest(byFallback)).toMatchObject(FALLBACK);
});

it('[AC-B1-08zza#15] 仅将注入规则改为 self，完全缺 lk 时走 self / fallback', async () => {
  const f = await setup({ sc: 'share' });
  // 忽略注入规则，或者只在 pid 或 sc 取不到时才兜底，会落成 share / pid。
  expect(
    await ingest(f, {
      ...f.deps,
      buyTypeRules: (platform) => ({
        ...platformRules(platform),
        missingLinkBuyTypeBasis: 'self',
      }),
    }),
  ).toMatchObject(FALLBACK);
  expect(f.deps.readBuyTypeLink).not.toHaveBeenCalled();
});

it('[AC-B1-08zza#16] 已判为 share / pid 的老订单收到自购链接后仍沿用旧判定', async () => {
  const f = await scenario(db, { goods_id: GOODS_ID, goods_sign: GOODS_SIGN });
  expect(f.original).toMatchObject(SHARE_BY_PID);
  await seedLink(db, { app_id: f.ctx.app_id, user_id: f.userId }, { pid_scene: 'self_buy' });
  const deps = { ...f.deps, readBuyTypeLink: readOrderAttributionLink, updateStep: f.step };
  const attrParams = params({ lk: LK });
  const incoming = f.next({
    raw_status: 'received',
    received_at: at(RECEIVED),
    attr_params: attrParams,
  });
  expect(await createOrderPipeline(deps).process(incoming, f.ctx)).toEqual({
    kind: 'updated',
    order_id: f.original.order_id,
  });
  // 若更新订单时重新分类，会把旧的 share / pid 覆盖成 self / link。
  expect(await readOrder(f)).toMatchObject({ ...SHARE_BY_PID, platform_status: 'RECEIVED' });
  const fresh: UnionOrder = { ...f.incoming, sub_order_id: randomUUID(), attr_params: attrParams };
  // 同一链接能决定新订单，防止完全忽略链接的实现把保留旧值的用例跑绿。
  expect(await ingest(f, deps, fresh)).toMatchObject({ buy_type: 'self', scene_basis: 'link' });
});

it('[AC-B1-08zza#17] worker 装配后按 links 判定，来源 exact 复用同一次查询', async () => {
  const traced = traceQueries(db);
  const acc = await account(db);
  const u = await user(db, acc.app_id);
  await pid(db, acc);
  await config(db, acc.app_id, 'attr.click_code.pdd', true);
  const link = await seedLink(
    db,
    { app_id: acc.app_id, user_id: u.id },
    { scene: 'detail', pid_scene: 'self_buy' },
  );
  const incoming = order({
    raw_status: '0',
    sub_order_id: randomUUID(),
    goods_id: GOODS_ID,
    goods_sign: GOODS_SIGN,
    attr_params: params({ lk: LK, sc: 'share' }),
  });
  const f = await wired(traced.db);
  try {
    const listOrders = vi
      .fn<UnionAdapter['listOrders']>()
      .mockResolvedValue({ items: [incoming], nextCursor: null });
    vi.spyOn(f.r.access, 'queryableAccount').mockResolvedValue(acc.id);
    vi.spyOn(f.r.registry, 'get').mockReturnValue({ listOrders });
    const run = f.queue.register.mock.calls.find(([name]) => name === 'order-sync')?.[1];
    expect(typeof run).toBe('function');
    await built(() =>
      run!(
        job({
          app_id: acc.app_id,
          platform: 'pdd',
          union_account_id: acc.id,
          query_kind: 'increment',
          scene: '-',
          window_start: START,
          window_end: '2026-10-17T17:00:00.000Z',
        }),
      ),
    );
    // 漏装链接读口会留下 share / pid，若两步各查 links，查询次数会是 2。
    const row = await db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', acc.app_id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      buy_type: 'self',
      scene_basis: 'link',
      source_match: 'exact',
      source_scene: 'detail',
      link_id: link.link_id,
    });
    const linkQueries = traced.queries.filter(({ sql }) =>
      /^select\b.*\bfrom "app"\."links"(?:\s|$)/i.test(sql),
    );
    expect(linkQueries).toHaveLength(1);
  } finally {
    await f.context.close();
  }
});

it('[AC-B1-08zza#20] 预售比尾款时间，创建于定金与尾款之间的链接有效', async () => {
  const f = await setup();
  await f.seed();
  const incoming = { ...f.incoming, deposit_paid_at: at('2026-10-13T12:00:00.000Z') };
  // 若误用由定金决定的 attr_at，比尾款早的链接会被排除。
  expect(await ingest(f, f.deps, incoming)).toMatchObject(SHARE_BY_LINK);
});

it('[AC-B1-08zza#21] 启用链接判定的拼多多走 link，京东与淘宝仍走 pid', async () => {
  for (const platform of ['jd', 'taobao'] as const) {
    const f = await fixture(db, {
      platform,
      itemId: 'test-order-goods-sign',
      item_id: 'test-order-goods-sign',
      attr_params: { ...params({ lk: LK }), sub_union_id: `n_abcd1234_${LK}` },
    });
    await seedLink(
      db,
      { app_id: f.ctx.app_id, user_id: f.userId },
      { platform, scene: 'detail', pid_scene: 'self_buy' },
    );
    const readBuyTypeLink = vi.fn(readOrderAttributionLink);
    // 若错误地对其他平台启用这条资金规则，订单会改判或多查一次链接。
    expect(await ingest(f, { ...f.deps, readBuyTypeLink })).toMatchObject(SHARE_BY_PID);
    expect(readBuyTypeLink).not.toHaveBeenCalled();
  }
  const pdd = await setup();
  await pdd.seed();
  expect(await ingest(pdd)).toMatchObject(SHARE_BY_LINK);
});
