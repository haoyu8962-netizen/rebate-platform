// @vitest-environment jsdom
// F1-08anb 第 5 轮（approvals 第 122 条，D10-2244 / D10-2245）：逐单留下原因写进列表「执行结果」的两种补充——
// LEFT#2 逐单 left 带 watermark_usable_exceeded（BR-WDR-18 可用比例，按通道判）；LIST#7 逐单 left 带
// has_transfer_attempt（BR-WDR-12 ②：已有转账记录，只能手动成功或驳回）。弹窗里与列表重读后都必须是该原因的
// 完整文案（工作树 texts/withdrawals.ts execute.left，在 ../helpers.ts LEFT_TEXT 独立写成全文），不是
// 「本次未执行：<编码>」兜底。约定见 ../helpers.ts 与 ./helpers.ts 开头。
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  EXECUTOR,
  LEFT_TEXT,
  STATUS_SHOWN,
  SUPER,
  TEXT,
  assertBatch,
  compact,
  confirm,
  dialogs,
  executedReply,
  isTableRead,
  main,
  mount,
  openBatch,
  row,
  rowOf,
  select,
  serverFor,
  settled,
  shows,
  verify,
  writes,
  type LeftReason,
  type Server,
  type Withdrawal,
} from '../helpers.ts';
import {
  ONE_BATCH,
  closeResult,
  leavesStarting,
  line,
  ownDialog,
  resultLines,
  writeLines,
} from './helpers.ts';

/** The result column of the result dialog (texts execute.result). */
const DIALOG_RESULT = '执行结果';
/** The summary of the result dialog: one paying, one left, none unreviewed (full text). */
const SUMMARY = '进入打款 1 张，留在待执行 1 张；列表与页签计数已刷新。';
/** The fallback of an unknown left reason (texts execute.leftOther) must never be shown. */
const FALLBACK = '本次未执行：';

/** The cell of column `column` in the row of withdrawal number `number` inside `root`. */
function cellIn(root: HTMLElement, number: string, column: string): HTMLElement {
  const tr = rowOf(root, number);
  const scope = tr.closest<HTMLElement>('.ant-table') ?? tr.closest<HTMLElement>('table');
  expect(scope, `the table of ${number}`).not.toBeNull();
  const heads = Array.from(scope!.querySelectorAll<HTMLElement>('thead th')).filter(
    (one) => !one.classList.contains('ant-table-cell-scrollbar'),
  );
  const index = heads.findIndex((one) => compact(one.textContent) === compact(column));
  expect(index, `a column ${column}`).not.toBe(-1);
  const cells = Array.from(tr.children).filter(
    (one): one is HTMLElement => one instanceof HTMLElement && one.localName === 'td',
  );
  expect(cells, `${number}: one cell per column`).toHaveLength(heads.length);
  return cells[index]!;
}

/**
 * Ticks `paid` and `kept`, executes; the server answers executed with `paid` paying and `kept`
 * left for `reason`. Checks the dialog, closes it after the list was read again and checks the list.
 */
async function leftCase(
  server: Server,
  paid: Withdrawal,
  kept: Withdrawal,
  reason: LeftReason,
): Promise<void> {
  const full = LEFT_TEXT[reason];
  server.once('POST', '/admin/v1/payout-batches', () =>
    executedReply(server, [paid.withdrawal_id], [{ withdrawal_id: kept.withdrawal_id, reason }]),
  );
  await select([paid, kept]);
  const modal = await openBatch(server);
  await confirm(server, modal);
  const at = server.log.length;
  await verify();
  await waitFor(() => expect(writes(server)).toHaveLength(1));
  await settled(server);
  assertBatch(server, 0, [paid.withdrawal_id, kept.withdrawal_id]);

  // In the result dialog: each withdrawal's own result, the full text, no fallback.
  await waitFor(() => expect(leavesStarting(ownDialog(), '进入打款')).toHaveLength(1));
  const dialog = ownDialog();
  expect(
    compact(cellIn(dialog, kept.out_biz_no, DIALOG_RESULT).textContent),
    `${kept.out_biz_no}: the full text of ${reason}`,
  ).toBe(compact(full));
  expect(
    compact(cellIn(dialog, paid.out_biz_no, DIALOG_RESULT).textContent),
    `${paid.out_biz_no}: paying`,
  ).toBe(compact(TEXT.paying));
  expect(leavesStarting(dialog, FALLBACK), 'no fallback text in the dialog').toEqual([]);
  expect(shows(dialog, reason), 'the raw reason code is not shown').toBe(false);
  expect(leavesStarting(dialog, '进入打款'), 'the summary').toEqual([compact(SUMMARY)]);

  // After the list was read again and the dialog is closed: the list's 「执行结果」.
  await waitFor(() =>
    expect(server.log.slice(at).some(isTableRead), 'the list read again').toBe(true),
  );
  await settled(server);
  await closeResult();
  await waitFor(() =>
    expect(shows(rowOf(main(), paid.out_biz_no), STATUS_SHOWN.PAYING)).toBe(true),
  );
  await settled(server);
  expect(dialogs(), 'asserted on the list, not in a dialog').toEqual([]);
  expect(resultLines(kept.out_biz_no), `${kept.out_biz_no}: its reason in full`).toEqual(
    line(full),
  );
  expect(resultLines(paid.out_biz_no), `${paid.out_biz_no}: paying`).toEqual(line(TEXT.paying));
  const keptRow = rowOf(main(), kept.out_biz_no);
  expect(shows(keptRow, STATUS_SHOWN.APPROVED), `${kept.out_biz_no}: still approved`).toBe(true);
  expect(shows(keptRow, STATUS_SHOWN.PAYING), `${kept.out_biz_no}: not paying`).toBe(false);
  expect(shows(main(), `${FALLBACK}${reason}`), 'no fallback text in the list').toBe(false);
  expect(
    server.state.map((one) => [one.withdrawal_id, one.status]),
    'only the paying one moved on the server',
  ).toEqual([
    [paid.withdrawal_id, 'PAYING'],
    [kept.withdrawal_id, 'APPROVED'],
  ]);
  expect(writeLines(server)).toEqual(ONE_BATCH);
}

it(
  '[AC-F1-08anb-LEFT#2] 逐单 left 带 watermark_usable_exceeded：持 payout.execute 勾支付宝、微信零钱两张待执行单执行，服务端回 executed：支付宝单进入打款，微信单因所在通道在途与本批合计超过可用余额留在 left；结果对话框里微信单的执行结果恰为「所在通道在途与本批合计超过可用余额，本次未执行」、不是「本次未执行：…」兜底，汇总恰为「进入打款 1 张，留在待执行 1 张」；关闭对话框、列表重读后该行「执行结果」恰为「本次执行结果：」加同一全文，仍为已通过待打款；只发一笔写',
  { timeout: 120_000 },
  async () => {
    const alipay = row(1, 'APPROVED', 1234567, 'alipay');
    const wechat = row(2, 'APPROVED', 9801, 'wechat');
    const server = serverFor([alipay, wechat]);
    await mount(server, EXECUTOR);
    await leftCase(server, alipay, wechat, 'watermark_usable_exceeded');
  },
);

it(
  '[AC-F1-08anb-LIST#7] 逐单 left 带 has_transfer_attempt 写进列表「执行结果」：超管勾两张待执行单执行，服务端回 executed：支付宝单进入打款，曾执行过的银行卡单因已有转账记录留在 left；结果对话框里该单执行结果恰为「已有转账记录，只能手动成功或驳回，本次未执行」；关闭对话框、列表重读后，按单号该行「执行结果」恰为「本次执行结果：已有转账记录，只能手动成功或驳回，本次未执行」，进入打款那行恰为「本次执行结果：已发起打款」；只发一笔写',
  { timeout: 120_000 },
  async () => {
    const alipay = row(1, 'APPROVED', 1234567, 'alipay');
    const bank = row(2, 'APPROVED', 9801, 'bank_card', { execute_seq: 1 });
    const server = serverFor([alipay, bank]);
    await mount(server, SUPER);
    await leftCase(server, alipay, bank, 'has_transfer_attempt');
  },
);
