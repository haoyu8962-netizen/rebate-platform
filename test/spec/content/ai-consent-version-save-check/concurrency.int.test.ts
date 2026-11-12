// B1-22zb 规则测试第 2 轮（编排 D10-1349 ②；规划/08 BR-AI-13 细则「当前版本的取值」③，
// SPEC_REF ea7850e2f45f）：只增不减在并发下也成立。现值 3，两个保存同时进来：一个写 5，另一个
// 带着对方提交后的版本号写 4。不论走哪条路（单值改、批量、回滚），终值都是 5，写 4 的那个被拒
// 20001（fields 按各路现有语义：单值 [value]、批量 [该键]、回滚 [to_version]），什么都没写。
//
// 先后顺序不靠猜测的等待：测试自己在另一个事务里 SELECT … FOR UPDATE 锁住该键的行，先放写 5
// 的请求进来，等 PostgreSQL 报告它在等锁，再放写 4 的请求进来，等到两个都在等锁后才放锁
// （PostgreSQL 行锁按排队先后交给等待者，写 5 的先拿到）。骨架上没有本校验时写 4 的那个照样
// 保存（预期版本号对得上），终值成了 4——红的原因是「该拒没拒」。
//
// 首次写入：库里还没有这一行（setup 另起一个 app_id，不写任何其他配置行）。写 4 的请求在另一个
// admin 入口上（独占一条连接）先进来，停在它第一条读写 config_items 的语句前；写 5 的请求在
// 原入口上做完首次写入并提交后，写 4 的才往下走。结果仍须只增不减：终值 5，写 4 的被拒。
// 只在编排者的隔离 PG / Redis 容器里跑。
import { sql, type DatabaseConnection, type QueryResult } from 'kysely';
import { expect, it, vi } from 'vitest';
import { factory, useHarness, type HttpApp, type Response } from '../../admin/auth/kit.ts';
import {
  batch,
  current,
  putRow,
  rejected,
  rollback,
  setup,
  snapshot,
  stepUp,
  success,
  update,
  versionsOf,
  written,
  type Item,
  type Setup,
} from '../config-items/kit.ts';

const h = useHarness();

const KEY = 'legal.ai_third_party.version';
/** Another config.risk key (B1-22y): the batch stays on one permission point. */
const GUEST = 'agent.guest_daily_quota';

interface Tracked<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
}

/** A request whose completion can be looked at while it runs. */
function track<T>(promise: Promise<T>): Tracked<T> {
  const state = { settled: false };
  const watched = promise.finally(() => {
    state.settled = true;
  });
  return {
    promise: watched,
    get settled() {
      return state.settled;
    },
  };
}

/**
 * True once at least `count` backends of the test database wait on a lock; false when one of the
 * requests ended first or after the timeout (the caller asserts).
 */
async function waiting(count: number, pending: readonly Tracked<unknown>[], timeoutMs = 10_000) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    const result = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(h.db);
    if (Number(result.rows[0]?.n ?? '0') >= count) return true;
    if (pending.some((request) => request.settled)) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/**
 * Holds the row of KEY FOR UPDATE, lets `first` queue on it, then `second` behind it, and only then
 * releases the row: `first` is served first, `second` sees what `first` committed.
 */
async function queuedOnRow(
  f: Setup,
  first: () => Promise<Response>,
  second: () => Promise<Response>,
): Promise<{ first: Response; second: Response }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve;
  });
  const holder = h.db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('config_items')
      .select('version')
      .where('app_id', '=', f.appId)
      .where('key', '=', KEY)
      .forUpdate()
      .executeTakeFirst();
    expect(row, 'the held row exists').toBeDefined();
    markLocked();
    await released;
  });
  const pending: Tracked<Response>[] = [];
  try {
    await Promise.race([locked, holder]);
    const a = track(first());
    pending.push(a);
    expect(await waiting(1, [a]), 'the write of 5 waits on the held row').toBe(true);
    const b = track(second());
    pending.push(b);
    expect(await waiting(2, [a, b]), 'the write of 4 queues behind the write of 5').toBe(true);
    release();
    await holder;
    return { first: await a.promise, second: await b.promise };
  } finally {
    release();
    await holder.catch(() => undefined);
    await Promise.allSettled(pending.map((request) => request.promise));
  }
}

/**
 * Runs `second` on its own admin entry over one dedicated connection and parks it before its first
 * statement on config_items; `first` runs on the fixture's entry meanwhile and finishes (commits),
 * then `second` goes on. Asserts that `second` really reached config_items while `first` ran.
 */
async function parkedBehind(
  f: Setup,
  first: () => Promise<Response>,
  second: (app: HttpApp) => Promise<Response>,
): Promise<{ first: Response; second: Response }> {
  return h.db.connection().execute(async (dbB) => {
    const connection = await dbB.getExecutor().provideConnection(async (value) => value);
    const appB = await (
      await factory()
    )('admin', {
      ...f.overrides,
      dbHandles: { db: dbB, dbRead: null, close: async () => undefined },
    });
    let go!: () => void;
    const resumed = new Promise<void>((resolve) => {
      go = resolve;
    });
    let markEntered!: () => void;
    const reached = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let entered = false;
    let pending: Promise<Response> | undefined;
    const execute = connection.executeQuery.bind(connection);
    try {
      await appB.init();
      const spy = vi
        .spyOn(connection, 'executeQuery')
        .mockImplementation(
          async <R>(
            ...args: Parameters<DatabaseConnection['executeQuery']>
          ): Promise<QueryResult<R>> => {
            const [query] = args;
            if (!entered && /\bconfig_items\b/u.test(query.sql)) {
              entered = true;
              markEntered();
              await resumed;
            }
            return execute<R>(...args);
          },
        );
      try {
        pending = second(appB);
        await Promise.race([reached, pending]);
        expect(entered, 'the write of 4 reaches config_items before the write of 5').toBe(true);
        const firstResponse = await first();
        go();
        return { first: firstResponse, second: await pending };
      } finally {
        go();
        spy.mockRestore();
        await pending?.catch(() => undefined);
      }
    } finally {
      await appB.close();
    }
  });
}

/** The config_item_change / config_item_rollback audit rows of the app. */
async function changeAudits(f: Setup) {
  return (await snapshot(h, f.appId)).audits.filter(
    (audit) => audit.action === 'config_item_change' || audit.action === 'config_item_rollback',
  );
}

it('[AC-B1-22zb#19] 并发单值改：现值 3，写 5 与（带对方提交后的版本号）写 4 同时进来 → 终值 5，写 4 的 20001 [value]、没写', async () => {
  const f = await setup(h);
  await putRow(h, f.appId, KEY, 3);
  // Each write carries its own totp step-up token (one request per token, see #22).
  const tokenOf5 = await stepUp(f);
  const tokenOf4 = await stepUp(f);
  const result = await queuedOnRow(
    f,
    () => update(f, KEY, { value: 5, expected_version: 1 }, { stepUp: tokenOf5 }),
    () => update(f, KEY, { value: 4, expected_version: 2 }, { stepUp: tokenOf4 }),
  );
  expect(await success<Item>(result.first, 'update')).toMatchObject({
    key: KEY,
    value: 5,
    version: 2,
  });
  await rejected(result.second, 'update', 20001, { fields: ['value'] });
  expect(await current(h, f.appId, KEY)).toMatchObject({ value: 5, version: 2 });
  expect(
    (await versionsOf(h, f.appId, KEY)).map(({ version, value }) => ({ version, value })),
  ).toStrictEqual([{ version: 2, value: 5 }]);
  expect(await changeAudits(f)).toHaveLength(1);
});

it('[AC-B1-22zb#20] 并发批量：现值 3，批量写 5 与（带对方提交后的版本号）批量写 4 同时进来 → 终值 5，写 4 的整批 20001 [该键]、同批别的键也没写', async () => {
  const f = await setup(h);
  await putRow(h, f.appId, KEY, 3);
  await putRow(h, f.appId, GUEST, 20);
  // Each write carries its own totp step-up token (one request per token, see #22).
  const tokenOf5 = await stepUp(f);
  const tokenOf4 = await stepUp(f);
  const result = await queuedOnRow(
    f,
    () => batch(f, { items: [{ key: KEY, value: 5, expected_version: 1 }] }, { stepUp: tokenOf5 }),
    () =>
      batch(
        f,
        {
          items: [
            { key: GUEST, value: 10, expected_version: 1 },
            { key: KEY, value: 4, expected_version: 2 },
          ],
        },
        { stepUp: tokenOf4 },
      ),
  );
  const saved = await success<{ items: Item[] }>(result.first, 'batch');
  expect(saved.items.map(({ key, value, version }) => ({ key, value, version }))).toStrictEqual([
    { key: KEY, value: 5, version: 2 },
  ]);
  await rejected(result.second, 'batch', 20001, { fields: [KEY] });
  expect(await current(h, f.appId, KEY)).toMatchObject({ value: 5, version: 2 });
  expect(await current(h, f.appId, GUEST)).toMatchObject({ value: 20, version: 1 });
  expect(
    (await versionsOf(h, f.appId, KEY)).map(({ version, value }) => ({ version, value })),
  ).toStrictEqual([{ version: 2, value: 5 }]);
  expect(await versionsOf(h, f.appId, GUEST)).toStrictEqual([]);
  expect(await changeAudits(f)).toHaveLength(1);
});

it('[AC-B1-22zb#21] 并发回滚：现值 3（历史 v1=5、v2=4），回滚到 5 与（带对方提交后的版本号）回滚到 4 同时进来 → 终值 5，回滚到 4 的 20001 [to_version]、没写', async () => {
  const f = await setup(h);
  await written(h, f.appId, KEY, [5, 4, 3], f.actor);
  // Each write carries its own totp step-up token (one request per token, see #22).
  const tokenOf5 = await stepUp(f);
  const tokenOf4 = await stepUp(f);
  const result = await queuedOnRow(
    f,
    () => rollback(f, KEY, { to_version: 1, expected_version: 3 }, { stepUp: tokenOf5 }),
    () => rollback(f, KEY, { to_version: 2, expected_version: 4 }, { stepUp: tokenOf4 }),
  );
  expect(await success<Item>(result.first, 'rollback')).toMatchObject({
    key: KEY,
    value: 5,
    version: 4,
  });
  await rejected(result.second, 'rollback', 20001, { fields: ['to_version'] });
  expect(await current(h, f.appId, KEY)).toMatchObject({ value: 5, version: 4 });
  expect(
    (await versionsOf(h, f.appId, KEY)).map(({ version, value }) => ({ version, value })),
  ).toStrictEqual([
    { version: 1, value: 5 },
    { version: 2, value: 4 },
    { version: 3, value: 3 },
    { version: 4, value: 5 },
  ]);
  expect(await changeAudits(f)).toHaveLength(1);
});

it('[AC-B1-22zb#22] 首次写入并发（单值改）：还没有这一行时，写 4（带对方提交后的版本号 1）先进来、写 5 做完首次写入 → 终值 5，写 4 的 20001 [value]、没写', async () => {
  const f = await setup(h);
  expect(await current(h, f.appId, KEY)).toBeUndefined();
  // Each write carries its own totp step-up token: a token is used by one request only (a second
  // request with a token in use is refused 10003 before it reaches config_items).
  const tokenOf5 = await stepUp(f);
  const tokenOf4 = await stepUp(f);
  const result = await parkedBehind(
    f,
    () => update(f, KEY, { value: 5, expected_version: 0 }, { stepUp: tokenOf5 }),
    (app) => update(f, KEY, { value: 4, expected_version: 1 }, { stepUp: tokenOf4, app }),
  );
  expect(await success<Item>(result.first, 'update')).toMatchObject({
    key: KEY,
    value: 5,
    version: 1,
  });
  await rejected(result.second, 'update', 20001, { fields: ['value'] });
  expect(await current(h, f.appId, KEY)).toMatchObject({ value: 5, version: 1 });
  expect(
    (await versionsOf(h, f.appId, KEY)).map(({ version, value }) => ({ version, value })),
  ).toStrictEqual([{ version: 1, value: 5 }]);
  expect(await changeAudits(f)).toHaveLength(1);
});

it('[AC-B1-22zb#23] 首次写入并发（批量）：还没有这一行时，批量写 4（带对方提交后的版本号 1）先进来、批量写 5 做完首次写入 → 终值 5，写 4 的整批 20001 [该键]、没写', async () => {
  const f = await setup(h);
  expect(await current(h, f.appId, KEY)).toBeUndefined();
  // Each write carries its own totp step-up token (one request per token, see #22).
  const tokenOf5 = await stepUp(f);
  const tokenOf4 = await stepUp(f);
  const result = await parkedBehind(
    f,
    () => batch(f, { items: [{ key: KEY, value: 5, expected_version: 0 }] }, { stepUp: tokenOf5 }),
    (app) =>
      batch(
        f,
        {
          items: [
            { key: GUEST, value: 10, expected_version: 0 },
            { key: KEY, value: 4, expected_version: 1 },
          ],
        },
        { stepUp: tokenOf4, app },
      ),
  );
  const saved = await success<{ items: Item[] }>(result.first, 'batch');
  expect(saved.items.map(({ key, value, version }) => ({ key, value, version }))).toStrictEqual([
    { key: KEY, value: 5, version: 1 },
  ]);
  await rejected(result.second, 'batch', 20001, { fields: [KEY] });
  expect(await current(h, f.appId, KEY)).toMatchObject({ value: 5, version: 1 });
  expect(await current(h, f.appId, GUEST)).toBeUndefined();
  expect(
    (await versionsOf(h, f.appId, KEY)).map(({ version, value }) => ({ version, value })),
  ).toStrictEqual([{ version: 1, value: 5 }]);
  expect(await changeAudits(f)).toHaveLength(1);
});
