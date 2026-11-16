// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { PHONE, USER } from '../admin-withdrawals/fixtures.ts';
import { SUB_TAB, listed, selectTab } from '../admin-payouts-readonly/helpers.ts';
import {
  CHECK,
  CNO,
  ENTRY,
  EXECUTOR,
  PAYING_TEXT,
  PREVIEW_HEADERS,
  QID,
  QNO,
  SUBMIT,
  allRows,
  dailyLeft,
  executeSamples,
  executed,
  netSum,
  overview,
  selectedText,
  yuan,
  type Withdrawal,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  answerWith,
  assertPost,
  assertResults,
  button,
  checkItems,
  checkbox,
  confirm,
  disabled,
  liveTexts,
  open,
  openQueue,
  posts,
  select,
  serverFor,
  settled,
  squash,
  ticked,
  verify,
} from './helpers.ts';

// F1-08bb ① with BR-WDR-11 / BR-WDR-12 and adminCreatePayoutBatch ("an APPROVED withdrawal already
// on another batch is moved to the new one first by a CAS and the old batch keeps its item as
// moved_out"): an APPROVED withdrawal can be ticked whatever batch it is on and whatever W9 wrote.
// H was executed once (execute_seq 1) on an old manual batch and returned to APPROVED by the payout
// process with hold_reason daily_cap (executor_id and executed_at cleared, batch_id kept); U was
// decided auto, and its own auto batch left it APPROVED with channel_disabled (the channel is open
// again). Both are 待执行: each has a usable checkbox, enters the execution list and the request.

/** The old manual batch H was executed on. */
const OLD_MANUAL = 'b200000a-0000-4000-8000-00000000000a';
/** The auto batch that left U behind. */
const OLD_AUTO = 'b200000b-0000-4000-8000-00000000000b';
const HID = 'e200000a-0000-4000-8000-00000000000a';
const HNO = 'W20261110000210';
const UID = 'e200000b-0000-4000-8000-00000000000b';
const UNO = 'W20261110000211';

/** executeSamples() with H and U (applied 2026-11-10, after every other queue row). */
function rebatchSamples(): Withdrawal[] {
  const rows = executeSamples();
  const a = rows.find((row) => row.withdrawal_id === QID.approvedA)!;
  const held: Withdrawal = {
    ...structuredClone(a),
    withdrawal_id: HID,
    out_biz_no: HNO,
    user: { user_id: USER.c, phone_masked: PHONE.c },
    amount_fen: 20000,
    fee_fen: 0,
    tax_fen: 0,
    net_fen: 20000,
    hold_reason: 'daily_cap',
    hold_at: '2026-11-10T10:31:00+08:00',
    executor_id: null,
    executed_at: null,
    execute_seq: 1,
    batch_id: OLD_MANUAL,
    batch: { batch_id: OLD_MANUAL, kind: 'manual', created_at: '2026-11-10T10:30:00+08:00' },
    batch_items: [
      {
        batch_id: OLD_MANUAL,
        result: 'paying',
        reason: null,
        moved_to_batch_id: null,
        at: '2026-11-10T10:30:01+08:00',
      },
    ],
    payout_attempts: [],
    reviewed_at: '2026-11-10T10:20:00+08:00',
    created_at: '2026-11-10T10:00:00+08:00',
    updated_at: '2026-11-10T10:31:00+08:00',
  };
  const left: Withdrawal = {
    ...structuredClone(a),
    withdrawal_id: UID,
    out_biz_no: UNO,
    review_mode: 'auto',
    reviewer_id: null,
    amount_fen: 28000,
    fee_fen: 0,
    tax_fen: 0,
    net_fen: 28000,
    auto_decision: {
      result: 'auto',
      failed_conditions: [],
      warn_values: {
        high_commission_order_ratio_bp: 0,
        invalid_ratio_bp: 0,
        withdraw_received_ratio_bp: 0,
      },
      rule_version: 3,
      decided_at: '2026-11-10T09:00:01+08:00',
      execute_blocked: 'channel_disabled',
    },
    batch_id: OLD_AUTO,
    batch: { batch_id: OLD_AUTO, kind: 'auto', created_at: '2026-11-10T09:00:01+08:00' },
    batch_items: [
      {
        batch_id: OLD_AUTO,
        result: 'skipped',
        reason: 'channel_disabled',
        moved_to_batch_id: null,
        at: '2026-11-10T09:00:02+08:00',
      },
    ],
    payout_attempts: [],
    reviewed_at: '2026-11-10T09:00:01+08:00',
    created_at: '2026-11-10T09:00:00+08:00',
    updated_at: '2026-11-10T09:00:02+08:00',
  };
  return [...rows, held, left];
}

const sample = rebatchSamples();
const rowOf = (id: string): Withdrawal => sample.find((row) => row.withdrawal_id === id)!;
const A = rowOf(QID.approvedA);
const H = rowOf(HID);
const U = rowOf(UID);
const ROWS = [...allRows(), HNO, UNO];

/** The preview rows of `modal` for `items`: whole cells, list order. */
function assertPreview(modal: HTMLElement, items: readonly Withdrawal[]): void {
  const headers = within(modal)
    .queryAllByRole('columnheader')
    .map((node) => squash(node.textContent));
  expect(headers, 'execution list headers').toEqual([...PREVIEW_HEADERS]);
  const found = items.map((item) => {
    const rows = within(modal)
      .queryAllByRole('row')
      .filter((row) => within(row).queryAllByText(item.out_biz_no, { exact: true }).length === 1);
    expect(rows, `one preview row ${item.out_biz_no}`).toHaveLength(1);
    const row = rows[0]!;
    const cells = within(row).queryAllByRole('cell');
    expect(cells).toHaveLength(3);
    expect(cells[0]!.textContent).toBe(item.out_biz_no);
    expect(within(cells[1]!).queryAllByText(item.user.user_id, { exact: true })).toHaveLength(1);
    expect(within(cells[1]!).queryAllByText(item.user.phone_masked!, { exact: true })).toHaveLength(
      1,
    );
    expect(cells[2]!.textContent).toBe(yuan(item.net_fen));
    return row;
  });
  const bodyRows = within(modal)
    .queryAllByRole('row')
    .filter((row) => within(row).queryAllByRole('cell').length > 0);
  expect(bodyRows, 'only the ticked rows').toHaveLength(items.length);
  for (let index = 1; index < found.length; index += 1)
    expect(
      found[index - 1]!.compareDocumentPosition(found[index]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      'list order',
    ).not.toBe(0);
}

it(
  '[AC-F1-08bb-SELECT#2] 已挂在别的批次上的待执行单也能勾：经 W9 退回（hold_reason=daily_cap、execute_seq=1、batch_id 指向旧人工批次）的 H 与自动批次因通道未开通留下的 U 在「全部」「待执行」都有一个可用、未勾的勾选框；倒序勾 U、H、A 后批量栏精确统计三张，执行确认清单按列表顺序列 A、H、U 与执行前检查全文；确认 → 动态码 → 一次 POST，请求体为 [A, H, U]；executed 后三单都显示已发起打款',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor({ withdrawals: rebatchSamples() });
    answerWith(server, executed([QID.approvedA, HID, UID], []));
    const panel = await openQueue(server, EXECUTOR, ROWS);
    for (const number of [HNO, UNO])
      expect(checkbox(panel, number).checked, `${number} tickable, not ticked`).toBe(false);

    await selectTab(panel, SUB_TAB.approved);
    await listed(panel, [QNO.approvedA, CNO, QNO.approvedB, HNO, UNO]);
    await settled(server);
    for (const number of [HNO, UNO])
      expect(checkbox(panel, number).checked, `${number} tickable in 待执行`).toBe(false);
    await selectTab(panel, SUB_TAB.all);
    await listed(panel, ROWS);
    await settled(server);

    await select(panel, [UNO, HNO, QNO.approvedA]);
    expect(liveTexts(panel)).toEqual([selectedText(3, netSum([A, H, U]))]);
    expect(disabled(button(panel, ENTRY))).toBe(false);
    const modal = await open(server, panel);
    assertPreview(modal, [A, H, U]);
    expect(checkItems(modal)).toEqual(
      [
        CHECK.payoutOn,
        CHECK.queueRunning,
        CHECK.fresh('alipay', yuan(3000000), '2026-11-14 09:00:00'),
        CHECK.level('alipay', yuan(3000000), yuan(2100000), '水位低', true),
        CHECK.daily(dailyLeft(overview()), netSum([A, H, U]), true),
      ].map(squash),
    );
    expect(disabled(button(modal, SUBMIT))).toBe(false);
    await confirm(server, modal);
    await verify();
    await waitFor(() => expect(posts(server)).toHaveLength(1));
    await settled(server);
    assertPost(server, [QID.approvedA, HID, UID], 1, 1);
    await assertResults([QNO.approvedA, HNO, UNO], [PAYING_TEXT, PAYING_TEXT, PAYING_TEXT]);
    expect(ticked(panel), 'ticks cleared').toEqual([]);
  },
);
