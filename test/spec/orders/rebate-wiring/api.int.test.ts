// B1-09n · B1-09p 的生产验收（D10-558，D10-565）：订单经真实 worker 入口同步入库，再由真实 api 入口读。两个入口
// 都是 AppModule 组出来的，令牌、PostgreSQL、Redis 都是真的，端口不自注入。用户订单接口的金额非 null，钱包预估与
// 之同数；佣金变化后钱包不抛错。金额手写：N=1000，预留 0，本人 50%，得 500；N=800 得 400。
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { singleBound } from '../../admin/system-audit/kit.ts';
import type { Response } from '../../identity/sms-codes/http-kit.ts';
import { WALLET, wallet } from '../../identity/me-balance/kit.ts';
import {
  closeKit,
  consentAll,
  fixture as member,
  openKit,
  type Kit,
} from '../../identity/me/http-kit.ts';
import { ATTR_CODE, TIMEOUT, withFixture } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 120_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

const LIST = '/v1/orders';
// member() sets the api Clock to 2031-05-06T08:08:09Z: inside order.user_query_months.
const PAID_AT = new Date('2031-04-02T02:00:00.000Z');
const SYNC_AT = '2031-04-03T02:00:00.000Z';

function page(response: Response): Schema<'OrderListData'> {
  expect(response.statusCode).toBe(200);
  const body = response.json<{ code: number; data: Schema<'OrderListData'> }>();
  expect(body).toMatchObject({ code: 0 });
  const schema =
    kit.document.paths[LIST]!['get']!.responses['200']!.content['application/json']!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body.data;
}

/** A member of the api entry who is the order's owner on the worker entry. */
async function memberOwner() {
  const m = await member(kit);
  await consentAll(kit, m);
  await m.db
    .updateTable('users')
    .set({ attr_code: ATTR_CODE })
    .where('app_id', '=', m.appId)
    .where('id', '=', m.uid)
    .execute();
  const session = await m.session();
  return {
    owner: { appId: m.appId, userId: m.uid },
    orders: async (scope: string) => page(await session.request(`${LIST}?scope=${scope}`)),
    wallet: async () => wallet(kit, await session.request(WALLET)),
  };
}

it(
  '[AC-B1-09n#19][BR-FUND-03][BR-FUND-18] 同步进来的已归因订单：用户订单接口金额非 null，钱包预估与之同数',
  async () => {
    const m = await memberOwner();
    await withFixture(
      singleBound(kit.suite.db),
      async (f) => {
        await f.setConfig('credit.enabled.jd', true);
        await f.sync();
        const row = await f.row();
        expect(row).toMatchObject({ rebate_status: 'ESTIMATED', commission_version: 1 });
        const listed = (await m.orders(row.buy_type ?? 'self')).items.find(
          (item) => item.order_id === row.order_id,
        );
        expect(listed?.est_rebate_fen).toBe(500);
        expect((await m.wallet())['estimated_fen']).toBe(500);
      },
      { owner: m.owner, now: SYNC_AT, patch: { paid_at: PAID_AT, modified_at: PAID_AT } },
    );
  },
  TIMEOUT,
);

it(
  '[AC-B1-09n#20][BR-FUND-03] 佣金变化后：钱包不抛错，订单接口与钱包都是 v2 的数',
  async () => {
    const m = await memberOwner();
    await withFixture(
      singleBound(kit.suite.db),
      async (f) => {
        await f.setConfig('credit.enabled.jd', true);
        await f.sync();
        expect(await f.row()).toMatchObject({ rebate_status: 'ESTIMATED', commission_version: 1 });
        await f.sync({
          est_commission_fen: 800n,
          commission_fen: 800n,
          modified_at: new Date('2031-04-02T03:00:00.000Z'),
        });
        const row = await f.row();
        expect(row).toMatchObject({ rebate_status: 'ESTIMATED', commission_version: 2 });
        expect((await m.wallet())['estimated_fen']).toBe(400);
        const listed = (await m.orders(row.buy_type ?? 'self')).items.find(
          (item) => item.order_id === row.order_id,
        );
        expect(listed?.est_rebate_fen).toBe(400);
      },
      { owner: m.owner, now: SYNC_AT, patch: { paid_at: PAID_AT, modified_at: PAID_AT } },
    );
  },
  TIMEOUT,
);
