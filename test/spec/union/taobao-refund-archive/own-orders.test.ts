// B1-04zzu（D10-796 ② 甲）：orders 在 index.ts 导出的只读「自家淘宝订单查询」readOwnTaobaoOrderNos，不连库的
// 部分：空入参不查库、答空集；非空入参只发只读的 app.orders 查询（同 app、platform taobao、所问单号，去重后
// 每个都在），不加锁、不写任何表；库里没有就答空集。真库上的取值见 own-orders.int.test.ts。数据全部合成。
import { expect, it } from 'vitest';
import { readOwnTaobaoOrderNos } from '../../../../apps/api/src/modules/orders/index.ts';
import { expectOwnOrderRead, recordingDatabase, tradeIdOf } from './kit.ts';

const APP = 'synthetic-refund-archive-orders-app';

it('[AC-B1-04zzu#14] readOwnTaobaoOrderNos：空入参不查库、答空集；非空入参是只读的 app.orders 查询（同 app、淘宝、所问单号），不加锁不写，库里没有答空集', async () => {
  const recorded = recordingDatabase();
  try {
    const none = await readOwnTaobaoOrderNos(recorded.db, APP, []);
    expect(none).toBeInstanceOf(Set);
    expect([...none]).toEqual([]);
    expect(recorded.statements, 'an empty question reads nothing').toEqual([]);

    const nos = [tradeIdOf(1), tradeIdOf(2), tradeIdOf(1)];
    const found = await readOwnTaobaoOrderNos(recorded.db, APP, nos);
    expect(found).toBeInstanceOf(Set);
    expect([...found]).toEqual([]);
    expectOwnOrderRead(recorded.statements, APP, [tradeIdOf(1), tradeIdOf(2)]);
  } finally {
    await recorded.db.destroy();
  }
});
