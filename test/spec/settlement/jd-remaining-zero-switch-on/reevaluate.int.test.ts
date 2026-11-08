// B2-04zzh 一次性重评 CLI（任务书 §9.2 第 3 条；D10-923 / D10-930；BR-CALC-15、BR-FUND-07、BR-FUND-01 R6）：
// apps/api/scripts/jd-remaining-zero-reevaluate.ts --app <app_id> --actor <运维执行人> [--apply]。扫该 app 京东、
// rebate_status ∈ {UNATTRIBUTED, ESTIMATED, WAITING}、两列非空且剩余 ≤ 0 的单；默认只列清单、什么都不写；--apply 且
// 开关开 → 逐单 R6 → VOID（PLATFORM_INVALID、reason REFUND、无分录）、各一条 order.invalidated、各一条 audit_logs
// （actor、target orders:<order_id>、前后状态）；再跑一次 0 张（幂等）；开关关时 --apply 只列清单不改；只动 --app 那个
// app；不打子订单号、用户与买家参数；参数不合法退出码 2、什么都不写。CLI 由 run(argv, deps) 进入（不起子进程）。
// 主干没有这个入口（骨架抛 NotImplemented）：每条都红。
// Task-local AC labels ([AC-B2-04zzh#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  EXIT_INVALID,
  EXIT_OK,
  JD_INVALID,
  SWITCH,
  TIMEOUT,
  counts,
  databaseFixture,
  precredit,
  touched,
  withWorker,
  zeroed,
  type App,
  type SyncedOrder,
  type Worker,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/**
 * The orders of one app, all synced while the switch was off: three candidates (jd, 2 of 2 refunded,
 * UNATTRIBUTED / ESTIMATED / WAITING) and every kind of order the CLI must leave alone.
 */
async function population(w: Worker, app: App) {
  const unattributed = w.order(app, 'jd', counts(2, 2), { unattributed: true });
  await unattributed.sync();
  expect(await unattributed.row()).toMatchObject({
    rebate_status: 'UNATTRIBUTED',
    quantity: 2,
    refunded_quantity: 2,
  });
  const estimated = await zeroed(w, app, 'ESTIMATED');
  const waiting = await zeroed(w, app, 'WAITING');

  // Remaining 1 of 3.
  const left = await precredit(w, app, 'jd', 'ESTIMATED', counts(3, 2));
  // jd without the counts.
  const uncounted = await precredit(w, app, 'jd', 'ESTIMATED', counts(null, null));
  // Not jd.
  const pdd = await precredit(w, app, 'pdd', 'ESTIMATED', counts(2, 2));
  // Credited (R9 is B1-08zi's, not this CLI's).
  const credited = await zeroed(w, app, 'WAITING');
  await credited.credited(2);
  // Already VOID (the platform said invalid), then refunded.
  const voided = await precredit(w, app, 'jd', 'ESTIMATED');
  await voided.sync(touched(6, { raw_status: JD_INVALID, ...counts(2, 2) }));
  expect(await voided.row()).toMatchObject({ rebate_status: 'VOID', refunded_quantity: 2 });

  return {
    candidates: [
      { order: unattributed, from: 'UNATTRIBUTED' },
      { order: estimated, from: 'ESTIMATED' },
      { order: waiting, from: 'WAITING' },
    ] as const,
    untouched: [left, uncounted, pdd, credited, voided] as const,
  };
}

async function orderIds(orders: readonly SyncedOrder[]): Promise<string[]> {
  const ids: string[] = [];
  for (const o of orders) ids.push((await o.row()).order_id);
  return ids;
}

/** Nothing the CLI prints names a sub-order or a member. */
async function expectNoPersonalFields(
  output: readonly string[],
  orders: readonly SyncedOrder[],
  app: App,
): Promise<void> {
  const text = output.join('\n');
  for (const o of orders) {
    expect(text).not.toContain(o.subOrderId);
    const row = await o.row();
    if (row.user_id !== null) expect(text).not.toContain(row.user_id);
  }
  expect(text).not.toContain(app.userId);
}

it(
  '[AC-B2-04zzh#7] 开关开：dry-run 只列出 3 张剩余 ≤ 0 的 UNATTRIBUTED / ESTIMATED / WAITING 京东单（不含剩余 > 0、两列为空、非京东、已入账、已 VOID 的单，不含别的 app 的单），什么都不写，不打子订单号与用户',
  async () => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      const other = await w.app();
      const set = await population(w, app);
      const elsewhere = await zeroed(w, other, 'ESTIMATED');
      await w.setConfig(app, SWITCH, true);
      await w.setConfig(other, SWITCH, true);
      const before = await w.stateOf(app);
      const otherBefore = await w.stateOf(other);
      const cli = await w.cli();

      const result = await cli.run(['--app', app.appId, '--actor', app.adminId]);

      expect(result).toEqual({ exitCode: EXIT_OK, candidates: 3, voided: 0, skipped: 0 });
      const text = cli.output.join('\n');
      for (const id of await orderIds(set.candidates.map((c) => c.order))) {
        expect(text).toContain(id);
      }
      for (const id of await orderIds([...set.untouched, elsewhere])) {
        expect(text).not.toContain(id);
      }
      const all = [...set.candidates.map((c) => c.order), ...set.untouched];
      await expectNoPersonalFields(cli.output, all, app);
      expect(await w.stateOf(app)).toEqual(before);
      expect(await w.stateOf(other)).toEqual(otherBefore);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzh#8] 开关开 --apply：3 张候选逐单 R6 → VOID（PLATFORM_INVALID、reason REFUND）、各恰一条 order.invalidated、各一条 audit_logs（actor = --actor、target orders:<order_id>、前后状态），无分录；其余单与别的 app 逐行不变；再跑一次 0 张、什么都不写',
  async () => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      const other = await w.app();
      const set = await population(w, app);
      const elsewhere = await zeroed(w, other, 'ESTIMATED');
      await w.setConfig(app, SWITCH, true);
      await w.setConfig(other, SWITCH, true);
      const untouchedRows = await Promise.all(set.untouched.map((o) => o.row()));
      const untouchedHistory = await Promise.all(set.untouched.map((o) => o.history()));
      const untouchedEvents = await Promise.all(set.untouched.map((o) => o.invalidated()));
      const ledger = await w.ledgerOf(app);
      const otherBefore = await w.stateOf(other);
      const cli = await w.cli();

      const result = await cli.run(['--app', app.appId, '--actor', app.adminId, '--apply']);

      expect(result).toEqual({ exitCode: EXIT_OK, candidates: 3, voided: 3, skipped: 0 });
      const audits = await w.auditsOf(app);
      expect(audits).toHaveLength(3);
      for (const { order, from } of set.candidates) {
        const row = await order.row();
        expect(row).toMatchObject({
          rebate_status: 'VOID',
          reason: 'REFUND',
          reason_sub: null,
          quantity: 2,
          refunded_quantity: 2,
          booked_base_fen: null,
        });
        const voids = await order.voids();
        expect(voids).toHaveLength(1);
        expect(voids[0]).toMatchObject({
          from_status: from,
          event: 'PLATFORM_INVALID',
          to_status: 'VOID',
        });
        const events = await order.invalidated();
        expect(events).toHaveLength(1);
        expect(events[0]!.payload).toMatchObject({
          order_id: row.order_id,
          platform: 'jd',
          reason: 'REFUND',
        });
        const own = audits.filter((a) => a.target === `orders:${row.order_id}`);
        expect(own).toHaveLength(1);
        expect(own[0]).toMatchObject({ admin_id: app.adminId, system_actor: null });
        expect(JSON.stringify(own[0]!.before)).toContain(from);
        expect(JSON.stringify(own[0]!.after)).toContain('VOID');
      }
      expect(await Promise.all(set.untouched.map((o) => o.row()))).toEqual(untouchedRows);
      expect(await Promise.all(set.untouched.map((o) => o.history()))).toEqual(untouchedHistory);
      expect(await Promise.all(set.untouched.map((o) => o.invalidated()))).toEqual(untouchedEvents);
      expect(await w.ledgerOf(app)).toEqual(ledger);
      expect(await elsewhere.row()).toMatchObject({ rebate_status: 'ESTIMATED', reason: null });
      expect(await w.stateOf(other)).toEqual(otherBefore);
      const all = [...set.candidates.map((c) => c.order), ...set.untouched];
      await expectNoPersonalFields(cli.output, all, app);

      const after = await w.stateOf(app);
      const again = await cli.run(['--app', app.appId, '--actor', app.adminId, '--apply']);

      expect(again).toEqual({ exitCode: EXIT_OK, candidates: 0, voided: 0, skipped: 0 });
      expect(await w.stateOf(app)).toEqual(after);
      const listed = await cli.run(['--app', app.appId, '--actor', app.adminId]);
      expect(listed).toEqual({ exitCode: EXIT_OK, candidates: 0, voided: 0, skipped: 0 });
    });
  },
  TIMEOUT,
);

const OFF: readonly (readonly [string, unknown])[] = [
  ['未配置', undefined],
  ['false', false],
];

it.each(OFF)(
  '[AC-B2-04zzh#9] 开关%s：--apply 只列清单（3 张）、一张不改，不写历史、事件、审计、分录',
  async (_name, value) => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      const set = await population(w, app);
      if (value !== undefined) await w.setConfig(app, SWITCH, value);
      const before = await w.stateOf(app);
      const cli = await w.cli();

      const result = await cli.run(['--app', app.appId, '--actor', app.adminId, '--apply']);

      expect(result).toMatchObject({ exitCode: EXIT_OK, candidates: 3, voided: 0 });
      const text = cli.output.join('\n');
      for (const id of await orderIds(set.candidates.map((c) => c.order))) {
        expect(text).toContain(id);
      }
      expect(await w.stateOf(app)).toEqual(before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzh#10] 参数不合法（缺 --app、--apply 缺 --actor、未知参数、多余位置参数）→ 退出码 2，计数全 0，什么都不写',
  async () => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      await zeroed(w, app, 'WAITING');
      await w.setConfig(app, SWITCH, true);
      const before = await w.stateOf(app);
      const cli = await w.cli();
      const invalid: readonly (readonly string[])[] = [
        ['--actor', app.adminId, '--apply'],
        ['--app', app.appId, '--apply'],
        ['--app', app.appId, '--actor', app.adminId, '--apply', '--force'],
        ['--app', app.appId, '--actor', app.adminId, '--apply', 'extra'],
      ];

      for (const argv of invalid) {
        const result = await cli.run(argv);
        expect(result, argv.join(' ')).toEqual({
          exitCode: EXIT_INVALID,
          candidates: 0,
          voided: 0,
          skipped: 0,
        });
      }
      expect(await w.stateOf(app)).toEqual(before);
    });
  },
  TIMEOUT,
);
