// B2-09gd rule tests, the snapshot made up inside R12 (claude-independent, SPEC_REF d5713bf4): 08
// BR-CALC-10 (R12 时点), BR-FUND-22 R12 守卫「需补分佣快照的能生成」、处理时再核, task brief 9.2 C, 9.5.
// Attributed, platform_status PAID / RECEIVED / SETTLED and no commission_splits: the snapshot is
// generated on the restore's transaction, the rule version by paid_at, and the order can be settled
// afterwards. 「生成不了」 is exactly: no published rule version, paid_at unrecoverable
// (planSnapshotRetry paid_at_unknown), taobao's pid scene unavailable — not restored, nothing
// written, 20001 restore_snapshot_unavailable. A commission not reported yet or a version without
// the platform's rule or reserve restores and leaves a snapshot-class pending row. Requests go
// through the real admin entry; the settlement and the compensation scan through the handlers the
// real worker registered. Expected amounts by hand: BR-CALC-02 B = floor(N × (10000 − reserve_bp) /
// 10000), BR-CALC-04 floor(B × ratio / 10000); the platform gets N less the shares. Top-level it()
// only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { version, seedVersion } from '../../commission/snapshot/fixtures.ts';
import { account, pid } from '../../orders/wiring/db-kit.ts';
import {
  answer,
  available,
  fixture,
  idempotencyRows,
  netOf,
  netsOf,
  newKey,
  suite,
  withRestoreAdmin,
  type RestoreFixture,
} from '../admin-recon-restore/kit.ts';
import {
  expectAdjusted,
  expectRestoreStep,
  orderRow,
  orderVouchers,
  platformRestored,
  seedPlatformDiff,
  type PlatformStatus,
} from '../platform-restore/kit.ts';
import {
  HOUR_MS,
  PAID_AT,
  RECEIVED_AT,
  TIMEOUT,
  bareFixture,
  expectStillVoid,
  expectWarned,
  pendingOf,
  scanSnapshots,
  seedAppealDiff,
  seedRules,
  seedVoid,
  settleOrder,
  splitsOf,
  stateOf,
  unavailable,
  withEntryLog,
  withWorker,
  type Platform,
  type VoidSpec,
} from './kit.ts';

const s = suite();

/** After the first version of `fixture` (2026-08-20) and before the second one below. */
const SECOND_VERSION_AT = new Date('2026-09-15T00:00:00.000Z');
const LATE_PAID_AT = new Date('2026-09-20T00:00:00.000Z');

it(
  '[AC-B2-09gd#5] 主线：首次入库就被黑名单作废的已结算单（从未有快照，commission_version 0）申诉恢复后在 R12 事务内补快照（commission_version 1），之后走 worker 真实 settle 入口能入账：N 1000、预留 1500 → B 850，self 5000 → 425 入账、平台 575；比例按 paid_at 选规则版本（早单第一版、晚单与按观测时刻取 paid_at 的单第二版：预留 1000、N 800 → B 720，比例 3000）',
  async () => {
    const f = await fixture(s);
    await seedRules(f, { ownBp: 5000, reserveBp: 1500 });
    const second = version({
      effective_from: SECOND_VERSION_AT,
      rules: version().rules.map((rule) => ({ ...rule, r_own_bp: 3000 })),
      reserves: (['jd', 'pdd', 'taobao'] as const).map((platform) => ({
        platform,
        reserve_bp: 1000,
      })),
    });
    await seedVersion(f.db, f.appId, second);

    const early = await seedVoid(f, {
      est: 1000n,
      settle: 1000n,
      platformStatus: 'SETTLED',
      receivedAt: RECEIVED_AT,
    });
    const late = await seedVoid(f, { est: 800n, paidAt: LATE_PAID_AT });
    const observed = await seedVoid(f, {
      est: 800n,
      paidAt: null,
      paidAtSource: 'observed',
      firstPaidAt: LATE_PAID_AT,
    });
    await withRestoreAdmin(f, async (h) => {
      const state = await stateOf(f, early);
      const diff = await seedAppealDiff(f, early);
      const data = await platformRestored(await h.restore(diff.id));
      expect(data.rebate_status_after).toBe('WAITING');
      expect(data.restored_fen).toBe(0);
      await expectAdjusted(f, diff, {
        adminId: h.operator.id,
        from: 'VOID',
        to: 'WAITING',
        restoredFen: 0n,
      });
      await expectRestoreStep(f, state, { from: 'VOID', to: 'WAITING' });
      expect(await orderRow(f, early.orderId)).toMatchObject({
        rebate_status: 'WAITING',
        settle_period: '2026-10',
        commission_version: 1,
      });
      const splits = await splitsOf(f, early.orderId);
      expect(splits).toHaveLength(1);
      expect(splits[0]).toMatchObject({
        rule_version_id: f.ruleVersionId,
        order_type: 'self',
        paid_at: PAID_AT,
        paid_at_source: 'platform',
        raw_n_fen: 1000n,
        reserve_bp: 1500,
        reserve_fen: 150n,
        base_fen: 850n,
      });
      expect(JSON.parse(JSON.stringify(splits[0]!.beneficiaries))).toMatchObject([
        { user_id: early.userId, role: 'self', ratio_bp: 5000 },
      ]);
      expect(await pendingOf(f, early.orderId)).toEqual([]);

      for (const [order, source] of [
        [late, 'platform'],
        [observed, 'observed'],
      ] as const) {
        const other = await seedAppealDiff(f, order);
        await platformRestored(await h.restore(other.id));
        const rows = await splitsOf(f, order.orderId);
        expect(rows, source).toHaveLength(1);
        expect(rows[0], source).toMatchObject({
          rule_version_id: second.rule_version_id,
          paid_at: LATE_PAID_AT,
          paid_at_source: source,
          raw_n_fen: 800n,
          reserve_bp: 1000,
          reserve_fen: 80n,
          base_fen: 720n,
        });
        expect(JSON.parse(JSON.stringify(rows[0]!.beneficiaries)), source).toMatchObject([
          { user_id: order.userId, role: 'self', ratio_bp: 3000 },
        ]);
      }

      const item = await withWorker(f, (worker) =>
        settleOrder(f, worker, early, { adminId: h.operator.id, settleFen: 850n }),
      );
      expect(item).toEqual({ result: 'credited', skip_reason: null });
      expect(await orderRow(f, early.orderId)).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 850n,
        booked_n_fen: 1000n,
      });
      expect(await available(f, early.userId!)).toBe(425n);
      const nets = await netsOf(f, early.orderKey);
      expect(netOf(nets, early.userId!, 'self')).toBe(425n);
      expect(nets.platform_net_fen).toBe(575n);
      expect((await orderVouchers(f, early.orderKey)).map((v) => v.uniq_key).sort()).toEqual(
        [
          `${early.orderKey}:${early.userId!}:self:CREDIT`,
          `${early.orderKey}:PLATFORM:CREDIT`,
        ].sort(),
      );
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gd#5] RECEIVED 缺快照：已归因、platform_status RECEIVED、无快照的订单恢复后回 WAITING，同事务按 paid_at 的规则版本补快照（N 1000、预留 1500 → B 850，self 5000），commission_version 0 → 1；settle_period 取 received_at 的中国月份 2026-10，不是处理时刻的 2026-11，也不是 UTC 月份 2026-09',
  async () => {
    const f = await fixture(s);
    await seedRules(f, { ownBp: 5000, reserveBp: 1500 });
    f.clock.set('2026-11-03T08:00:00.000Z');
    const order = await seedVoid(f, {
      est: 1000n,
      platformStatus: 'RECEIVED',
      receivedAt: RECEIVED_AT,
    });
    const diff = await seedAppealDiff(f, order);
    await withRestoreAdmin(f, async (h) => {
      const state = await stateOf(f, order);
      expect(state.order).toMatchObject({ commission_version: 0, settle_period: null });
      expect(await splitsOf(f, order.orderId)).toEqual([]);

      const data = await platformRestored(await h.restore(diff.id));
      expect(data.rebate_status_after).toBe('WAITING');
      expect(data.restored_fen).toBe(0);
      await expectAdjusted(f, diff, {
        adminId: h.operator.id,
        from: 'VOID',
        to: 'WAITING',
        restoredFen: 0n,
      });
      await expectRestoreStep(f, state, { from: 'VOID', to: 'WAITING' });
      expect(await orderRow(f, order.orderId)).toMatchObject({
        rebate_status: 'WAITING',
        settle_period: '2026-10',
        commission_version: 1,
      });
      const splits = await splitsOf(f, order.orderId);
      expect(splits).toHaveLength(1);
      expect(splits[0]).toMatchObject({
        rule_version_id: f.ruleVersionId,
        order_type: 'self',
        paid_at: PAID_AT,
        paid_at_source: 'platform',
        raw_n_fen: 1000n,
        reserve_bp: 1500,
        reserve_fen: 150n,
        base_fen: 850n,
      });
      expect(JSON.parse(JSON.stringify(splits[0]!.beneficiaries))).toMatchObject([
        { user_id: order.userId, role: 'self', ratio_bp: 5000 },
      ]);
      expect(await pendingOf(f, order.orderId)).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gd#6] 「生成不了」三类都不恢复（BR-CALC-10，D10-1093、D10-1105、D10-1117）：选不出任何已发布版本（只有草稿或已撤销的版本，或一个都没有）；规则齐全而付款时刻取不到（platform_modified；platform 而 paid_at 为空；observed 而没有首次付款记录；来源未识别）；淘宝推广位场景经 pids 端口取不到 → 20001 restore_snapshot_unavailable，不存幂等结果，订单仍 VOID、差错单 open、无快照、无待处理行；推广位场景取得到的淘宝单照常生成（非淘礼金）',
  async () => {
    const f = bareFixture(s);
    const noVersion = await seedVoid(f);
    const noVersionDiff = await seedAppealDiff(f, noVersion);
    const g = bareFixture(s);
    await seedVersion(g.db, g.appId, version(), 'draft');
    await seedVersion(g.db, g.appId, version(), 'revoked', PAID_AT);
    const unusable = await seedVoid(g);
    const unusableDiff = await seedAppealDiff(g, unusable);
    await withRestoreAdmin(f, async (h) => {
      const before = await stateOf(f, noVersion);
      const key = newKey();
      await unavailable(await h.restore(noVersionDiff.id, {}, { key }));
      await expectStillVoid(f, noVersion, before, noVersionDiff);
      expect((await idempotencyRows(f)).filter((row) => row.key === key)).toEqual([]);
    });
    await withRestoreAdmin(g, async (h) => {
      const before = await stateOf(g, unusable);
      await unavailable(await h.restore(unusableDiff.id));
      await expectStillVoid(g, unusable, before, unusableDiff);
    });

    const r = await fixture(s);
    await seedRules(r);
    const cases: readonly VoidSpec[] = [
      { paidAtSource: 'platform_modified' },
      { paidAtSource: 'platform', paidAt: null },
      { paidAtSource: 'observed', paidAt: null },
      { paidAtSource: 'legacy_import' },
      { platform: 'taobao', pid: 'slot-not-ours' },
    ];
    const seeded: {
      order: Awaited<ReturnType<typeof seedVoid>>;
      diff: Awaited<ReturnType<typeof seedAppealDiff>>;
    }[] = [];
    for (const spec of cases) {
      const order = await seedVoid(r, spec);
      seeded.push({ order, diff: await seedAppealDiff(r, order) });
    }
    const union = await account(r.db, { platform: 'taobao', app_id: r.appId });
    await pid(r.db, union, { pid: 'slot-known', pid_scene: 'self_buy' });
    const known = await seedVoid(r, { platform: 'taobao', pid: 'slot-known' });
    const knownDiff = await seedAppealDiff(r, known);
    await withRestoreAdmin(r, async (h) => {
      for (const { order, diff } of seeded) {
        const before = await stateOf(r, order);
        await unavailable(await h.restore(diff.id));
        await expectStillVoid(r, order, before, diff);
      }
      const data = await platformRestored(await h.restore(knownDiff.id));
      expect(data.rebate_status_after).toBe('ESTIMATED');
      const splits = await splitsOf(r, known.orderId);
      expect(splits).toHaveLength(1);
      expect(splits[0]).toMatchObject({ rebate_mode: null, raw_n_fen: 800n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gd#7] 佣金未回传照常恢复且同事务写快照类待处理行（京东 AMOUNT_PARSE_FAILED、拼多多无服务费 SERVICE_FEE_RATE_MISSING），重试扫描在佣金回传后捡到它并生成快照；版本里缺平台预留或规则的也恢复，写 RULE_VERSION_PLATFORM_MISSING，都不生成快照',
  async () => {
    const f = await fixture(s);
    await seedRules(f);
    const jd = await seedVoid(f, { est: null });
    const pdd = await seedVoid(f, { platform: 'pdd', est: null });
    const jdDiff = await seedAppealDiff(f, jd);
    const pddDiff = await seedAppealDiff(f, pdd);

    const g = await fixture(s);
    await seedRules(g, { rulePlatforms: [], reservePlatforms: ['pdd'] });
    const noReserve = await seedVoid(g);
    const noRule = await seedVoid(g, { platform: 'pdd' });
    const noReserveDiff = await seedAppealDiff(g, noReserve);
    const noRuleDiff = await seedAppealDiff(g, noRule);

    await withRestoreAdmin(f, async (h) => {
      for (const [order, diff, reason] of [
        [jd, jdDiff, 'AMOUNT_PARSE_FAILED'],
        [pdd, pddDiff, 'SERVICE_FEE_RATE_MISSING'],
      ] as const) {
        const data = await platformRestored(await h.restore(diff.id));
        expect(data.rebate_status_after, reason).toBe('ESTIMATED');
        expect(await orderRow(f, order.orderId), reason).toMatchObject({
          rebate_status: 'ESTIMATED',
        });
        expect(await splitsOf(f, order.orderId), reason).toEqual([]);
        expect(await pendingOf(f, order.orderId), reason).toMatchObject([
          {
            app_id: f.appId,
            order_id: order.orderId,
            platform: order.platform,
            sub_order_id: order.subOrderId,
            reason,
            status: 'open',
          },
        ]);
      }
    });

    await f.db
      .updateTable('orders')
      .set({ est_commission_fen: 1000n })
      .where('app_id', '=', f.appId)
      .where('order_id', '=', jd.orderId)
      .execute();
    f.clock.advanceMs(HOUR_MS + 1000);
    await withWorker(f, (worker) => scanSnapshots(f, worker));
    const splits = await splitsOf(f, jd.orderId);
    expect(splits).toHaveLength(1);
    expect(splits[0]).toMatchObject({ raw_n_fen: 1000n, reserve_bp: 1500, base_fen: 850n });
    expect(await pendingOf(f, jd.orderId)).toMatchObject([
      { reason: 'AMOUNT_PARSE_FAILED', status: 'resolved' },
    ]);

    await withRestoreAdmin(g, async (h) => {
      for (const [order, diff] of [
        [noReserve, noReserveDiff],
        [noRule, noRuleDiff],
      ] as const) {
        const data = await platformRestored(await h.restore(diff.id));
        expect(data.rebate_status_after, order.platform).toBe('ESTIMATED');
        expect(await splitsOf(g, order.orderId), order.platform).toEqual([]);
        expect(await pendingOf(g, order.orderId), order.platform).toMatchObject([
          { reason: 'RULE_VERSION_PLATFORM_MISSING', status: 'open' },
        ]);
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gd#8] 不需要补的照常恢复且不动快照：未归因回 UNATTRIBUTED、定金阶段（DEPOSIT_PAID）回 ESTIMATED，都不生成快照、不写待处理行；已有快照的不重写（commission_version 不变）',
  async () => {
    const f = await fixture(s);
    await seedRules(f);
    const cases: readonly (readonly [string, VoidSpec, string, number])[] = [
      ['unattributed', { userId: null }, 'UNATTRIBUTED', 0],
      ['deposit', { platformStatus: 'DEPOSIT_PAID' }, 'ESTIMATED', 0],
      ['existing', { snapshot: true }, 'ESTIMATED', 1],
    ];
    await withRestoreAdmin(f, async (h) => {
      for (const [name, spec, to, splitCount] of cases) {
        const order = await seedVoid(f, spec);
        const diff = await seedAppealDiff(f, order);
        const before = await orderRow(f, order.orderId);
        const splits = await splitsOf(f, order.orderId);
        expect(splits, name).toHaveLength(splitCount);

        const data = await platformRestored(await h.restore(diff.id));
        expect(data.rebate_status_after, name).toBe(to);
        expect(await orderRow(f, order.orderId), name).toMatchObject({
          rebate_status: to,
          commission_version: before.commission_version,
        });
        expect(await splitsOf(f, order.orderId), name).toEqual(splits);
        expect(await pendingOf(f, order.orderId), name).toEqual([]);
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gd#9] 平台恢复路径的 R12 同样补快照（BR-FUND-22）：首次入库即 INVALID、后被平台恢复的已付款单，处理后有 commission_splits，commission_version 1；生成不了的同样 20001 restore_snapshot_unavailable',
  async () => {
    const f = await fixture(s);
    await seedRules(f);
    const cases: readonly (readonly [PlatformStatus, Platform])[] = [
      ['PAID', 'jd'],
      ['SETTLED', 'pdd'],
    ];
    await withRestoreAdmin(f, async (h) => {
      for (const [platformStatus, platform] of cases) {
        const order = await seedVoid(f, {
          reason: 'REFUND',
          platform,
          platformStatus,
          receivedAt: platformStatus === 'SETTLED' ? RECEIVED_AT : null,
          settle: platformStatus === 'SETTLED' ? 1000n : null,
        });
        const diff = await seedPlatformDiff(f, order);
        const data = await platformRestored(await h.restore(diff.id));
        expect(data.restored_fen, platformStatus).toBe(0);
        const splits = await splitsOf(f, order.orderId);
        expect(splits, platformStatus).toHaveLength(1);
        expect(splits[0], platformStatus).toMatchObject({ rule_version_id: f.ruleVersionId });
        expect(await orderRow(f, order.orderId), platformStatus).toMatchObject({
          commission_version: 1,
        });
      }

      const refused = await seedVoid(f, { reason: 'REFUND', paidAtSource: 'platform_modified' });
      const refusedDiff = await seedPlatformDiff(f, refused);
      const before = await stateOf(f, refused);
      await unavailable(await h.restore(refusedDiff.id));
      await expectStillVoid(f, refused, before, refusedDiff);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gd#12] 同事务：审计写失败时快照与待处理行随 R12 一起回滚（5xx，订单仍 VOID、差错单 open、无快照），修好后重试恢复一次并生成快照；已处理的差错单再处理 20902',
  async () => {
    const f = await fixture(s);
    await seedRules(f);
    const order = await seedVoid(f);
    const diff = await seedAppealDiff(f, order);
    await withRestoreAdmin(f, async (h) => {
      const before = await stateOf(f, order);
      h.fault.point = 'audit';
      await answer(await h.restore(diff.id), 50001);
      expect(h.fault.tripped).toBe(1);
      await expectStillVoid(f, order, before, diff);

      const data = await platformRestored(await h.restore(diff.id));
      expect(data.rebate_status_after).toBe('ESTIMATED');
      const splits = await splitsOf(f, order.orderId);
      expect(splits).toHaveLength(1);

      await answer(await h.restore(diff.id), 20902, { resource: 'recon_diff' });
      expect(await splitsOf(f, order.orderId)).toEqual(splits);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gd#12] 同事务（待处理分支）：佣金未回传（est 为空）的恢复，审计写失败时待处理行随 R12 一起回滚（5xx，订单仍 VOID、差错单 open、无快照、无待处理行）；修好后重试恢复一次，恰有一条 AMOUNT_PARSE_FAILED 待处理行',
  async () => {
    const f = await fixture(s);
    await seedRules(f);
    const order = await seedVoid(f, { est: null });
    const diff = await seedAppealDiff(f, order);
    await withRestoreAdmin(f, async (h) => {
      const before = await stateOf(f, order);
      h.fault.point = 'audit';
      await answer(await h.restore(diff.id), 50001);
      expect(h.fault.tripped).toBe(1);
      await expectStillVoid(f, order, before, diff);

      const data = await platformRestored(await h.restore(diff.id));
      expect(data.rebate_status_after).toBe('ESTIMATED');
      await expectAdjusted(f, diff, {
        adminId: h.operator.id,
        from: 'VOID',
        to: 'ESTIMATED',
        restoredFen: 0n,
      });
      expect(await splitsOf(f, order.orderId)).toEqual([]);
      expect(await pendingOf(f, order.orderId)).toMatchObject([
        {
          app_id: f.appId,
          order_id: order.orderId,
          reason: 'AMOUNT_PARSE_FAILED',
          status: 'open',
        },
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gd#13] 没有已发布版本优先于佣金未回传（D10-1131）：已归因、PAID、VOID、无快照、est 与 settle 都为空，且应用没有任何已发布规则版本（一个都没有，或只有草稿和已撤销的）→ 20001 restore_snapshot_unavailable，不按佣金未回传恢复：订单仍 VOID、差错单 open、无快照、没有新增快照类待处理行（京东 AMOUNT_PARSE_FAILED、拼多多 SERVICE_FEE_RATE_MISSING 两种口径）',
  async () => {
    const noVersion = bareFixture(s);
    const unusable = bareFixture(s);
    await seedVersion(unusable.db, unusable.appId, version(), 'draft');
    await seedVersion(unusable.db, unusable.appId, version(), 'revoked', PAID_AT);
    const cases: readonly (readonly [RestoreFixture, Platform])[] = [
      [noVersion, 'jd'],
      [noVersion, 'pdd'],
      [unusable, 'jd'],
    ];
    for (const [app, platform] of cases) {
      const order = await seedVoid(app, { platform, est: null, settle: null });
      const diff = await seedAppealDiff(app, order);
      await withRestoreAdmin(app, async (h) => {
        const before = await stateOf(app, order);
        await unavailable(await h.restore(diff.id));
        await expectStillVoid(app, order, before, diff);
        expect(await pendingOf(app, order.orderId), platform).toEqual([]);
      });
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gd#14] 付款时间早于首个已发布版本的 effective_from（paid_at 2026-08-19，首版 2026-08-20）不算生成不了（BR-CALC-11，D10-1131）：恢复回 ESTIMATED，快照按首版而不是后一版（N 1000、预留 2000 → B 800，self 4000），paid_at 保持原值，commission_version 1，无待处理行；有指向首版的 PAID_AT_BEFORE_FIRST_RULE_VERSION 告警',
  async () => {
    const f = await fixture(s);
    await seedRules(f, { ownBp: 4000, reserveBp: 2000 });
    const later = version({
      effective_from: SECOND_VERSION_AT,
      rules: version().rules.map((rule) => ({ ...rule, r_own_bp: 3000 })),
      reserves: (['jd', 'pdd', 'taobao'] as const).map((platform) => ({
        platform,
        reserve_bp: 1000,
      })),
    });
    await seedVersion(f.db, f.appId, later);
    const paidAt = new Date('2026-08-19T00:00:00.000Z');
    const order = await seedVoid(f, { est: 1000n, paidAt });
    const diff = await seedAppealDiff(f, order);
    await withEntryLog(async (lines) => {
      await withRestoreAdmin(f, async (h) => {
        const state = await stateOf(f, order);

        const data = await platformRestored(await h.restore(diff.id));
        expect(data.rebate_status_after).toBe('ESTIMATED');
        expect(data.restored_fen).toBe(0);
        await expectAdjusted(f, diff, {
          adminId: h.operator.id,
          from: 'VOID',
          to: 'ESTIMATED',
          restoredFen: 0n,
        });
        await expectRestoreStep(f, state, { from: 'VOID', to: 'ESTIMATED' });
        expect(await orderRow(f, order.orderId)).toMatchObject({
          rebate_status: 'ESTIMATED',
          commission_version: 1,
        });
        const splits = await splitsOf(f, order.orderId);
        expect(splits).toHaveLength(1);
        expect(splits[0]).toMatchObject({
          rule_version_id: f.ruleVersionId,
          order_type: 'self',
          paid_at: paidAt,
          paid_at_source: 'platform',
          raw_n_fen: 1000n,
          reserve_bp: 2000,
          reserve_fen: 200n,
          base_fen: 800n,
        });
        expect(JSON.parse(JSON.stringify(splits[0]!.beneficiaries))).toMatchObject([
          { user_id: order.userId, role: 'self', ratio_bp: 4000 },
        ]);
        expect(await pendingOf(f, order.orderId)).toEqual([]);
        expectWarned(lines, {
          code: 'PAID_AT_BEFORE_FIRST_RULE_VERSION',
          app_id: f.appId,
          order_id: order.orderId,
          rule_version_id: f.ruleVersionId,
        });
      });
    });
  },
  TIMEOUT,
);
