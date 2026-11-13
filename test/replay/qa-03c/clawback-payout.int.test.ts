import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb, destroyDb } from '@couli/db';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { accountingDate } from '@couli/domain';
import { sql } from 'kysely';
import { expect, it, vi } from 'vitest';
import { createContentReader } from '../../../apps/api/src/modules/content/index.ts';
import { createDailyCheck } from '../../../apps/api/src/modules/ledger/application/daily-check.ts';
import { dailyCheckDoneEventId } from '../../../apps/api/src/modules/ledger/application/daily-check-schedule-done.ts';
import type { JobPayload } from '../../../apps/api/src/modules/platform/index.ts';
import { createTransferJob } from '../../../apps/api/src/modules/payout/jobs/transfer-job.ts';
import { FakeChannel } from '../../../apps/api/src/modules/payout/infra/channels/fake-channel.ts';
import { confirmAdminSettleBill } from '../../../apps/api/src/modules/settlement/application/admin-settle-commands.ts';
import { scanDueBatches } from '../../../apps/api/src/modules/settlement/worker/schedule.ts';
import { DemoUnionAdapter } from '../../../apps/api/src/modules/union/index.ts';
import { checkpoint, startReplay } from '../qa-03a/driver.ts';
import { PAID, RECEIVED, demoStream, streamRows } from '../qa-03a/stream-fixture.ts';
import { logger, startWorker } from '../qa-03b/worker.ts';
import { capturePayout, seedPayee } from './payout-fixture.ts';
import { captureOrderSync } from './sync-fixture.ts';

// BR-FUND-08 / 16: three N=1000, reserve=0, self=5000bp orders yield 1500 available.
// Full invalidation returns 500 user + 500 platform, leaving 1000 available. W1 freezes 1000,
// W5 pays it; another full invalidation then leaves -500 available, withdrawable=0.
// These expectations are hand calculated from the fixture and 08, never derived from outputs.
it('[AC-QA-03c#1] 合成数据回放：结算后失效扣回→日终→申请→自动判定→脚本到账→负余额；重复投递不增账', async () => {
  const provenance = JSON.parse(
    readFileSync(new URL('./provenance.json', import.meta.url), 'utf8'),
  ) as {
    source: string;
    minimum_volume: { clawed_back_orders: number; paid_withdrawals: number };
  };
  expect(provenance.source).toBe('synthetic');
  expect(provenance.minimum_volume).toEqual({ clawed_back_orders: 2, paid_withdrawals: 1 });
  const captured = await capturePayout();
  const capturedSync = await captureOrderSync();
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
  let w: Awaited<ReturnType<typeof startWorker>> | undefined;
  let payoutDb: ReturnType<typeof createDb> | undefined;
  try {
    h = await startReplay({
      createTestDatabase: async () => {
        const database = await createTestDatabase();
        // The payout process really uses couli_payout; no grant bypass on the application pool.
        payoutDb = createDb({ connectionString: database.urlFor('couli_payout'), max: 3 });
        return database;
      },
      acquireTestRedis,
    });
    const { db, appId, userId, clock, time } = h;
    const api = captured.ready();
    const followed = await h.follow();
    const seeds = h.orderSeeds(followed).map((seed, index) => ({
      ...seed,
      refundedAt:
        index === 0
          ? '2026-11-25T11:00:00+08:00'
          : index === 1
            ? '2026-11-27T11:00:00+08:00'
            : null,
    }));
    const sync = await h.syncDriver(seeds);
    const orders = () =>
      db.selectFrom('orders').selectAll().where('app_id', '=', appId).orderBy('order_id').execute();
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
    const withdrawalRows = () =>
      db.selectFrom('withdrawals').selectAll().where('app_id', '=', appId).orderBy('id').execute();
    const attempts = () =>
      db
        .selectFrom('payout_attempts')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('id')
        .execute();

    time.moveTo('2026-10-05T10:10:00+08:00');
    await sync(PAID, '2026-10-05T10:10:00+08:00');
    expect(await orders()).toHaveLength(3);
    await checkpoint(db, clock, appId);
    time.moveTo('2026-10-08T20:10:00+08:00');
    await sync(RECEIVED, '2026-10-08T20:10:00+08:00');
    for (const order of await orders())
      expect(order).toMatchObject({
        platform_status: 'RECEIVED',
        rebate_status: 'WAITING',
        settle_period: '2026-10',
      });
    await checkpoint(db, clock, appId);
    for (const key of ['settle.auto.enabled', 'credit.enabled.pdd']) {
      await db
        .insertInto('config_items')
        .values({ app_id: appId, key, value: true, updated_by: 'synthetic-replay' })
        .execute();
    }
    w = await startWorker(h);
    const worker = w;
    const refundSync = capturedSync.driver(h, seeds, api.eventBus);
    const inputs = await streamRows(
      demoStream(clock, seeds),
      {
        from: RECEIVED,
        to: '2026-10-08T20:10:00+08:00',
      },
      appId,
    );
    expect(inputs).toHaveLength(3);
    time.moveTo('2026-11-20T12:00:00+08:00');
    for (const input of inputs) {
      expect(
        await worker.pipeline.process(
          {
            ...input,
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
        ),
      ).toMatchObject({ kind: 'updated' });
    }
    time.moveTo('2026-11-24T10:00:00+08:00');
    await worker.deliver('bill', {
      app_id: appId,
      platform: 'pdd',
      accounting_date: accountingDate(clock.now()),
    });
    const bills = await db
      .selectFrom('settle_bills')
      .selectAll()
      .where('app_id', '=', appId)
      .execute();
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({
      beneficiary_total_fen: 1500n,
      platform_retained_fen: 1500n,
      error_count: 0,
    });
    await checkpoint(db, clock, appId);
    const batches = await db
      .selectFrom('settle_batches')
      .selectAll()
      .where('app_id', '=', appId)
      .execute();
    const items = await db
      .selectFrom('settle_batch_items')
      .selectAll()
      .where('app_id', '=', appId)
      .execute();
    expect(batches).toHaveLength(1);
    expect(items).toHaveLength(3);
    for (const item of items)
      expect(item).toMatchObject({ settle_seq: 1, b_settle_fen: 1000n, result: null });
    expect((await money()).vouchers).toEqual([]);
    await checkpoint(db, clock, appId);
    const adminId = randomUUID();
    await db
      .insertInto('admin_users')
      .values({
        id: adminId,
        app_id: appId,
        login_name: `qa03c-${adminId}`,
        password_hash: 'unused-synthetic-login',
        is_super: false,
        status: 'active',
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
    expect(
      await confirmAdminSettleBill(
        worker.commands,
        { appId, adminId, ip: '127.0.0.1' },
        '2026-10',
        {
          expected_batches: batches.map((batch) => ({
            batch_id: batch.batch_id,
            expected_row_version: batch.row_version,
          })),
          settle_mode: 'IMMEDIATE',
        },
        randomUUID(),
      ),
    ).toMatchObject({ status: 200 });
    await checkpoint(db, clock, appId);
    worker.queue.send.mockClear();
    await scanDueBatches({ db, clock, queue: worker.queue, logger });
    const credits = worker.queue.send.mock.calls.filter(
      ([queue, name]) => queue === 'settle' && name === 'batch_execute',
    );
    expect(credits).toHaveLength(1);
    for (const [, name, payload] of credits) await worker.deliver(name, payload);
    for (const order of await orders())
      expect(order, 'CREDITED_PRECONDITION').toMatchObject({
        platform_status: 'SETTLED',
        rebate_status: 'CREDITED',
        booked_base_fen: 1000n,
        booked_n_fen: 1000n,
      });
    const account = await db
      .selectFrom('ledger_accounts')
      .select('id')
      .where('app_id', '=', appId)
      .where('owner_id', '=', userId)
      .where('subject', '=', 'USER_BALANCE')
      .executeTakeFirstOrThrow();
    const balance = () =>
      db
        .selectFrom('account_balances')
        .selectAll()
        .where('app_id', '=', appId)
        .where('account_id', '=', account.id)
        .executeTakeFirstOrThrow();
    expect(await balance()).toMatchObject({ available_fen: 1500n, frozen_fen: 0n });
    await checkpoint(db, clock, appId);

    async function invalidate(from: string, to: string, expectedAvailable: bigint, count: number) {
      time.moveTo(to);
      await refundSync(from, to);
      const current = await orders();
      const clawed = current.filter((order) => order.rebate_status === 'CLAWED_BACK');
      expect(clawed, 'CLAWBACK_VOLUME').toHaveLength(count);
      expect(
        await db
          .selectFrom('order_status_history')
          .select(['event', 'from_status', 'to_status'])
          .where('app_id', '=', appId)
          .where('field', '=', 'rebate')
          .where('to_status', '=', 'CLAWED_BACK')
          .execute(),
        'CLAWBACK_AFTER_SETTLE',
      ).toEqual(
        Array.from({ length: count }, () => ({
          event: 'INVALID_AFTER_SETTLE',
          from_status: 'CREDITED',
          to_status: 'CLAWED_BACK',
        })),
      );
      for (const order of clawed)
        expect(order, 'CLAWBACK_STATE').toMatchObject({
          platform_status: 'SETTLED',
          reason: 'REFUND',
          booked_base_fen: 0n,
          booked_n_fen: 0n,
        });
      expect(await balance(), 'CLAWBACK_AVAILABLE').toMatchObject({
        available_fen: expectedAvailable,
        frozen_fen: 0n,
      });
      const posted = await money();
      const vouchers = posted.vouchers.filter((v) => v.voucher_kind === 'CLAWBACK');
      expect(vouchers, 'CLAWBACK_VOUCHERS').toHaveLength(count * 2);
      const writtenToday = await db
        .selectFrom('ledger_vouchers')
        .select(['id', sql<string>`to_char(accounting_date, 'YYYY-MM-DD')`.as('day')])
        .where('app_id', '=', appId)
        .where('voucher_kind', '=', 'CLAWBACK')
        .where('accounting_date', '=', sql<Date>`${accountingDate(clock.now())}::date`)
        .execute();
      expect(
        writtenToday.map(({ day }) => ({ day })),
        'CLAWBACK_CLOCK',
      ).toEqual([{ day: accountingDate(clock.now()) }, { day: accountingDate(clock.now()) }]);
      const todayIds = new Set(writtenToday.map(({ id }) => id));
      const todayEntries = posted.entries.filter((entry) => todayIds.has(entry.voucher_id));
      expect(todayEntries).toHaveLength(4);
      for (const entry of todayEntries)
        expect(entry.booked_at, 'CLAWBACK_ENTRY_CLOCK').toEqual(clock.now());
      const accounts = await db
        .selectFrom('ledger_accounts')
        .selectAll()
        .where('app_id', '=', appId)
        .execute();
      for (const voucher of vouchers) {
        expect(voucher.uniq_key, 'CLAWBACK_KEY').toMatch(/:CLAWBACK:P\d+$/);
        const entries = posted.entries.filter((entry) => entry.voucher_id === voucher.id);
        expect(entries, 'CLAWBACK_DOUBLE_ENTRY').toHaveLength(2);
        const amounts = entries
          .map((entry) => ({
            subject: accounts.find((a) => a.id === entry.account_id)!.subject,
            amount_fen: entry.amount_fen,
            ledger_type: entry.ledger_type,
            sub_type: entry.sub_type,
            sub_account: entry.sub_account,
          }))
          .sort((a, b) => a.subject.localeCompare(b.subject));
        // Borrower-positive accounting: a +500 debit reduces the user's available by 500.
        const own = voucher.beneficiary_user_id === userId;
        expect(amounts, 'CLAWBACK_SIGNS').toEqual([
          {
            subject: own ? 'UNION_RECEIVABLE:pdd' : 'COMMISSION_REVENUE',
            amount_fen: own ? -500n : 500n,
            ledger_type: 'CLAWBACK',
            sub_type: 'FULL',
            sub_account: 'available',
          },
          {
            subject: own ? 'USER_BALANCE' : 'UNION_RECEIVABLE:pdd',
            amount_fen: own ? 500n : -500n,
            ledger_type: 'CLAWBACK',
            sub_type: 'FULL',
            sub_account: 'available',
          },
        ]);
      }
      await checkpoint(db, clock, appId);
      await refundSync(from, to);
      expect(await money(), 'CLAWBACK_REDELIVERY_MONEY').toEqual(posted);
      expect(await orders(), 'CLAWBACK_REDELIVERY_ORDER').toEqual(current);
      await checkpoint(db, clock, appId);
    }
    await invalidate('2026-11-25T11:00:00+08:00', '2026-11-25T11:10:00+08:00', 1000n, 1);

    async function daily(day: string, next: string, opening: bigint, closing: bigint) {
      time.moveTo(next);
      await worker.deliver('daily', { app_id: appId, accounting_date: day }, 'ledger-check');
      expect(
        await db
          .selectFrom('processed_events')
          .select('event_id')
          .where('consumer', '=', 'ledger.daily_check_done')
          .where('event_id', '=', dailyCheckDoneEventId(appId, day))
          .execute(),
        'DAILY_COMPLETED',
      ).toEqual([{ event_id: dailyCheckDoneEventId(appId, day) }]);
      const check = await createDailyCheck({ clock, logger }).runDailyCheck(db, {
        accountingDate: day,
      });
      expect(check.accountDifferences, 'DAILY_ACCOUNTS').toEqual([]);
      expect(check.globalDifferences, 'DAILY_GLOBAL').toEqual([]);
      expect(check.filedDifferences, 'DAILY_FILED').toEqual([]);
      expect(
        await db
          .selectFrom('daily_balances')
          .select(['opening_fen', 'closing_fen'])
          .where('app_id', '=', appId)
          .where('account_id', '=', account.id)
          .where('sub_account', '=', 'available')
          .where('accounting_date', '=', sql<Date>`${day}::date`)
          .execute(),
        'DAILY_SIGNED_BALANCE',
      ).toEqual([{ opening_fen: opening, closing_fen: closing }]);
    }
    await daily('2026-11-25', '2026-11-26T01:00:00+08:00', -1500n, -1000n);
    time.moveTo('2026-11-26T10:00:00+08:00');
    const actor = await seedPayee(h, api.crypto);
    await db
      .insertInto('payout_watermarks')
      .values({
        id: randomUUID(),
        app_id: appId,
        channel: 'alipay',
        available_fen: 100000n,
        measured_at: clock.now(),
        entered_by: 'synthetic-replay',
      })
      .execute();
    // HTTP signatures / consumed step-up / Idempotency-Key remain covered by AC-B2-05d#50–57.
    // The real application service still validates realname, consent, payee, risk and balances.
    const accepted = await db.transaction().execute((trx) =>
      api.apply.apply(trx, {
        ...actor,
        amountFen: 1000n,
        stepUpValid: true,
      }),
    );
    expect(accepted, 'APPLY_ACCEPTED').toMatchObject({
      code: 0,
      data: {
        status: 'PENDING_REVIEW',
        amount_fen: 1000,
        fee_fen: 0,
        tax_fen: 0,
        net_fen: 1000,
      },
    });
    const submitted = await withdrawalRows();
    expect(submitted, 'APPLY_VOLUME').toHaveLength(1);
    const withdrawal = submitted[0]!;
    expect(withdrawal).toMatchObject({
      app_id: appId,
      user_id: userId,
      status: 'PENDING_REVIEW',
      review_mode: null,
      auto_decision: null,
      created_at: clock.now(),
    });
    expect(await balance(), 'APPLY_FREEZE').toMatchObject({ available_fen: 0n, frozen_fen: 1000n });
    const freeze = await db
      .selectFrom('ledger_vouchers')
      .select('id')
      .where('app_id', '=', appId)
      .where('uniq_key', '=', `wd:${withdrawal.id}:FREEZE`)
      .execute();
    expect(freeze, 'APPLY_FREEZE_UNIQUE').toHaveLength(1);
    expect(
      (await money()).entries
        .filter((e) => e.voucher_id === freeze[0]!.id)
        .map((e) => ({ amount_fen: e.amount_fen, sub_account: e.sub_account }))
        .sort((a, b) => a.sub_account.localeCompare(b.sub_account)),
      'APPLY_FREEZE_ENTRIES',
    ).toEqual([
      { amount_fen: 1000n, sub_account: 'available' },
      { amount_fen: -1000n, sub_account: 'frozen' },
    ]);
    await checkpoint(db, clock, appId);
    const created = await db
      .selectFrom('event_log')
      .selectAll()
      .where('app_id', '=', appId)
      .where('name', '=', 'withdrawal.created')
      .execute();
    expect(created).toHaveLength(1);
    const envelope = {
      ...(created[0]!.payload as { v: number; data: JobPayload }),
      app_id: appId,
      occurred_at: created[0]!.occurred_at.toISOString(),
    };
    worker.queue.send.mockClear();
    await worker.deliver('withdrawal.created', envelope, 'evt.payout-auto-payout');
    expect((await withdrawalRows())[0], 'AUTO_EXECUTED').toMatchObject({
      status: 'PAYING',
      review_mode: 'auto',
      execute_seq: 1,
      auto_decision: {
        result: 'auto',
        failed_conditions: [],
        rule_version: expect.any(Number),
        decided_at: clock.now().toISOString(),
        warn_values: { invalid_ratio_bp: 3334 },
      },
    });
    expect(
      await db
        .selectFrom('payout_batches')
        .select(['kind', 'created_by'])
        .where('app_id', '=', appId)
        .execute(),
      'AUTO_BATCH',
    ).toEqual([{ kind: 'auto', created_by: null }]);
    const transfers = worker.queue.send.mock.calls.filter(
      ([queue, name]) => queue === 'payout' && name === 'transfer',
    );
    expect(transfers, 'TRANSFER_QUEUED').toHaveLength(1);
    await checkpoint(db, clock, appId);

    time.moveTo('2026-11-26T10:01:00+08:00');
    const paidAt = clock.now();
    const channel = new FakeChannel({
      mode: 'dry_run',
      lists: {
        definiteFailCodes: ['SYNTHETIC_FAIL'],
        payerSideCodes: ['SYNTHETIC_PAYER'],
        queryStatusMap: { SUCCESS: 'success' },
      },
      script: {
        [withdrawal.out_biz_no]: {
          transfer: [
            {
              kind: 'response',
              raw: { code: '10000' },
              status: 'SUCCESS',
              channelOrderId: 'synthetic-qa03c-paid',
              paidAt: paidAt.toISOString(),
            },
          ],
        },
      },
    });
    expect(payoutDb).toBeDefined();
    const transfer = createTransferJob({
      db: payoutDb!,
      attemptsDb: payoutDb!,
      clock,
      config: {
        configValue: (app, key, handle) =>
          createContentReader({ db: handle, clock }).configValue(app, key),
      },
      queue: worker.queue,
      eventBus: api.eventBus,
      channels: { alipay: channel },
      logger,
      decryptPayee: (cipher) => api.crypto.decrypt(cipher.toString(), 'payout_accounts.alipay'),
    });
    const transferJob = {
      id: randomUUID(),
      queue: 'payout',
      name: 'transfer',
      payload: transfers[0]![2],
      attempt: 1,
    };
    worker.queue.send.mockClear();
    await transfer(transferJob);
    expect(channel.calls, 'NO_TRANSFER_BEFORE_REVIEW').toEqual([]);
    const reviews = worker.queue.send.mock.calls.filter(
      ([queue, name]) => queue === 'payout-review' && name === 'review',
    );
    expect(reviews).toHaveLength(1);
    await worker.deliver('review', reviews[0]![2], 'payout-review');
    const releases = worker.queue.send.mock.calls.filter(
      ([queue, name]) => queue === 'payout' && name === 'release',
    );
    expect(releases).toHaveLength(1);
    await transfer({ ...transferJob, name: 'release', payload: releases[0]![2] });
    expect(channel.calls, 'TRANSFER_ONCE').toHaveLength(1);
    expect(channel.calls[0], 'TRANSFER_REQUEST').toMatchObject({
      kind: 'transfer',
      request: {
        outBizNo: withdrawal.out_biz_no,
        netFen: 1000n,
      },
    });
    expect(await attempts(), 'SUCCESS_ATTEMPT').toMatchObject([
      { kind: 'transfer', result: 'success' },
    ]);
    expect((await withdrawalRows())[0], 'LANDING_REQUIRED').toMatchObject({
      status: 'PAYING',
      paid_at: null,
    });
    const awaitingLanding = await money();
    const attemptsBeforeRedelivery = await attempts();
    await transfer(transferJob);
    await transfer({ ...transferJob, name: 'release', payload: releases[0]![2] });
    expect(channel.calls, 'PAYING_NO_RESEND').toHaveLength(1);
    expect(await attempts(), 'PAYING_NO_NEW_ATTEMPT').toEqual(attemptsBeforeRedelivery);
    expect(await money(), 'PAYING_REDELIVERY_MONEY').toEqual(awaitingLanding);
    const landings = worker.queue.send.mock.calls.filter(
      ([queue, name]) => queue === 'payout-landing' && name === 'land',
    );
    expect(landings).toHaveLength(1);
    time.moveTo('2026-11-26T10:02:00+08:00');
    await worker.deliver('land', landings[0]![2], 'payout-landing');
    expect((await withdrawalRows())[0], 'PAID_API').toMatchObject({
      status: 'PAID_API',
      channel_order_id: 'synthetic-qa03c-paid',
      paid_at: paidAt,
      out_biz_no: withdrawal.out_biz_no,
      needs_manual: false,
      fail_code: null,
    });
    expect(await balance(), 'PAID_RELEASES_FROZEN').toMatchObject({
      available_fen: 0n,
      frozen_fen: 0n,
    });
    expect(
      await db
        .selectFrom('ledger_vouchers')
        .select('uniq_key')
        .where('app_id', '=', appId)
        .where('uniq_key', 'like', `wd:${withdrawal.id}:%`)
        .orderBy('uniq_key')
        .execute(),
      'PAID_UNIQUE',
    ).toEqual([
      { uniq_key: `wd:${withdrawal.id}:FREEZE` },
      { uniq_key: `wd:${withdrawal.id}:PAID` },
    ]);
    const paidEntries = await db
      .selectFrom('ledger_entries as e')
      .innerJoin('ledger_vouchers as v', (join) =>
        join.onRef('v.id', '=', 'e.voucher_id').onRef('v.app_id', '=', 'e.app_id'),
      )
      .innerJoin('ledger_accounts as a', (join) =>
        join.onRef('a.id', '=', 'e.account_id').onRef('a.app_id', '=', 'e.app_id'),
      )
      .select(['a.subject', 'e.sub_account', 'e.amount_fen', 'e.ledger_type'])
      .where('v.app_id', '=', appId)
      .where('v.uniq_key', '=', `wd:${withdrawal.id}:PAID`)
      .orderBy('a.subject')
      .execute();
    expect(paidEntries, 'PAID_DOUBLE_ENTRY').toEqual([
      {
        subject: 'CASH_ALIPAY',
        sub_account: 'available',
        amount_fen: -1000n,
        ledger_type: 'WITHDRAW_PAID',
      },
      {
        subject: 'USER_BALANCE',
        sub_account: 'frozen',
        amount_fen: 1000n,
        ledger_type: 'WITHDRAW_PAID',
      },
    ]);
    await checkpoint(db, clock, appId);
    const paidMoney = await money();
    const paidRows = await withdrawalRows();
    const paidAttempts = await attempts();
    await transfer(transferJob);
    await transfer({ ...transferJob, name: 'release', payload: releases[0]![2] });
    await worker.deliver('land', landings[0]![2], 'payout-landing');
    expect(channel.calls, 'NO_RESEND').toHaveLength(1);
    expect(await attempts(), 'ATTEMPT_REDELIVERY').toEqual(paidAttempts);
    expect(await withdrawalRows(), 'PAID_REDELIVERY').toEqual(paidRows);
    expect(await money(), 'PAID_REDELIVERY_MONEY').toEqual(paidMoney);
    await checkpoint(db, clock, appId);
    await daily('2026-11-26', '2026-11-27T01:00:00+08:00', -1000n, 0n);

    await invalidate('2026-11-27T11:00:00+08:00', '2026-11-27T11:10:00+08:00', -500n, 2);
    expect(await api.rules.getRules(db, actor), 'NEGATIVE_WITHDRAWABLE').toMatchObject({
      withdrawable_fen: 0,
      max_withdrawable_fen: 0,
    });
    const beforeRefusal = await money();
    expect(
      await db.transaction().execute((trx) =>
        api.apply.apply(trx, {
          ...actor,
          amountFen: 100n,
          stepUpValid: true,
        }),
      ),
      'NEGATIVE_REFUSED',
    ).toMatchObject({ code: 30302 });
    expect(await withdrawalRows(), 'REFUSAL_NO_ORDER').toEqual(paidRows);
    expect(await money(), 'REFUSAL_NO_MONEY').toEqual(beforeRefusal);
    expect(
      (await orders()).filter((order) => order.rebate_status === 'CLAWED_BACK').length,
    ).toBeGreaterThanOrEqual(provenance.minimum_volume.clawed_back_orders);
    expect(
      (await withdrawalRows()).filter((row) => row.status === 'PAID_API').length,
    ).toBeGreaterThanOrEqual(provenance.minimum_volume.paid_withdrawals);
    await checkpoint(db, clock, appId);
    await daily('2026-11-27', '2026-11-28T01:00:00+08:00', 0n, 500n);
    expect(
      await db.selectFrom('recon_diffs').select('id').where('app_id', '=', appId).execute(),
    ).toEqual([]);
  } finally {
    try {
      await w?.close();
    } finally {
      try {
        if (payoutDb !== undefined) await destroyDb(payoutDb);
      } finally {
        try {
          await h?.close();
        } finally {
          inputSpy.mockRestore();
          capturedSync.restore();
          captured.restore();
        }
      }
    }
  }
}, 240_000);
