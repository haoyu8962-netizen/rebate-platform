import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { accountingDate, settlementBillPeriod } from '@couli/domain';
import { sql } from 'kysely';
import { expect, it, vi } from 'vitest';
import { createDailyCheck } from '../../../apps/api/src/modules/ledger/application/daily-check.ts';
import { dailyCheckDoneEventId } from '../../../apps/api/src/modules/ledger/application/daily-check-schedule-done.ts';
import { dailyCheckDayAfter } from '../../../apps/api/src/modules/ledger/application/daily-check-schedule.ts';
import { directoryInvariantSource } from '../../../apps/api/src/modules/ledger/infra/invariant-files.ts';
import { confirmAdminSettleBill } from '../../../apps/api/src/modules/settlement/application/admin-settle-commands.ts';
import { getAdminSettleBill } from '../../../apps/api/src/modules/settlement/application/admin-settle-bills.ts';
import { scanDueBatches } from '../../../apps/api/src/modules/settlement/worker/schedule.ts';
import { DemoUnionAdapter } from '../../../apps/api/src/modules/union/index.ts';
import { checkpoint, startReplay } from '../qa-03a/driver.ts';
import { PAID, RECEIVED, demoStream, streamRows } from '../qa-03a/stream-fixture.ts';
import { logger, startWorker } from './worker.ts';

// BR-FUND-04: N=1000, reserve=0, self=5000bp, no uplines => self=500,
// platform=500 per order. Three orders => 1500 user / 1500 platform / 3000 receivable.
// These are fixture inputs and hand-calculated expectations, never copied from bill output.
it.each([22, 24, 28])(
  '[AC-QA-03b#1] 合成数据回放：账单日 %i 出账→校验→应用层确认→批次入账；四段差异为零',
  async (billDay) => {
    const provenance = JSON.parse(
      readFileSync(new URL('./provenance.json', import.meta.url), 'utf8'),
    ) as {
      source: string;
      minimum_volume: {
        bills: number;
        validated_orders: number;
        confirmed_batches: number;
        credited_orders: number;
      };
    };
    expect(provenance.source).toBe('synthetic');
    expect(provenance.minimum_volume).toEqual({
      bills: 1,
      validated_orders: 3,
      confirmed_batches: 1,
      credited_orders: 3,
    });
    // Keep QA-03a's explicit orderStream and event identities. Only synthetic input amounts change.
    const originalList = DemoUnionAdapter.prototype.listOrders;
    const inputSpy = vi
      .spyOn(DemoUnionAdapter.prototype, 'listOrders')
      .mockImplementation(async function (this: DemoUnionAdapter, ...args) {
        const page = await originalList.apply(this, args);
        return {
          ...page,
          items: page.items.map((row) => ({
            ...row,
            commission_fen: 1000n,
            est_commission_fen: 1000n,
            service_fee_fen: 0n,
          })),
        };
      });
    let h: Awaited<ReturnType<typeof startReplay>> | undefined;
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      h = await startReplay({ createTestDatabase, acquireTestRedis });
      const { db, appId, clock, time, userId } = h;
      const followed = await h.follow();
      const seeds = h.orderSeeds(followed);
      expect(seeds).toHaveLength(3);
      const sync = await h.syncDriver(seeds);
      time.moveTo('2026-10-05T10:10:00+08:00');
      await sync(PAID, '2026-10-05T10:10:00+08:00');
      time.moveTo('2026-10-08T20:10:00+08:00');
      await sync(RECEIVED, '2026-10-08T20:10:00+08:00');
      const orders = () =>
        db
          .selectFrom('orders')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('order_id')
          .execute();
      const waiting = await orders();
      expect(waiting).toHaveLength(3);
      for (const row of waiting)
        expect(row).toMatchObject({
          user_id: userId,
          platform_status: 'RECEIVED',
          rebate_status: 'WAITING',
          settle_period: '2026-10',
          received_at: new Date(RECEIVED),
          settle_commission_fen: null,
        });
      await checkpoint(db, clock, appId);

      // Configuration only. Default 24 is deliberately left unset; endpoints 22 / 28 are explicit.
      const settings: [string, number | boolean][] = [
        ['settle.auto.enabled', true],
        ['credit.enabled.pdd', true],
      ];
      if (billDay !== 24) settings.push(['settle.bill_day', billDay]);
      await db
        .insertInto('config_items')
        .values(
          settings.map(([key, value]) => ({
            app_id: appId,
            key,
            value,
            updated_by: 'synthetic-replay',
          })),
        )
        .execute();
      worker = await startWorker(h);
      const w = worker;
      const receivedInputs = await streamRows(
        demoStream(clock, seeds),
        {
          from: RECEIVED,
          to: '2026-10-08T20:10:00+08:00',
        },
        appId,
      );
      expect(receivedInputs).toHaveLength(3);
      time.moveTo('2026-11-20T12:00:00+08:00');
      // Explicit synthetic normalized DTOs, as in settlement-records/kit.ts; raw_status 5 is
      // the existing PDD mapping's SETTLED event. No vendor payload or capability claim is made.
      for (const row of receivedInputs) {
        const result = await w.pipeline.process(
          {
            ...row,
            raw_status: '5',
            modified_at: clock.now(),
            settled_at: new Date('2026-11-20T11:00:00+08:00'),
            settle_commission_fen: 1000n,
            raw_payload_id: null,
          },
          {
            app_id: appId,
            platform: 'pdd',
            union_account_id: h.accountId,
            query_kind: 'increment',
            scene: '-',
            window_start: '2026-11-20T11:00:00+08:00',
            window_end: '2026-11-20T12:00:00+08:00',
            requestId: randomUUID(),
          },
        );
        expect(result).toMatchObject({ kind: 'updated' });
      }
      for (const row of await orders())
        expect(row).toMatchObject({
          platform_status: 'SETTLED',
          rebate_status: 'WAITING',
          received_at: new Date(RECEIVED),
          settle_period: '2026-10',
          settle_commission_fen: 1000n,
        });
      const settlements = await db
        .selectFrom('order_settlements')
        .selectAll()
        .where('app_id', '=', appId)
        .execute();
      expect(settlements).toHaveLength(3);
      for (const row of settlements)
        expect(row).toMatchObject({ source: 'API', seq: 1, settle_commission_fen: 1000n });
      const bills = () =>
        db.selectFrom('settle_bills').selectAll().where('app_id', '=', appId).execute();
      const batches = () =>
        db
          .selectFrom('settle_batches')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('batch_id')
          .execute();
      const items = () =>
        db
          .selectFrom('settle_batch_items')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('order_id')
          .execute();
      const money = async () => ({
        vouchers: await db
          .selectFrom('ledger_vouchers')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('id')
          .execute(),
        entries: await db
          .selectFrom('ledger_entries')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('id')
          .execute(),
        balances: await db
          .selectFrom('account_balances')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('account_id')
          .execute(),
      });
      time.moveTo(`2026-11-${billDay - 1}T10:00:00+08:00`);
      await w.deliver('bill', {
        app_id: appId,
        platform: 'pdd',
        accounting_date: accountingDate(clock.now()),
      });
      expect(await bills(), 'BILL_NOT_DUE').toEqual([]);
      time.moveTo(`2026-11-${billDay}T10:00:00+08:00`);
      const day = accountingDate(clock.now());
      const billId = settlementBillPeriod(clock.now());
      expect(billId).toBe('2026-10');
      const billPayload = { app_id: appId, platform: 'pdd', accounting_date: day };
      const beforeMoney = await money();
      expect(beforeMoney.vouchers).toEqual([]);
      await w.deliver('bill', billPayload);
      const generated = await bills();
      expect(generated.length, 'BILL_VOLUME').toBeGreaterThanOrEqual(
        provenance.minimum_volume.bills,
      );
      expect(generated).toHaveLength(1);
      expect(generated[0], 'BILL_TOTALS').toMatchObject({
        bill_id: billId,
        beneficiary_total_fen: 1500n,
        platform_retained_fen: 1500n,
        error_count: 0,
        held_count: 0,
      });
      expect(generated[0]!.generated_at).toEqual(clock.now());
      const view = () => getAdminSettleBill({ db, now: () => clock.now() }, appId, billId);
      expect(await view()).toMatchObject({ status: 'issued' });
      await checkpoint(db, clock, appId); // 出账段

      const draft = await batches();
      expect(draft.length).toBeGreaterThanOrEqual(provenance.minimum_volume.confirmed_batches);
      expect(draft).toHaveLength(1);
      expect(draft[0]).toMatchObject({
        bill_id: billId,
        platform: 'pdd',
        status: 'DRAFT',
        order_count: 3,
      });
      const validated = await items();
      expect(validated.length, 'VALIDATED_VOLUME').toBeGreaterThanOrEqual(
        provenance.minimum_volume.validated_orders,
      );
      expect(validated.map((row) => row.order_id)).toEqual(waiting.map((row) => row.order_id));
      for (const row of validated)
        expect(row, 'VALIDATED_AMOUNT').toMatchObject({
          item_type: 'order',
          settle_seq: 1,
          b_settle_fen: 1000n,
          result: null,
        });
      expect(
        await db.selectFrom('recon_diffs').select('id').where('app_id', '=', appId).execute(),
        'VALIDATION_DIFFS',
      ).toEqual([]);
      expect(await money(), 'VALIDATION_NO_MONEY').toEqual(beforeMoney);
      await w.deliver('bill', billPayload);
      expect(await bills(), 'BILL_REDELIVERY').toEqual(generated);
      expect(await batches()).toEqual(draft);
      expect(await items()).toEqual(validated);
      await checkpoint(db, clock, appId); // 一致性校验段

      // Automated human substitute, not an auth test. See README for settle.bill / TOTP coverage.
      const adminId = randomUUID();
      await db
        .insertInto('admin_users')
        .values({
          id: adminId,
          app_id: appId,
          login_name: `qa03b-${adminId}`,
          password_hash: 'unused-synthetic-login',
          is_super: false,
          status: 'active',
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .execute();
      time.moveTo(`2026-11-${billDay}T10:01:00+08:00`);
      const confirmation = await confirmAdminSettleBill(
        w.commands,
        { appId, adminId, ip: '127.0.0.1' },
        billId,
        {
          expected_batches: draft.map((row) => ({
            batch_id: row.batch_id,
            expected_row_version: row.row_version,
          })),
          settle_mode: 'IMMEDIATE',
        },
        randomUUID(),
      );
      expect(confirmation.status, 'CONFIRM_OK').toBe(200);
      const confirmed = await batches();
      for (const row of confirmed)
        expect(row, 'CONFIRM_STATE').toMatchObject({
          status: 'CONFIRMED',
          confirmed_by: adminId,
          confirmed_at: clock.now(),
          settle_mode: 'IMMEDIATE',
          scheduled_at: null,
          row_version: draft.find((old) => old.batch_id === row.batch_id)!.row_version + 1,
        });
      expect(await view()).toMatchObject({ status: 'settling' });
      expect(await money(), 'CONFIRM_NO_MONEY').toEqual(beforeMoney);
      expect(
        await db
          .selectFrom('audit_logs')
          .select(['admin_id', 'action', 'target'])
          .where('app_id', '=', appId)
          .where('action', '=', 'settle_bill_confirm')
          .execute(),
        'CONFIRM_AUDIT',
      ).toEqual([{ admin_id: adminId, action: 'settle_bill_confirm', target: billId }]);
      await checkpoint(db, clock, appId); // 人工确认段

      w.queue.send.mockClear();
      await scanDueBatches({ db, clock, queue: w.queue, logger });
      const deliveries = w.queue.send.mock.calls.filter(
        ([queue, name]) => queue === 'settle' && name === 'batch_execute',
      );
      expect(deliveries).toHaveLength(confirmed.length);
      for (const [, name, payload, options] of deliveries) {
        expect(options.singletonKey).toBe(`batch_execute:${appId}:${String(payload['batch_id'])}`);
        await w.deliver(name, payload);
      }
      const credited = await orders();
      expect(
        credited.filter((row) => row.rebate_status === 'CREDITED').length,
        'CREDIT_VOLUME',
      ).toBeGreaterThanOrEqual(provenance.minimum_volume.credited_orders);
      for (const row of credited)
        expect(row, 'CREDIT_BOOKED').toMatchObject({
          rebate_status: 'CREDITED',
          booked_base_fen: 1000n,
          booked_n_fen: 1000n,
        });
      for (const row of await items())
        expect(row).toMatchObject({ result: 'credited', skip_reason: null });
      for (const row of await batches())
        expect(row, 'BATCH_DONE').toMatchObject({ status: 'DONE', credited_count: 3 });
      expect(await view()).toMatchObject({ status: 'settled' });
      const userAccount = await db
        .selectFrom('ledger_accounts')
        .select('id')
        .where('app_id', '=', appId)
        .where('owner_type', '=', 'user')
        .where('owner_id', '=', userId)
        .where('subject', '=', 'USER_BALANCE')
        .executeTakeFirstOrThrow();
      const userBalance = await db
        .selectFrom('account_balances')
        .selectAll()
        .where('app_id', '=', appId)
        .where('account_id', '=', userAccount.id)
        .executeTakeFirstOrThrow();
      expect(userBalance, 'CREDIT_BALANCE').toMatchObject({ available_fen: 1500n, frozen_fen: 0n });
      const afterMoney = await money();
      const selfCredits = afterMoney.vouchers.filter(
        (row) => row.voucher_kind === 'CREDIT' && row.beneficiary_user_id === userId,
      );
      expect(selfCredits, 'CREDIT_UNIQUE').toHaveLength(3);
      for (const voucher of selfCredits) {
        const entry = afterMoney.entries.filter(
          (row) => row.voucher_id === voucher.id && row.account_id === userAccount.id,
        );
        expect(entry).toHaveLength(1);
        // SPEC_REF 62b5c99338f8，08/06 BR-FUND-16：借为正、贷为负；
        // 第 1170 行明确用户负债账户贷记为负。本人份额 500 分 => amount_fen=-500，
        // 可提现余额仍增加 500 分，三单余额与账单本人合计仍为 +1500 分。
        expect(entry[0], 'CREDIT_SHARE').toMatchObject({
          amount_fen: -500n,
          ledger_type: 'REBATE_CREDIT',
          booked_at: clock.now(),
        });
      }
      await checkpoint(db, clock, appId); // 批次入账段
      for (const [, name, payload] of deliveries) await w.deliver(name, payload);
      expect(await money(), 'CREDIT_REDELIVERY').toEqual(afterMoney);
      expect(await orders()).toEqual(credited);
      await checkpoint(db, clock, appId);

      // Real BR-FUND-19 daily handler at D+1 01:00, checking D, not the trigger day's empty ledger.
      time.moveTo(`${dailyCheckDayAfter(day)}T01:00:00+08:00`);
      await w.deliver('daily', { app_id: appId, accounting_date: day }, 'ledger-check');
      expect(
        await db
          .selectFrom('processed_events')
          .select('event_id')
          .where('consumer', '=', 'ledger.daily_check_done')
          .where('event_id', '=', dailyCheckDoneEventId(appId, day))
          .execute(),
        'DAILY_HANDLER_DONE',
      ).toEqual([{ event_id: dailyCheckDoneEventId(appId, day) }]);
      const result = await createDailyCheck({ clock, logger }).runDailyCheck(db, {
        accountingDate: day,
      });
      const files = await directoryInvariantSource().load();
      expect(files.length).toBeGreaterThan(0);
      expect(result.checks.map((row) => row.file).sort()).toEqual(
        files.map((row) => row.name).sort(),
      );
      expect(result.accountDifferences).toEqual([]);
      expect(result.globalDifferences).toEqual([]);
      expect(result.filedDifferences).toEqual([]);
      // BR-FUND-16 借正贷负；BR-FUND-19① 期初 + 当日发生额 = 期末。
      // daily_balances 保留分录符号：0 + 3 × (-500) = -1500 分，
      // 与 account_balances.available_fen 的可提现余额 +1500 分口径不同。
      expect(
        await db
          .selectFrom('daily_balances')
          .select(['opening_fen', 'closing_fen'])
          .where('app_id', '=', appId)
          .where('account_id', '=', userAccount.id)
          .where('sub_account', '=', 'available')
          .where('accounting_date', '=', sql<Date>`${day}::date`)
          .execute(),
      ).toEqual([{ opening_fen: 0n, closing_fen: -1500n }]);
      expect(
        await db.selectFrom('recon_diffs').select('id').where('app_id', '=', appId).execute(),
      ).toEqual([]);
    } finally {
      try {
        await worker?.close();
      } finally {
        try {
          await h?.close();
        } finally {
          inputSpy.mockRestore();
        }
      }
    }
  },
  240_000,
);
