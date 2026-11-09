// B2-09gg rule tests, what stops a restore (claude-independent, SPEC_REF 03383a10): 08 BR-FUND-22 细则
// 「处理时再核」(编排 D10-982, D10-986, D10-1134), the out-of-date difference and tenancy
// (contracts/openapi.yaml restoreAdminReconDiff). Every difference comes from the real producer, every
// clawback from the real blacklist confirmation. A refused restore writes nothing and leaves the
// difference open. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  diffNow,
  netOf,
  netsOf,
  orderConflict,
  orderRow,
  platformRestored,
  refusedWith,
  unknownDiff,
} from '../platform-restore/kit.ts';
import {
  SUFFIX,
  TIMEOUT,
  app,
  appealDiffs,
  blacklistClawback,
  clawedBackEntry,
  clawedOrder,
  dedupeKeyOf,
  everything,
  platformDiffOf,
  refId,
  registeredDiff,
  setOrderFigures,
  succeededInvalid,
  suite,
  withConsole,
  withConsoleAndWorker,
} from './kit.ts';

const s = suite();

/** One hour, for a rights record that became successful before the difference was registered. */
const HOUR_MS = 3_600_000;

it(
  '[AC-B2-09gg#9] 处理时再核（D10-1134）：差错单登记后（含同一时刻）有成功的 INVALID_AFTER_SETTLE 记录 → 20001 restore_platform_invalid，什么都不写，差错单仍 open；登记之前就成功的记录不算，该单照常恢复',
  async () => {
    const a = await app(s);
    await withConsoleAndWorker(a, async (admin, worker) => {
      const invalidated = await clawedOrder(a, admin);
      const earlier = await clawedOrder(a, admin);
      const diff = await registeredDiff(a, worker, invalidated.order, invalidated.entryId);
      const control = await registeredDiff(a, worker, earlier.order, earlier.entryId);

      await succeededInvalid(a, invalidated.order, a.h.clock.now());
      await succeededInvalid(a, earlier.order, new Date(control.created_at.getTime() - HOUR_MS));

      const before = await everything(a);
      await refusedWith(await admin.restore(diff.id), 'restore_platform_invalid');
      expect(await everything(a)).toEqual(before);
      const now = await diffNow(a.f, diff.id);
      expect(now).toEqual(diff);
      expect(now.status).toBe('open');

      const data = await platformRestored(await admin.restore(control.id));
      expect(data.rebate_status_after).toBe('CREDITED');
      expect(data.restored_fen).toBe(552);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gg#10] 处理时再核：登记之后有效佣金的正数部分变为 0（结算佣金 0；结算佣金 −50）→ 20001 restore_commission_zero，什么都不写，差错单仍 open',
  async () => {
    const a = await app(s);
    await withConsoleAndWorker(a, async (admin, worker) => {
      const zero = await clawedOrder(a, admin);
      const negative = await clawedOrder(a, admin);
      const zeroDiff = await registeredDiff(a, worker, zero.order, zero.entryId);
      const negativeDiff = await registeredDiff(a, worker, negative.order, negative.entryId);
      await setOrderFigures(a, zero.order, { settleFen: 0n });
      await setOrderFigures(a, negative.order, { settleFen: -50n });

      const before = await everything(a);
      for (const diff of [zeroDiff, negativeDiff]) {
        await refusedWith(await admin.restore(diff.id), 'restore_commission_zero');
        const now = await diffNow(a.f, diff.id);
        expect(now).toEqual(diff);
        expect(now.status).toBe('open');
      }
      expect(await everything(a)).toEqual(before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gg#11] 过期差错单：订单经 R13 恢复后再次被黑名单确认扣回（新的历史行），旧差错单处理 → 20902 data.resource=order，什么都不写、仍 open；新一轮撤销登记新差错单（entry_id 不同），处理后恢复',
  async () => {
    const a = await app(s);
    await withConsoleAndWorker(a, async (admin, worker) => {
      const first = await clawedOrder(a, admin);
      const { order } = first;
      const old = await registeredDiff(a, worker, order, first.entryId);

      // Back to CREDITED by the real R13 on a platform difference of the same entry, so that the
      // appeal's own difference is still open when the order is clawed back a second time.
      const platformDiff = await platformDiffOf(a, first);
      const reopened = await platformRestored(await admin.restore(platformDiff.id));
      expect(reopened.rebate_status_after).toBe('CREDITED');

      // A second blacklist difference of the order needs its own ref_id (another dimension).
      const second = await blacklistClawback(a, admin, order, [SUFFIX]);
      expect(second.entryId).not.toBe(first.entryId);
      expect(await clawedBackEntry(a, order.orderId)).toBe(second.entryId);

      const before = await everything(a);
      await orderConflict(await admin.restore(old.id));
      expect(await everything(a)).toEqual(before);
      const stale = await diffNow(a.f, old.id);
      expect(stale).toEqual(old);
      expect(stale.status).toBe('open');

      const fresh = await registeredDiff(a, worker, order, second.entryId);
      expect(fresh.id).not.toBe(old.id);
      expect(fresh).toMatchObject({
        ref_id: refId(order, second.entryId),
        dedupe_key: dedupeKeyOf(a, order, second.entryId),
        status: 'open',
      });
      expect((await appealDiffs(a.f)).map((r) => r.id).sort()).toEqual([old.id, fresh.id].sort());

      const restored = await platformRestored(await admin.restore(fresh.id));
      expect(restored.rebate_status_after).toBe('CREDITED');
      expect(restored.restored_fen).toBe(552);
      const nets = await netsOf(a.f, order.orderKey);
      expect(netOf(nets, order.user('self'), 'self')).toBe(425n);
      expect(netOf(nets, order.user('direct'), 'direct')).toBe(85n);
      expect(netOf(nets, order.user('indirect'), 'indirect')).toBe(42n);
      expect(nets.platform_net_fen).toBe(448n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gg#12] 多租户：别的 app 的处理人拿本 app 的差错单 id → 20001 data.fields=[recon_diff_id]，差错单不变；本 app 处理后恢复，只动本 app——别的 app 用不同 sub_order_id 的 CLAWED_BACK 订单、差错单、账务、审计一律不变',
  async () => {
    const a = await app(s);
    const b = await app(s);
    await withConsole(b, async (other) => {
      await withConsoleAndWorker(a, async (admin, worker) => {
        const mine = await clawedOrder(a, admin);
        const foreign = await clawedOrder(b, other);
        expect(foreign.order.orderKey).not.toBe(mine.order.orderKey);
        expect(foreign.order.subOrderId).not.toBe(mine.order.subOrderId);

        const diff = await registeredDiff(a, worker, mine.order, mine.entryId);
        const foreignBefore = await everything(b);

        await unknownDiff(await other.restore(diff.id));
        expect(await diffNow(a.f, diff.id)).toEqual(diff);

        const data = await platformRestored(await admin.restore(diff.id));
        expect(data.rebate_status_after).toBe('CREDITED');
        expect((await orderRow(a.f, mine.order.orderId)).rebate_status).toBe('CREDITED');

        expect(await everything(b)).toEqual(foreignBefore);
        expect((await orderRow(b.f, foreign.order.orderId)).rebate_status).toBe('CLAWED_BACK');
      });
    });
  },
  TIMEOUT,
);
