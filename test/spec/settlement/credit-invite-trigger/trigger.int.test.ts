// B2-04zzc (编排 D10-805 ②, D10-810; 08 BR-INV-24 ②, 细则「有效期」): the settle worker's R5 credit
// records the first eligible self-purchase of a qualified invitee as the trigger of its invite
// reward, on the credit's own transaction, through the trigger port app.module hands in.
// Orders as in the B2-04p kit: N 1000, no reserve → booked_base_fen 1000 (self 400, direct 80); the
// invitee is the self beneficiary, the inviter the direct one; placed 2032-06-20 10:00 +08:00,
// paid 4990; the qualification window is [2032-06-15, 2032-08-14). Credit clock 2032-07-24 10:00.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { EventBus } from '../../../../apps/api/src/modules/platform/index.ts';
import { NOW, databaseFixture, fixture } from '../batch-executor/kit.ts';
import { setConfig } from '../worker/kit.ts';
import {
  LAPSED_DAYS,
  LAPSED_QUALIFIED_AT,
  MIN_PAID_KEY,
  TIMEOUT,
  UNTRIGGERED,
  budgetsOf,
  captureLogger,
  creditInBatch,
  creditedRows,
  errorLines,
  execute,
  failingRewardStatement,
  inviteeOrder,
  pair,
  productionTrigger,
  qualify,
  recorded,
  rewardOf,
  triggerOf,
  withWorker,
  type TriggerFactory,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const CREDITED_AT = new Date(NOW).toISOString();

function triggeredBy(orderId: string, at: string = CREDITED_AT) {
  return { status: 'qualified', trigger_order_id: orderId, triggered_at: at };
}

it(
  '[AC-B2-04zzc#1] 真实 worker 装配（端口取自 AppModule worker 入口，测试不自造触发器）：被邀请人有 qualified 资格，其自购单经批次 R5 入账提交后，资格的 trigger_order_id 等于该单、triggered_at 等于入账时的 Clock，状态仍 qualified',
  async () => {
    const f = await fixture(p.db);
    const pr = await pair(f);
    await qualify(f, pr);
    const o = await inviteeOrder(f, pr);

    const batch = await creditInBatch(f, [o], { trigger: await productionTrigger() });

    expect(await f.itemOf(batch, o)).toMatchObject({ result: 'credited' });
    expect(await f.rebateOf(o)).toBe('CREDITED');
    expect(await triggerOf(f, pr.invitee)).toStrictEqual(triggeredBy(o.orderId));
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzc#3] 触发与 R5 的 CAS 同一事务：order.credited 发布时注入失败 → 入账（CREDITED、R5 历史行）与触发记录一起回滚、投递失败；恢复后重跑同一批次，只入账一次、只触发一次（trigger_order_id 为该单，row_version 只加 1）',
  async () => {
    const f = await fixture(p.db);
    const pr = await pair(f);
    await qualify(f, pr);
    const o = await inviteeOrder(f, pr);
    const batch = await f.batch([o]);
    let refusals = 1;
    const publish: EventBus['publish'] = async (trx, event) => {
      if (event.name === 'order.credited' && refusals > 0) {
        refusals -= 1;
        throw new Error('order.credited refused by the test');
      }
      return f.h.publish(trx, event);
    };

    await withWorker(f, { trigger: await productionTrigger(), publish }, async (handler) => {
      await expect(execute(handler, f, batch)).rejects.toThrow();
      expect(refusals).toBe(0);
      expect(await f.rebateOf(o)).toBe('WAITING');
      expect(await creditedRows(f, o)).toBe(0);
      expect(await triggerOf(f, pr.invitee)).toStrictEqual(UNTRIGGERED);
      expect((await rewardOf(f, pr.invitee)).row_version).toBe(0);

      await execute(handler, f, batch);
    });

    expect((await f.stored(batch)).status).toBe('DONE');
    expect(await f.rebateOf(o)).toBe('CREDITED');
    expect(await creditedRows(f, o)).toBe(1);
    expect(await triggerOf(f, pr.invitee)).toStrictEqual(triggeredBy(o.orderId));
    expect((await rewardOf(f, pr.invitee)).row_version).toBe(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzc#4] 触发端口的 SQL 出错（写 invite_rewards 的语句在 PostgreSQL 里真实报错）：入账照常提交为 CREDITED，资格不变（qualified、无触发、row_version 0），worker 日志记一条 error，error 行不含邀请人 / 被邀请人 id 与昵称',
  async () => {
    const f = await fixture(p.db);
    const pr = await pair(f);
    await qualify(f, pr);
    const o = await inviteeOrder(f, pr);
    const faulty = failingRewardStatement(f.db);
    const logs = captureLogger();

    await creditInBatch(f, [o], {
      trigger: await productionTrigger(),
      db: faulty.db,
      logger: logs.logger,
    });

    expect(faulty.injected(), 'the trigger port never wrote invite_rewards').toBe(1);
    expect(await f.rebateOf(o)).toBe('CREDITED');
    expect(await creditedRows(f, o)).toBe(1);
    expect(await triggerOf(f, pr.invitee)).toStrictEqual(UNTRIGGERED);
    expect((await rewardOf(f, pr.invitee)).row_version).toBe(0);
    const errors = errorLines(logs);
    expect(errors).toHaveLength(1);
    const text = JSON.stringify(errors);
    for (const personal of [pr.invitee, pr.inviter, 'synthetic']) {
      expect(text).not.toContain(personal);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzc#5] 钩子在 R5 的 CAS 之后、发布 order.credited 之前：端口被调用时同一事务里读到的订单已是 CREDITED（booked_base_fen 已写 1000）；发布 order.credited 时同一事务里已能看到触发记录',
  async () => {
    const f = await fixture(p.db);
    const pr = await pair(f);
    await qualify(f, pr);
    const o = await inviteeOrder(f, pr);
    const production = await productionTrigger();
    const atTrigger: unknown[] = [];
    const observed: TriggerFactory | undefined =
      production === undefined
        ? undefined
        : (runtime) => {
            const inner = production(runtime);
            return {
              async onCredited(trx, input) {
                const row = await trx
                  .withSchema('app')
                  .selectFrom('orders')
                  .select(['order_id', 'rebate_status', 'booked_base_fen'])
                  .where('app_id', '=', input.app_id)
                  .where('order_id', '=', input.order_id)
                  .executeTakeFirstOrThrow();
                atTrigger.push(row);
                await inner.onCredited(trx, input);
              },
            };
          };
    const atPublish: unknown[] = [];
    const publish: EventBus['publish'] = async (trx, event) => {
      if (event.name === 'order.credited') {
        const reward = await trx
          .withSchema('app')
          .selectFrom('invite_rewards')
          .select(['trigger_order_id'])
          .where('app_id', '=', f.appId)
          .where('invitee_id', '=', pr.invitee)
          .executeTakeFirstOrThrow();
        atPublish.push(reward);
      }
      return f.h.publish(trx, event);
    };

    await creditInBatch(f, [o], { trigger: observed, publish });

    expect(atTrigger).toStrictEqual([
      { order_id: o.orderId, rebate_status: 'CREDITED', booked_base_fen: 1000n },
    ]);
    expect(atPublish).toStrictEqual([{ trigger_order_id: o.orderId }]);
    expect(await triggerOf(f, pr.invitee)).toStrictEqual(triggeredBy(o.orderId));
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzc#6] 不合格的单入账照常、不触发、资格仍 qualified：分享单（buy_type=share）、B=0（预留 10000，入账基数 0）、实付 4999 低于 min_paid_fen 5000、下单时间不在有效期内（资格 30 天已于 05-01 到期）；同批次里实付恰为 5000 的合格自购单照常触发',
  async () => {
    const f = await fixture(p.db);
    await setConfig(f.db, f.appId, MIN_PAID_KEY, 5000);
    const atMin = { pay_amount_fen: 5000n };
    const share = await pair(f);
    const zero = await pair(f);
    const cheap = await pair(f);
    const lapsed = await pair(f);
    const eligible = await pair(f);
    for (const pr of [share, zero, cheap, eligible]) await qualify(f, pr);
    await qualify(f, lapsed, {
      qualified_at: new Date(LAPSED_QUALIFIED_AT),
      eligibility_days: LAPSED_DAYS,
    });
    const zeroOrder = await inviteeOrder(f, zero, { reserveBp: 10000, patch: atMin });
    const orders = [
      await inviteeOrder(f, share, { share: true, patch: atMin }),
      zeroOrder,
      await inviteeOrder(f, cheap, { patch: { pay_amount_fen: 4999n } }),
      await inviteeOrder(f, lapsed, { patch: atMin }),
    ];
    const control = await inviteeOrder(f, eligible, { patch: atMin });

    await creditInBatch(f, [...orders, control], { trigger: await productionTrigger() });

    for (const o of [...orders, control]) expect(await f.rebateOf(o)).toBe('CREDITED');
    expect((await f.h.read(zeroOrder)).booked_base_fen).toBe(0n);
    for (const pr of [share, zero, cheap, lapsed]) {
      expect(await triggerOf(f, pr.invitee), pr.invitee).toStrictEqual(UNTRIGGERED);
    }
    expect(await triggerOf(f, eligible.invitee)).toStrictEqual(triggeredBy(control.orderId));
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzc#8] 已有触发后再入账的订单不改 trigger_order_id / triggered_at：第一单 07-24 入账触发；时钟到 07-25 第二单入账后，触发仍是第一单与 07-24 的时刻，row_version 仍为 1',
  async () => {
    const f = await fixture(p.db);
    const pr = await pair(f);
    await qualify(f, pr);
    const first = await inviteeOrder(f, pr);
    const second = await inviteeOrder(f, pr);
    const trigger = await productionTrigger();

    await creditInBatch(f, [first], { trigger });
    expect(await triggerOf(f, pr.invitee)).toStrictEqual(triggeredBy(first.orderId));

    f.clock.set('2032-07-25T10:00:00+08:00');
    await creditInBatch(f, [second], { trigger });

    expect(await f.rebateOf(second)).toBe('CREDITED');
    expect(await triggerOf(f, pr.invitee)).toStrictEqual(triggeredBy(first.orderId));
    expect((await rewardOf(f, pr.invitee)).row_version).toBe(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzc#12] 多 App：B App 的订单入账只触发 B App 的资格；A App 的资格与预算不动；端口只收到一次调用（在入账事务内，app_id = B、order_id = 该单）',
  async () => {
    const a = await fixture(p.db);
    const b = await fixture(p.db);
    const pa = await pair(a);
    const pb = await pair(b);
    await qualify(a, pa);
    await qualify(b, pb);
    // App A has a credited-ready order of its own invitee that is not in B's batch.
    await inviteeOrder(a, pa);
    const ob = await inviteeOrder(b, pb);
    const aBudgets = await budgetsOf(a);
    const rec = recorded(await productionTrigger());

    await creditInBatch(b, [ob], { trigger: rec.factory });

    expect(await triggerOf(b, pb.invitee)).toStrictEqual(triggeredBy(ob.orderId));
    expect(rec.calls).toStrictEqual([{ inTransaction: true, appId: b.appId, orderId: ob.orderId }]);
    expect(await triggerOf(a, pa.invitee)).toStrictEqual(UNTRIGGERED);
    expect((await rewardOf(a, pa.invitee)).row_version).toBe(0);
    expect(await budgetsOf(a)).toStrictEqual(aBudgets);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzc#13] R13（CLAWED_BACK → CREDITED 后台恢复）不经触发端口：恢复后已是 CREDITED 的自购单在批次里按 not_waiting 跳过，端口不收到它，资格不变；同批次后一笔 WAITING 自购单 R5 入账才触发',
  async () => {
    const f = await fixture(p.db);
    const pr = await pair(f);
    await qualify(f, pr);
    const restored = await inviteeOrder(f, pr);
    const later = await inviteeOrder(f, pr);
    // The order as BR-FUND-22 R13 leaves it: credited earlier, clawed back, then restored by an
    // admin (the restore has no worker path; its booked pair is the restored base).
    await f.db
      .withSchema('app')
      .updateTable('orders')
      .set({ rebate_status: 'CREDITED', booked_base_fen: 1000n, booked_n_fen: 1000n })
      .where('app_id', '=', f.appId)
      .where('order_id', '=', restored.orderId)
      .execute();
    const rec = recorded(await productionTrigger());

    const batch = await creditInBatch(f, [restored, later], { trigger: rec.factory });

    expect(await f.itemOf(batch, restored)).toMatchObject({
      result: 'skipped',
      skip_reason: 'not_waiting',
    });
    expect(await creditedRows(f, restored)).toBe(0);
    expect(rec.calls.map((call) => call.orderId)).toStrictEqual([later.orderId]);
    expect(await triggerOf(f, pr.invitee)).toStrictEqual(triggeredBy(later.orderId));
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzc#14] 「B > 0」取入账基数 booked_base_fen：预估 orders.base_fen = 320 > 0 但入账 booked_base_fen = 0（预留 10000）的单入账时不触发、资格不作废（仍 qualified）；之后一笔合格单入账时触发',
  async () => {
    const f = await fixture(p.db);
    const pr = await pair(f);
    await qualify(f, pr);
    const zero = await inviteeOrder(f, pr, { reserveBp: 10000, patch: { base_fen: 320n } });
    const later = await inviteeOrder(f, pr);
    const trigger = await productionTrigger();

    await creditInBatch(f, [zero], { trigger });
    const credited = await f.h.read(zero);
    expect(credited.rebate_status).toBe('CREDITED');
    expect(credited.base_fen).toBe(320n);
    expect(credited.booked_base_fen).toBe(0n);
    expect(await triggerOf(f, pr.invitee)).toStrictEqual(UNTRIGGERED);

    await creditInBatch(f, [later], { trigger });
    expect(await triggerOf(f, pr.invitee)).toStrictEqual(triggeredBy(later.orderId));
  },
  TIMEOUT,
);
