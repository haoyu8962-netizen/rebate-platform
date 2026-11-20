// @vitest-environment jsdom
// F1-08anb REFUSED（BR-WDR-12 ③ 水位检查不满足 → 整批拒绝，不迁移任何单；BR-WDR-18）：整批拒绝显示该原因与
// 通道名的完整文案（通道名为付款通道名：银行卡、微信零钱），任何地方都没有「已发起打款」或成功提示，只发一笔写、
// 不自动重发，勾选仍在，列表里也没有执行结果。约定见 ../helpers.ts 与 ./helpers.ts 开头。
import { act, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  EXECUTOR,
  TEXT,
  assertBatch,
  checkbox,
  compact,
  mount,
  ok,
  row,
  runBatch,
  serverFor,
  settle,
  settled,
  shows,
  ticked,
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
