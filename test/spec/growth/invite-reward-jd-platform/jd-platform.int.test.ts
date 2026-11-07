// B1-08zj rule tests (08 BR-INV-24 ⑥ 与细则 判定顺序 3；编排 D10-814 ⑥ / D10-854 ② / D10-868 ①；
// FU-INVITE-REWARD-ORDER-PLATFORM). B1-08zi made growth's 「触发订单入账后退款」 judgement platform
// aware: refunded_quantity > refunded_quantity_at_credit voids an unpaid reward, except that a jd
// order only counts while orders.jd.refunded_quantity_r9_enabled is on (default off: not voided);
// every other platform voids as before. The judgement reads the order's platform from orders'
// invite reward fact port, which must therefore return o.platform; a port that leaves it out makes
// growth treat a jd order as non-jd and void it with the switch off.
//   1. jd, switch off (unset or false), refunded after crediting → not voided; the round pays as
//      usual (processed, both REWARD vouchers, the locked amount).
//   2. jd, payout paused: switch off → deferred, trigger and reservation kept; the switch turned on
//      → the next round voids it (order_clawed_back), the same as a taobao order.
//   3. switch off, one round: taobao and pdd orders refunded after crediting are voided as before,
//      the jd one beside them is not.
//   4. the production fact readers (orders' export, and app.module's bookedBaseOrderFacts over it)
//      return platform equal to orders.platform, on read and on the window list.
// Cases 2 and 3 assert the jd side in the same test, so each test is red on the current port.
// Task-local AC labels ([AC-B1-08zj#n]) identify this task's acceptance points, not business rules.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  LOCKED_AMOUNT,
  NEXT_ROUND,
  PAID,
  QUALIFIED,
  TIMEOUT,
  budget,
  reward,
  rewardKey,
  round,
  user,
  vouchers,
  worker,
  type Worker,
} from '../invite-reward-wiring/kit.ts';
import {
  JD_SWITCH,
  PAUSED,
  WINDOW_END,
  configuredApp,
  creditedOrder,
  duePair,
  productionFactReaders,
  setConfig,
  type DuePair,
  type OrderPlatform,
} from './kit.ts';

let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let db: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 10 });
}, 180_000);

afterAll(async () => {
  try {
    if (db !== undefined) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 60_000);

async function withWorker(run: (w: Worker) => Promise<void>): Promise<void> {
  const w = await worker(db);
  try {
    await run(w);
  } finally {
    await w.close();
  }
}

/** The switch states that mean off: no config_items row (the default), or JSON false. */
const SWITCH_OFF: [string, false | undefined][] = [
  ['未配置', undefined],
  ['false', false],
];

/** The total budget with one pair's two parties still reserved and nothing granted. */
const RESERVED_ONE_PAIR = { reserved_fen: LOCKED_AMOUNT * 2n, granted_fen: 0n };

async function switchOff(appId: string, value: false | undefined): Promise<void> {
  if (value !== undefined) await setConfig(db, appId, JD_SWITCH, value);
}

/** Voided at step 3 for the refund after crediting: nothing paid, the trigger order recorded. */
async function expectVoided(pair: DuePair): Promise<void> {
  expect(await reward(db, pair), `${pair.platform} reward`).toMatchObject({
    status: 'voided',
    void_reason: 'order_clawed_back',
    trigger_order_id: pair.orderId,
    inviter_result: null,
    invitee_result: null,
    inviter_voucher_id: null,
    invitee_voucher_id: null,
  });
}

/** Still the unpaid qualification it was (deferred by the pause), not voided. */
async function expectDeferredNotVoided(pair: DuePair): Promise<void> {
  expect(await reward(db, pair), `${pair.platform} reward`).toMatchObject({
    status: 'deferred',
    void_reason: null,
    trigger_order_id: pair.orderId,
    triggered_at: new Date(PAID),
    inviter_result: null,
    invitee_result: null,
    inviter_voucher_id: null,
    invitee_voucher_id: null,
  });
}

/** No invite_reward_voided log line names this invitee. */
function expectNoVoidLog(w: Worker, pair: DuePair): void {
  const voided = w
    .logs(pair.appId)
    .filter((line) => line.msg === 'invite_reward_voided')
    .filter((line) => line['invitee_id'] === pair.invitee);
  expect(voided).toEqual([]);
}

it.each(SWITCH_OFF)(
  '[AC-B1-08zj#1] 京东触发订单入账后已退件数增加（1 > 0）、开关 orders.jd.refunded_quantity_r9_enabled %s：不作废，照常发放（processed、双方 REWARD 凭证、锁定金额转已发放）',
  async (_label, value) => {
    await withWorker(async (w) => {
      const appId = await configuredApp(db);
      await switchOff(appId, value);
      const jd = await duePair(db, appId, 'jd');

      await round(w);

      expect(await reward(db, jd)).toMatchObject({
        status: 'processed',
        void_reason: null,
        trigger_order_id: jd.orderId,
        triggered_at: new Date(PAID),
        inviter_result: 'granted',
        invitee_result: 'granted',
      });
      expect((await vouchers(db, appId)).map((v) => v.uniq_key).sort()).toEqual(
        [rewardKey(jd.invitee, 'inviter'), rewardKey(jd.invitee, 'invitee')].sort(),
      );
      expect(await budget(db, appId)).toEqual({
        reserved_fen: 0n,
        granted_fen: LOCKED_AMOUNT * 2n,
      });
      expectNoVoidLog(w, jd);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zj#2] 暂停发放时：京东开关关 → 顺延不作废（trigger 与占用不变）；开关打开后下一轮 → 作废 order_clawed_back、释放占用，与淘宝一致',
  async () => {
    await withWorker(async (w) => {
      const appId = await configuredApp(db);
      await setConfig(db, appId, PAUSED, true);
      const jd = await duePair(db, appId, 'jd');

      await round(w, PAID);

      await expectDeferredNotVoided(jd);
      expect(await budget(db, appId)).toEqual(RESERVED_ONE_PAIR);
      expectNoVoidLog(w, jd);

      await setConfig(db, appId, JD_SWITCH, true);
      const taobao = await duePair(db, appId, 'taobao');

      await round(w, NEXT_ROUND);

      await expectVoided(jd);
      await expectVoided(taobao);
      expect(await budget(db, appId)).toEqual({ reserved_fen: 0n, granted_fen: 0n });
      expect(await vouchers(db, appId)).toEqual([]);
    });
  },
  TIMEOUT,
);

it.each(SWITCH_OFF)(
  '[AC-B1-08zj#3] 开关 %s、同一轮：淘宝、拼多多触发订单入账后已退件数增加照旧作废；同 app 的京东订单不作废',
  async (_label, value) => {
    await withWorker(async (w) => {
      const appId = await configuredApp(db);
      await switchOff(appId, value);
      await setConfig(db, appId, PAUSED, true);
      const taobao = await duePair(db, appId, 'taobao');
      const pdd = await duePair(db, appId, 'pdd');
      const jd = await duePair(db, appId, 'jd');

      await round(w);

      await expectVoided(taobao);
      await expectVoided(pdd);
      await expectDeferredNotVoided(jd);
      // Only the jd pair's reservation is left.
      expect(await budget(db, appId)).toEqual(RESERVED_ONE_PAIR);
      expect(await vouchers(db, appId)).toEqual([]);
      expectNoVoidLog(w, jd);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zj#4] 生产装配的订单事实读口（orders 导出与 app.module 的 bookedBaseOrderFacts）返回 platform，等于订单的平台',
  async () => {
    const appId = await configuredApp(db);
    const buyer = await user(db, appId);
    const platforms = new Map<string, OrderPlatform>();
    for (const platform of ['jd', 'taobao', 'pdd'] as const) {
      platforms.set(await creditedOrder(db, appId, buyer, platform), platform);
    }
    const readers = await productionFactReaders();

    await db.transaction().execute(async (trx) => {
      for (const [name, reader] of Object.entries(readers)) {
        for (const [orderId, platform] of platforms) {
          expect(
            await reader.read(trx, { app_id: appId, order_id: orderId }),
            `${name} read ${platform}`,
          ).toMatchObject({ app_id: appId, order_id: orderId, platform });
        }
        const listed = await reader.listSelfOrdersInWindow(trx, {
          app_id: appId,
          user_id: buyer,
          from: new Date(QUALIFIED),
          to: new Date(WINDOW_END),
        });
        expect(
          listed.map((fact) => `${fact.order_id}:${String(fact['platform'])}`).sort(),
          `${name} window list`,
        ).toEqual([...platforms].map(([orderId, platform]) => `${orderId}:${platform}`).sort());
      }
    });
  },
  TIMEOUT,
);
