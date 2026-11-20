// B2-02zc: the daily check's execution step across accounting days (BR-FUND-19 细则「账务自检异常」
// 第 1、4 条; D10-2224 B ①). While a ledger_mismatch ticket is unresolved (open or processing), the
// same difference found on a later day registers no new ticket (the run reports inserted = false
// for the existing one, unchanged field by field) and adds no new withdraw_holds row; once it is
// concluded (adjusted / written_off / closed) the difference opens a new ticket with one new hold.
// A global difference still switches settle.auto.enabled off on every run that finds it (现状，本单
// 不改). Only recon_diffs and withdraw_holds are pinned (编排 D10-2280).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  APP,
  DAY,
  NEXT_DAY,
  SWITCH_KEY,
  TIMEOUT,
  balanceCacheDiff,
  diffByRef,
  diffsOf,
  entry,
  executedOf,
  expectHold,
  expectRegistered,
  holdInput,
  holdsOf,
  negativeDropDiff,
  platformAccount,
  sourceOf,
  userAccount,
  voucher,
  voucherDiff,
  withHarness,
} from '../daily-check-execute/kit.ts';
import {
  CONCLUDED,
  CONCLUDED_AT,
  FOURTH_DAY,
  RUN_FOURTH,
  RUN_NEXT,
  RUN_THIRD,
  THIRD_DAY,
  conclude,
  moveTo,
} from './kit.ts';

it(
  '[AC-B2-02zc#1] 账户级差异（①）D 日登记 1 张并加 1 条冻结；D+1、D+2 同一差异再现 → 差错单仍 1 张（period=D 等逐字段不变）、inserted=false、冻结仍 1 条、端口只调 1 次；对照：同一账户 D+1 首次出现的 ⑦ 另登记 1 张、另加 1 条冻结',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const cache = balanceCacheDiff(account, { expected: 300n, cache: 500n });
      const day = await h.executor.execute(h.db, { accountingDate: DAY, differences: [cache] });
      const registered = await diffsOf(h);
      expect(registered).toHaveLength(1);
      const first = registered[0]!;
      expectRegistered(first, {
        refType: 'ledger_account',
        refId: `01:${account.accountId}`,
        expectedFen: 300n,
        actualFen: 500n,
      });
      expect(executedOf(day, first)).toMatchObject({
        inserted: true,
        heldUserIds: [account.userId],
      });
      const held = await holdsOf(h);
      expect(held).toHaveLength(1);
      expectHold(held[0], first, account.userId, h);
      expect(h.holds.calls).toHaveLength(1);

      // D+1: ① recurs (ticket still open); ⑦ of the same account is found for the first time.
      h.clock.set(RUN_NEXT);
      const negative = negativeDropDiff(account);
      const next = await h.executor.execute(h.db, {
        accountingDate: NEXT_DAY,
        differences: [cache, negative],
      });
      const afterNext = await diffsOf(h);
      expect(
        afterNext.filter((row) => row.ref_id === `01:${account.accountId}`),
        '① 未结：次日不新生成差错单，首张逐字段不变',
      ).toEqual([first]);
      expect(executedOf(next, first)).toMatchObject({
        refId: `01:${account.accountId}`,
        inserted: false,
        heldUserIds: [],
      });
      const fresh = await diffByRef(h, `07:${account.accountId}`, NEXT_DAY);
      expectRegistered(fresh, {
        period: NEXT_DAY,
        refType: 'ledger_account',
        refId: `07:${account.accountId}`,
        expectedFen: 0n,
        actualFen: 0n,
      });
      expect(executedOf(next, fresh)).toMatchObject({
        inserted: true,
        heldUserIds: [account.userId],
      });
      expect(afterNext.map((row) => row.id).sort()).toEqual([first.id, fresh.id].sort());
      const heldNext = await holdsOf(h);
      expect(
        heldNext.filter((hold) => hold.source_ref === sourceOf(first.id)),
        '① 未结：次日不新增冻结，原冻结原样',
      ).toEqual(held);
      expect(heldNext).toHaveLength(2);
      expectHold(
        heldNext.find((hold) => hold.source_ref === sourceOf(fresh.id)),
        fresh,
        account.userId,
        h,
      );
      expect(h.holds.calls.map((call) => call.input)).toEqual([
        holdInput(first, account.userId),
        holdInput(fresh, account.userId),
      ]);

      // D+2: both recur, both tickets unresolved → nothing new at all.
      h.clock.set(RUN_THIRD);
      const third = await h.executor.execute(h.db, {
        accountingDate: THIRD_DAY,
        differences: [cache, negative],
      });
      expect(await diffsOf(h)).toEqual(afterNext);
      expect(executedOf(third, first)).toMatchObject({ inserted: false, heldUserIds: [] });
      expect(executedOf(third, fresh)).toMatchObject({ inserted: false, heldUserIds: [] });
      expect(third.reconDiffs).toHaveLength(2);
      expect(await holdsOf(h)).toEqual(heldNext);
      expect(h.holds.calls).toHaveLength(2);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02zc#2] 未结含 processing：首张置 processing 后次日同一差异再现 → 不新生成差错单（首张逐字段不变）、inserted=false、不新增冻结',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const cache = balanceCacheDiff(account, { expected: 300n, cache: 500n });
      await h.executor.execute(h.db, { accountingDate: DAY, differences: [cache] });
      const first = await diffByRef(h, `01:${account.accountId}`);
      const processing = await moveTo(h.db, first, 'processing', RUN_NEXT);
      const held = await holdsOf(h);
      expect(held).toHaveLength(1);
      expectHold(held[0], first, account.userId, h);

      h.clock.set(RUN_NEXT);
      const next = await h.executor.execute(h.db, {
        accountingDate: NEXT_DAY,
        differences: [cache],
      });
      expect(await diffsOf(h), 'processing 也算未结：不新生成差错单').toEqual([processing]);
      expect(processing).toMatchObject({ status: 'processing', period: DAY, closed_at: null });
      expect(next.reconDiffs).toHaveLength(1);
      expect(executedOf(next, processing)).toMatchObject({ inserted: false, heldUserIds: [] });
      expect(await holdsOf(h)).toEqual(held);
      expect(h.holds.calls).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02zc#11] 未结期间同一差异再现但金额变了（① D 日分录 300 / 缓存 500 → D+1 400 / 600 → D+2 350 / 700）→ 仍读回 D 日原单：inserted=false、返回旧单 id，旧单金额、period、resolution 等逐字段不变；冻结仍 1 条、端口只调 1 次',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const refId = `01:${account.accountId}`;
      await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [balanceCacheDiff(account, { expected: 300n, cache: 500n })],
      });
      const first = await diffByRef(h, refId);
      expectRegistered(first, {
        refType: 'ledger_account',
        refId,
        expectedFen: 300n,
        actualFen: 500n,
      });
      const held = await holdsOf(h);
      expect(held).toHaveLength(1);
      expectHold(held[0], first, account.userId, h);
      expect(h.holds.calls).toHaveLength(1);

      const later = [
        [NEXT_DAY, RUN_NEXT, { expected: 400n, cache: 600n }],
        [THIRD_DAY, RUN_THIRD, { expected: 350n, cache: 700n }],
      ] as const;
      for (const [day, run, amounts] of later) {
        h.clock.set(run);
        const execution = await h.executor.execute(h.db, {
          accountingDate: day,
          differences: [balanceCacheDiff(account, amounts)],
        });
        expect(
          execution.reconDiffs.map((executed) => executed.reconDiffId),
          `${day}：金额变了仍读回 D 日原单`,
        ).toEqual([first.id]);
        expect(executedOf(execution, first)).toMatchObject({
          refId,
          inserted: false,
          heldUserIds: [],
        });
        expect(await diffsOf(h), `${day}：不新生成差错单，原单逐字段不变`).toEqual([first]);
        expect(first).toMatchObject({
          period: DAY,
          expected_fen: 300n,
          actual_fen: 500n,
          diff_fen: -200n,
          status: 'open',
        });
        expect(await holdsOf(h), `${day}：不新增冻结，原冻结原样`).toEqual(held);
        expect(h.holds.calls).toHaveLength(1);
      }
    });
  },
  TIMEOUT,
);

it.each(CONCLUDED)(
  '[AC-B2-02zc#3] 未结时次日不新开；首张结案为 %s（旧冻结随之按关单写法解除）后再次日同一差异 → 新开一张（period 为当日、新 id、inserted=true）并加 1 条指向新单的有效冻结，旧单与已解除的旧冻结不变；再追加一个会计日 → 读回重开的未结单（不是旧结案单）、inserted=false，两张单与冻结逐行不变',
  async (status) => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const cache = balanceCacheDiff(account, { expected: 300n, cache: 500n });
      await h.executor.execute(h.db, { accountingDate: DAY, differences: [cache] });
      const first = await diffByRef(h, `01:${account.accountId}`);
      const held = await holdsOf(h);
      expect(held).toHaveLength(1);

      // Still open on D+1: nothing new.
      h.clock.set(RUN_NEXT);
      const next = await h.executor.execute(h.db, {
        accountingDate: NEXT_DAY,
        differences: [cache],
      });
      expect(await diffsOf(h), '未结：次日不新生成差错单').toEqual([first]);
      expect(executedOf(next, first)).toMatchObject({ inserted: false, heldUserIds: [] });
      expect(await holdsOf(h)).toEqual(held);
      expect(h.holds.calls).toHaveLength(1);

      // Concluded (its hold released as the closing entry does), then found again on D+2: a new
      // ticket and one new hold in effect.
      const {
        diff: concluded,
        released,
        releasedBy,
      } = await conclude(h.db, first, status, CONCLUDED_AT);
      expect(released, '结案解除旧冻结').toEqual([
        { ...held[0]!, released_at: new Date(CONCLUDED_AT), released_by: releasedBy },
      ]);
      expect(await holdsOf(h)).toEqual(released);
      h.clock.set(RUN_THIRD);
      const third = await h.executor.execute(h.db, {
        accountingDate: THIRD_DAY,
        differences: [cache],
      });
      const later = await diffByRef(h, `01:${account.accountId}`, THIRD_DAY);
      expectRegistered(later, {
        period: THIRD_DAY,
        refType: 'ledger_account',
        refId: `01:${account.accountId}`,
        expectedFen: 300n,
        actualFen: 500n,
      });
      expect(later.id).not.toBe(first.id);
      expect(executedOf(third, later)).toMatchObject({
        inserted: true,
        heldUserIds: [account.userId],
      });
      expect(await diffsOf(h), '旧单不变，另有新单').toEqual([concluded, later]);
      const heldThird = await holdsOf(h);
      expect(heldThird).toHaveLength(2);
      expect(
        heldThird.filter((hold) => hold.source_ref === sourceOf(first.id)),
        '旧冻结保留解除时间与操作人',
      ).toEqual(released);
      expectHold(
        heldThird.find((hold) => hold.source_ref === sourceOf(later.id)),
        later,
        account.userId,
        h,
      );
      expect(h.holds.calls.map((call) => call.input)).toEqual([
        holdInput(first, account.userId),
        holdInput(later, account.userId),
      ]);

      // D+3: the reopened ticket is unresolved → read back (not the concluded one), nothing new.
      h.clock.set(RUN_FOURTH);
      const fourth = await h.executor.execute(h.db, {
        accountingDate: FOURTH_DAY,
        differences: [cache],
      });
      expect(
        fourth.reconDiffs.map((executed) => executed.reconDiffId),
        '读回重开的未结单，不是旧结案单',
      ).toEqual([later.id]);
      expect(executedOf(fourth, later)).toMatchObject({
        refId: `01:${account.accountId}`,
        inserted: false,
        heldUserIds: [],
      });
      expect(await diffsOf(h), '两张单逐行不变').toEqual([concluded, later]);
      expect(await holdsOf(h), '冻结逐行不变').toEqual(heldThird);
      expect(h.holds.calls).toHaveLength(2);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02zc#4] 全局差异（② 凭证不平）：D 日登记并冻结、关 settle.auto.enabled；D+1 再现 → 不新生成差错单、inserted=false、不新增冻结，但 settle.auto.enabled 照样再关一次（每轮发现即关）',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const cash = await platformAccount(h, 'CASH');
      const v = await voucher(h);
      await entry(h, v.id, account.accountId, -100n, true);
      await entry(h, v.id, cash, 107n, false);
      const unbalanced = voucherDiff(v, 7n, 2);

      const day = await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [unbalanced],
      });
      expect(day.autoSettlementOff).toEqual([APP]);
      expect(h.settle.turnOffs).toHaveLength(1);
      const first = await diffByRef(h, `02:${v.id}`);
      expectRegistered(first, {
        refType: 'voucher',
        refId: `02:${v.id}`,
        expectedFen: 0n,
        actualFen: 7n,
      });
      expect(executedOf(day, first)).toMatchObject({
        inserted: true,
        heldUserIds: [account.userId],
      });
      const held = await holdsOf(h);
      expect(held).toHaveLength(1);
      expectHold(held[0], first, account.userId, h);

      h.clock.set(RUN_NEXT);
      const next = await h.executor.execute(h.db, {
        accountingDate: NEXT_DAY,
        differences: [unbalanced],
      });
      expect(await diffsOf(h), '全局差异未结：次日不新生成差错单').toEqual([first]);
      expect(next.reconDiffs).toHaveLength(1);
      expect(executedOf(next, first)).toMatchObject({ inserted: false, heldUserIds: [] });
      expect(await holdsOf(h)).toEqual(held);
      expect(h.holds.calls).toHaveLength(1);
      // 正文「全局差异：告警，系统自动将 settle.auto.enabled 置 off」照旧：每轮发现即关。
      expect(next.autoSettlementOff).toEqual([APP]);
      expect(h.settle.turnOffs).toHaveLength(2);
      expect(h.settle.turnOffs[1]!.input).toMatchObject({ appId: APP, key: SWITCH_KEY });
      expect(h.settle.turnOffs[1]!.input.reason).toContain(NEXT_DAY);
    });
  },
  TIMEOUT,
);
