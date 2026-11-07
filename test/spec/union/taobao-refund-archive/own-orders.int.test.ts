// B1-04zzu（D10-796 ② 甲）：orders 的只读「自家淘宝订单查询」readOwnTaobaoOrderNos 在真库上的取值：所问单号里，
// 与本 app 已入库的淘宝订单的 sub_order_id 或 parent_order_id 原样相等的那些。别的 app、别的平台不算；只命中
// parent_order_id 也算；空入参答空集。真库由 @couli/db/testing 的 createTestDatabase 克隆，应用角色连接；
// 订单行用 orders/list-detail 的夹具写入（只读复用）。单号全部合成。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readOwnTaobaoOrderNos } from '../../../../apps/api/src/modules/orders/index.ts';
import { fixture } from '../../orders/list-detail/kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

/** A synthetic 19-digit 淘宝 order number. */
function no(n: number): string {
  return `${2900000000000070000n + BigInt(n)}`;
}

/** A stored order of the fixture's app on `platform` with these order numbers. */
async function stored(
  f: Awaited<ReturnType<typeof fixture>>,
  sub: string,
  parent: string | null,
  platform = 'taobao',
) {
  await f.seed({
    platform,
    sub_order_id: sub,
    parent_order_id: parent,
    product_key: null,
    raw_item_id: 'synthetic-refund-archive-item',
  });
}

async function own(appId: string, orderNos: readonly string[]): Promise<string[]> {
  const found = await readOwnTaobaoOrderNos(db, appId, orderNos);
  expect(found).toBeInstanceOf(Set);
  return [...found].sort();
}

it('[AC-B1-04zzu#15] 同 app 的淘宝订单：与 sub_order_id 原样相等的单号在结果里；没入库的、多了空白或前导零的不在', async () => {
  const f = await fixture(db);
  await stored(f, no(1), no(100));
  await stored(f, no(2), null);

  expect(await own(f.subject.app_id, [no(1), no(2), no(3)])).toEqual([no(1), no(2)].sort());
  expect(await own(f.subject.app_id, [` ${no(1)}`, `${no(1)} `, `0${no(1)}`, no(3)])).toEqual([]);
});

it('[AC-B1-04zzu#16] 别的 app 的同号淘宝订单不算：只在它自己的 app 下才找得到', async () => {
  const mine = await fixture(db);
  const other = await fixture(db);
  await stored(other, no(11), no(110));

  expect(await own(mine.subject.app_id, [no(11), no(110)])).toEqual([]);
  expect(await own(other.subject.app_id, [no(11), no(110)])).toEqual([no(11), no(110)].sort());
});

it('[AC-B1-04zzu#17] 同 app 别的平台（京东、拼多多）的同号订单不算淘宝订单', async () => {
  const f = await fixture(db);
  await stored(f, no(21), no(210), 'jd');
  await stored(f, no(22), no(220), 'pdd');

  expect(await own(f.subject.app_id, [no(21), no(210), no(22), no(220)])).toEqual([]);
});

it('[AC-B1-04zzu#18] 只命中 parent_order_id 也算凑狸订单（父单下几个子单也只答一次）；子单号与父单号同问各自在结果里', async () => {
  const f = await fixture(db);
  await stored(f, no(31), no(300));
  await stored(f, no(32), no(300));

  expect(await own(f.subject.app_id, [no(300)])).toEqual([no(300)]);
  expect(await own(f.subject.app_id, [no(31), no(300), no(33)])).toEqual([no(31), no(300)].sort());
});

it('[AC-B1-04zzu#19] 空入参答空集；重复的单号只答一次', async () => {
  const f = await fixture(db);
  await stored(f, no(41), no(410));

  expect(await own(f.subject.app_id, [])).toEqual([]);
  expect(await own(f.subject.app_id, [no(41), no(41), no(410), no(410)])).toEqual(
    [no(41), no(410)].sort(),
  );
});
