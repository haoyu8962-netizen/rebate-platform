// @vitest-environment jsdom
// F1-08anb REFUSED（BR-WDR-12 ③ 水位检查不满足 → 整批拒绝，不迁移任何单；BR-WDR-18）：整批拒绝显示该原因与
// 通道名的完整文案（通道名为付款通道名：银行卡、微信零钱），任何地方都没有「已发起打款」或成功提示，只发一笔写、
// 不自动重发，勾选仍在，列表里也没有执行结果。约定见 ../helpers.ts 与 ./helpers.ts 开头。
import { act, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  BATCHES,
  EXECUTOR,
  TEXT,
  assertBatch,
  checkbox,
  compact,
  confirm,
  mount,
  ok,
  openBatch,
  row,
  runBatch,
  select,
  serverFor,
  settle,
  settled,
  shows,
  ticked,
  verify,
  writes,
  type BatchResult,
  type Withdrawal,
} from '../helpers.ts';
import {
  ONE_BATCH,
  alertsOf,
  leavesStarting,
  ownDialog,
  resultLines,
  successMarks,
  writeLines,
} from './helpers.ts';

type Channel = NonNullable<BatchResult['channel']>;
type WatermarkReason = 'watermark_stale' | 'watermark_usable_exceeded';

function refusedOn(reason: WatermarkReason, channel: Channel): BatchResult {
  return { outcome: 'rejected', batch_id: null, reason, channel, paying: [], left: [] };
}

/** Lets timers run a while: nothing may be sent again by itself. */
async function idle(): Promise<void> {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 400));
  });
  await settle();
}

async function refusedCase(
  rows: readonly Withdrawal[],
  reason: WatermarkReason,
  channel: Channel,
  text: string,
): Promise<void> {
  const server = serverFor(rows);
  server.once('POST', '/admin/v1/payout-batches', () => ok(refusedOn(reason, channel)));
  await mount(server, EXECUTOR);
  await runBatch(server, rows);
  assertBatch(
    server,
    0,
    rows.map((one) => one.withdrawal_id),
  );
  await waitFor(() => expect(shows(ownDialog(), text), text).toBe(true));
  await settled(server);
  const refusals = alertsOf(ownDialog()).filter((one) => one.startsWith('整批未执行'));
  expect(refusals, 'the refusal in full, once').toEqual([compact(text)]);

  expect(shows(document.body, TEXT.paying), 'nothing reported as paying').toBe(false);
  expect(leavesStarting(ownDialog(), '进入打款'), 'no executed summary').toEqual([]);
  expect(shows(document.body, TEXT.unknown), 'a settled answer, not unknown').toBe(false);
  expect(successMarks(), 'no success notice').toEqual([]);

  await idle();
  await settled(server);
  expect(writes(server), 'not sent again by itself').toHaveLength(1);
  expect(writeLines(server), 'one verification, one batch write, nothing else').toEqual(ONE_BATCH);

  for (const one of rows) {
    expect(checkbox(one).checked, `${one.out_biz_no} still ticked`).toBe(true);
    expect(resultLines(one.out_biz_no), `${one.out_biz_no}: no result in the list`).toEqual([]);
  }
  expect(ticked(), 'exactly the ticked rows').toHaveLength(rows.length);
}

it(
  '[AC-F1-08anb-REFUSED#1] 整批拒绝 reason=watermark_stale、channel=bank_card（两张银行卡待执行单）：显示「整批未执行：银行卡余额 W 未录入或已过期，请录入最新余额后重新提交」全文；没有「已发起打款」或任何成功提示；只发一笔写、不自动重发；勾选仍在',
  { timeout: 90_000 },
  async () => {
    await refusedCase(
      [row(2, 'APPROVED', 9801, 'bank_card'), row(4, 'APPROVED', 7700, 'bank_card')],
      'watermark_stale',
      'bank_card',
      '整批未执行：银行卡余额 W 未录入或已过期，请录入最新余额后重新提交',
    );
  },
);

/** Far longer than any retry interval. */
const LONG_MS = 5 * 60_000;

/**
 * As refusedCase, with vitest's clock installed before the dynamic code is passed (so any timer
 * the refusal could start is a fake one): after the refusal the clock is moved on LONG_MS (in
 * steps, running every timer that falls due), and still exactly one verification and one batch
 * write were sent.
 */
async function refusedOnClock(
  rows: readonly Withdrawal[],
  reason: WatermarkReason,
  channel: Channel,
  text: string,
): Promise<void> {
  const server = serverFor(rows);
  server.once('POST', '/admin/v1/payout-batches', () => ok(refusedOn(reason, channel)));
  await mount(server, EXECUTOR);
  try {
    await select(rows);
    const modal = await openBatch(server);
    await confirm(server, modal);
    expect(writes(server)).toHaveLength(0);
    // shouldAdvanceTime: the fake clock also follows real time, so waitFor keeps polling;
    // requestAnimationFrame stays real for antd's motion.
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(1));
    await settled(server);
    assertBatch(
      server,
      0,
      rows.map((one) => one.withdrawal_id),
    );
    await waitFor(() => expect(shows(ownDialog(), text), text).toBe(true));
    await settled(server);
    expect(writeLines(server), 'refused: one verification, one batch write').toEqual(ONE_BATCH);

    for (let step = 0; step < LONG_MS / 10_000; step += 1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    await settle();
    await settled(server);
    expect(writes(server), `${LONG_MS} ms later: not sent again by itself`).toHaveLength(1);
    expect(writeLines(server), `${LONG_MS} ms later: one verification, one batch write`).toEqual(
      ONE_BATCH,
    );
    expect(server.requests('POST', BATCHES), 'one batch POST').toHaveLength(1);
    expect(shows(document.body, TEXT.paying), 'nothing reported as paying').toBe(false);
    expect(successMarks(), 'no success notice').toEqual([]);
    for (const one of rows)
      expect(checkbox(one).checked, `${one.out_biz_no} still ticked`).toBe(true);
    expect(ticked(), 'exactly the ticked rows').toHaveLength(rows.length);
  } finally {
    vi.useRealTimers();
  }
}

it(
  '[AC-F1-08anb-REFUSED#3] 整批拒绝 watermark_stale / bank_card 之后用 vitest 可控时钟把时间推前 5 分钟（每 10 秒一步、跑完到期的计时器）：写请求仍恰为 [POST step-up, POST payout-batches] 各一次，没有第二笔批量 POST；没有「已发起打款」或成功提示，勾选仍在',
  { timeout: 120_000 },
  async () => {
    await refusedOnClock(
      [row(2, 'APPROVED', 9801, 'bank_card'), row(4, 'APPROVED', 7700, 'bank_card')],
      'watermark_stale',
      'bank_card',
      '整批未执行：银行卡余额 W 未录入或已过期，请录入最新余额后重新提交',
    );
  },
);

it(
  '[AC-F1-08anb-REFUSED#4] 整批拒绝 watermark_usable_exceeded / wechat 之后用 vitest 可控时钟把时间推前 5 分钟：写请求仍恰为 [POST step-up, POST payout-batches] 各一次，没有第二笔批量 POST；没有「已发起打款」或成功提示，勾选仍在',
  { timeout: 120_000 },
  async () => {
    await refusedOnClock(
      [row(1, 'APPROVED', 1234567, 'wechat'), row(3, 'APPROVED', 50000, 'wechat')],
      'watermark_usable_exceeded',
      'wechat',
      '整批未执行：微信零钱在途与本批合计超过可用余额（W × 可用比例），请拆分批次',
    );
  },
);

it(
  '[AC-F1-08anb-REFUSED#2] 整批拒绝 reason=watermark_usable_exceeded、channel=wechat（两张微信待执行单）：显示「整批未执行：微信零钱在途与本批合计超过可用余额（W × 可用比例），请拆分批次」全文；没有「已发起打款」或任何成功提示；只发一笔写、不自动重发；勾选仍在',
  { timeout: 90_000 },
  async () => {
    await refusedCase(
      [row(1, 'APPROVED', 1234567, 'wechat'), row(3, 'APPROVED', 50000, 'wechat')],
      'watermark_usable_exceeded',
      'wechat',
      '整批未执行：微信零钱在途与本批合计超过可用余额（W × 可用比例），请拆分批次',
    );
  },
);
