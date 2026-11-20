// @vitest-environment jsdom
// F1-08an：【批量自动打款】的确认、动态码与逐单结果（BR-WDR-12 EXECUTE；契约 adminCreatePayoutBatch：
// body 只有 withdrawal_ids，1–200 张、按列表顺序；totp 档 step-up；Idempotency-Key 必填）。确认对话框按列表
// 顺序列将处理的单（实付金额）、跳过的单（勾选中的待审核单「未审核」，不在本操作中审核、不进请求体）与
// 「执行前检查」；部分成功如实显示，不报全成。约定见 ./helpers.ts 开头。
import { addFen, formatYuanAdmin, parseFen, subFen } from '@couli/money';
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  EXECUTOR,
  LEFT_TEXT,
  NAME,
  STATUS_SHOWN,
  SUPER,
  TEXT,
  approvedRows,
  assertBatch,
  button,
  buttons,
  check,
  click,
  confirm,
  dialogs,
  disabled,
  executedReply,
  isCountRead,
  isTableRead,
  listOf,
  main,
  mixedRows,
  mount,
  numbersIn,
  openBatch,
  resultNotShown,
  resultShown,
  rowOf,
  select,
  serverFor,
  settled,
  shows,
  stepDialogs,
  ticked,
  verify,
  writes,
  yuan,
  type Withdrawal,
} from './helpers.ts';
import { overview } from '../admin-payouts-readonly/fixtures.ts';

function netSum(rows: readonly Withdrawal[]): string {
  let total = parseFen(0);
  for (const one of rows) total = addFen(total, parseFen(one.net_fen));
  return formatYuanAdmin(total);
}

it(
  '[AC-F1-08an-SUBMIT#1] 持 payout.execute 倒序勾三张待执行单：【批量自动打款】先出确认对话框，按列表顺序列三张单与各自实付金额，并有「执行前检查」（打款开关、队列运行状态、单日限额余量取打款概览），【取消】不发任何请求；再打开【确认执行】→ 动态码（双击也只验一次）→ 只发一次 POST /admin/v1/payout-batches，body 恰为按列表顺序的三个 withdrawal_ids，带 X-Step-Up-Token 与 Idempotency-Key',
  { timeout: 90_000 },
  async () => {
    const rows = approvedRows();
    const numbers = rows.map((one) => one.out_biz_no);
    const server = serverFor(rows);
    server.once('POST', '/admin/v1/payout-batches', () =>
      executedReply(
        server,
        rows.map((one) => one.withdrawal_id),
      ),
    );
    await mount(server, EXECUTOR);
    await select([...rows].reverse());

    let modal = await openBatch(server);
    expect(numbersIn(modal, numbers), 'the batch in list order').toEqual(numbers);
    for (const one of rows)
      expect(shows(rowOf(modal, one.out_biz_no), yuan(one.net_fen)), one.out_biz_no).toBe(true);
    expect(shows(modal, TEXT.checkTitle), '执行前检查').toBe(true);
    const view = overview();
    const left = formatYuanAdmin(
      subFen(parseFen(view.daily_cap_fen), parseFen(view.daily_sent_fen)),
    );
    for (const item of [
      check('打款开关', '已开启', true),
      check('队列运行状态', '运行中', true),
      check('单日限额余量', `${left}，本次合计 ${netSum(rows)}`, true),
    ])
      expect(shows(modal, item), item).toBe(true);
    expect(controlsAreButtons(modal), 'no input of any kind in the confirmation').toEqual([]);

    await click(button(modal, NAME.cancel));
    await waitFor(() => expect(dialogs()).toEqual([]));
    await settled(server);
    expect(writes(server)).toEqual([]);
    expect(server.requests('POST', '/admin/v1/auth/step-up')).toEqual([]);

    modal = await openBatch(server);
    await confirm(server, modal, true);
    await verify(true);
    await waitFor(() => expect(writes(server)).toHaveLength(1));
    await settled(server);
    expect(server.requests('POST', '/admin/v1/auth/step-up')).toHaveLength(1);
    assertBatch(
      server,
      0,
      rows.map((one) => one.withdrawal_id),
    );
    expect(writes(server)).toHaveLength(1);
  },
);

/** Controls of `root` that are not buttons (no field could take the amount due or "now"). */
function controlsAreButtons(root: HTMLElement): string[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="spinbutton"], [role="combobox"], [role="slider"]',
    ),
  )
    .filter((node) => !(node instanceof HTMLInputElement && node.type === 'hidden'))
    .map((node) => `${node.localName}.${node.getAttribute('class') ?? ''}`);
}

it(
  '[AC-F1-08an-SUBMIT#2] 部分成功如实显示：三张里两张进入打款（「已发起打款」）、一张留在待执行（会员有提现阻断的全文），留下的那张不显示「已发起打款」，不报三张都已发起；之后重新读列表与各页签计数、清空勾选，进入打款的单在列表里为打款中、留下的仍为已通过待打款；只发一次写',
  { timeout: 90_000 },
  async () => {
    const rows = approvedRows();
    const [a, b, c] = rows as [Withdrawal, Withdrawal, Withdrawal];
    const server = serverFor(rows);
    server.once('POST', '/admin/v1/payout-batches', () =>
      executedReply(
        server,
        [a.withdrawal_id, c.withdrawal_id],
        [{ withdrawal_id: b.withdrawal_id, reason: 'member_blocked' }],
      ),
    );
    await mount(server, EXECUTOR);
    await select(rows);
    const modal = await openBatch(server);
    await confirm(server, modal);
    const at = server.log.length;
    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(1));
    await settled(server);

    await resultShown(a.out_biz_no, TEXT.paying);
    await resultShown(c.out_biz_no, TEXT.paying);
    await resultShown(b.out_biz_no, LEFT_TEXT.member_blocked);
    resultNotShown(b.out_biz_no, TEXT.paying);
    expect(shows(document.body, '进入打款 3 张'), 'not reported as all paying').toBe(false);

    await waitFor(() =>
      expect(server.log.slice(at).some(isTableRead), 'the list read again').toBe(true),
    );
    await waitFor(() =>
      expect(server.log.slice(at).some(isCountRead), 'the tab counts read again').toBe(true),
    );
    await settled(server);
    const own = dialogs().filter((node) => !stepDialogs().includes(node));
    if (own.length === 1 && buttons(own[0]!, NAME.close).length === 1)
      await click(button(own[0]!, NAME.close));
    await waitFor(() => expect(dialogs()).toEqual([]));
    await waitFor(() => expect(shows(rowOf(main(), a.out_biz_no), STATUS_SHOWN.PAYING)).toBe(true));
    expect(shows(rowOf(main(), c.out_biz_no), STATUS_SHOWN.PAYING)).toBe(true);
    expect(shows(rowOf(main(), b.out_biz_no), STATUS_SHOWN.APPROVED)).toBe(true);
    expect(ticked(), 'the ticks are cleared').toEqual([]);
    expect(writes(server)).toHaveLength(1);
  },
);

it(
  '[AC-F1-08an-SUBMIT#3] 超管混选一张待审核单与两张待执行单：确认对话框里待审核单标「未审核」、不列为将执行；请求体只有两张待执行单（列表顺序），待审核单不在本操作中审核（不发 batch-approve）；结果里待审核单仍为「未审核」、两张待执行单为「已发起打款」',
  { timeout: 90_000 },
  async () => {
    const rows = mixedRows();
    const server = serverFor(listOf(rows));
    server.once('POST', '/admin/v1/payout-batches', () =>
      executedReply(server, [rows.a.withdrawal_id, rows.b.withdrawal_id]),
    );
    await mount(server, SUPER);
    await select([rows.p, rows.b, rows.a]);
    expect(disabled(button(main(), NAME.entry))).toBe(false);
    const modal = await openBatch(server);
    const pending = rows.p.out_biz_no;
    await waitFor(() => expect(shows(rowOf(modal, pending), TEXT.unreviewed)).toBe(true));
    expect(shows(rowOf(modal, pending), TEXT.paying)).toBe(false);
    expect(numbersIn(modal, [rows.a.out_biz_no, rows.b.out_biz_no])).toEqual([
      rows.a.out_biz_no,
      rows.b.out_biz_no,
    ]);
    await confirm(server, modal);
    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(1));
    await settled(server);
    assertBatch(server, 0, [rows.a.withdrawal_id, rows.b.withdrawal_id]);
    expect(server.requests('POST', '/admin/v1/withdrawals/batch-approve')).toEqual([]);
    await resultShown(rows.a.out_biz_no, TEXT.paying);
    await resultShown(rows.b.out_biz_no, TEXT.paying);
    await resultShown(rows.p.out_biz_no, TEXT.unreviewed);
    resultNotShown(rows.p.out_biz_no, TEXT.paying);
    expect(shows(document.body, TEXT.unknown), 'a settled answer, not unknown').toBe(false);
  },
);
