// @vitest-environment jsdom
// F1-08anb LIST（BR-WDR-12 后台【批量自动打款】：逐单结果写入列表「执行结果」列；勾选中的待审核单结果列显示「未审核」）。
// 结果对话框关闭、列表重读完成之后，按单号定位每一行「原因 / 执行结果」单元格里的本次执行结果，三行各自对应、
// 不串行；没勾的行没有结果行。约定见 ../helpers.ts 与 ./helpers.ts 开头。
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { STATUS_NAME } from '../../admin-withdrawals/fixtures.ts';
import {
  LEFT_TEXT,
  STATUS_SHOWN,
  SUPER,
  TAB_NAMES,
  TEXT,
  assertBatch,
  button,
  click,
  compact,
  confirm,
  dialogs,
  executedReply,
  isTableRead,
  listOf,
  main,
  mixedRows,
  mount,
  openBatch,
  row,
  rowOf,
  rowsOf,
  select,
  serverFor,
  settled,
  shows,
  verify,
  writes,
  type RequestLog,
  type Server,
  type Withdrawal,
} from '../helpers.ts';
import { ONE_BATCH, closeResult, line, resultLines, writeLines } from './helpers.ts';

it(
  '[AC-F1-08anb-LIST#1] 超管混选一张待审核单与两张待执行单执行，服务端回 executed：一张进入打款、一张因打款通道未开通留下；关闭结果对话框、列表重读后，按单号定位「原因 / 执行结果」单元格：进入打款那行恰为「本次执行结果：已发起打款」，留下那行恰为该原因全文，待审核那行恰为「未审核」，没勾的行没有执行结果；只发一笔写',
  { timeout: 120_000 },
  async () => {
    const rows = mixedRows();
    const { a, b, p, k, y, d } = rows;
    const server = serverFor(listOf(rows));
    server.once('POST', '/admin/v1/payout-batches', () =>
      executedReply(
        server,
        [a.withdrawal_id],
        [{ withdrawal_id: b.withdrawal_id, reason: 'channel_disabled' }],
      ),
    );
    await mount(server, SUPER);
    await select([p, b, a]);
    const modal = await openBatch(server);
    await confirm(server, modal);
    const at = server.log.length;
    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(1));
    await settled(server);
    assertBatch(server, 0, [a.withdrawal_id, b.withdrawal_id]);

    await waitFor(() =>
      expect(server.log.slice(at).some(isTableRead), 'the list read again').toBe(true),
    );
    await settled(server);
    await closeResult();
    expect(dialogs(), 'asserted on the list, not in a dialog').toEqual([]);
    await waitFor(() => expect(shows(rowOf(main(), a.out_biz_no), STATUS_SHOWN.PAYING)).toBe(true));
    await settled(server);
    expect(dialogs()).toEqual([]);

    expect(resultLines(a.out_biz_no), `${a.out_biz_no}: paying`).toEqual(line(TEXT.paying));
    expect(resultLines(b.out_biz_no), `${b.out_biz_no}: its own reason`).toEqual(
      line(LEFT_TEXT.channel_disabled),
    );
    expect(resultLines(p.out_biz_no), `${p.out_biz_no}: not reviewed`).toEqual(
      line(TEXT.unreviewed),
    );
    for (const one of [k, y, d])
      expect(resultLines(one.out_biz_no), `${one.out_biz_no}: not ticked, no result`).toEqual([]);
    expect(shows(rowOf(main(), b.out_biz_no), STATUS_SHOWN.APPROVED)).toBe(true);
    expect(writeLines(server)).toEqual(ONE_BATCH);
  },
);

// ---- LIST#2–#4: the receipt is this execution's answer, not the row's later status ------------
// 本次执行结果只取这次回答（WithdrawalsPage 列说明：列表重读后状态以服务端为准）：同一页面会话里再读一次列表、
// 该单到账为 PAID_API，状态列跟着变，「执行结果」仍恰为这次的回执原文；点【查询】【重置】或切状态页签后回执清空。
// 再读一次用真实分页：第 1 页 → 第 2 页 → 回第 1 页（翻页清空勾选、不清回执，见 WithdrawalsPage changePage）。

/** The list column of the withdrawal status (texts columns.status). */
const STATUS_COLUMN = '状态';
/** The page's 【查询】 / 【重置】 (texts filter.query / filter.reset). */
const QUERY = '查询';
const RESET = '重置';
const CJK = /[㐀-鿿]/;

/** Twenty older PAYING rows (n = 7…26): 26 on the server, so the list has a page 2. */
function older(): Withdrawal[] {
  return Array.from({ length: 20 }, (_, index) =>
    row(7 + index, 'PAYING', 1000 + index, 'alipay', { execute_seq: 1 }),
  );
}

/** The cell of column `column` in the list row of withdrawal number `number`. */
function cellOf(number: string, column: string): HTMLElement {
  const tr = rowOf(main(), number);
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

/** The one status tab of the list named `name` (a count may follow). */
function statusTab(name: string): HTMLElement {
  const found = within(main())
    .queryAllByRole('tab', { hidden: true })
    .filter((tab) => {
      const text = compact(tab.textContent);
      return text.startsWith(name) && !CJK.test(text.slice(name.length));
    });
  expect(found, `one status tab ${name}`).toHaveLength(1);
  return found[0]!;
}

/** Waits for a table read after log index `at` that `test` accepts, then for it to settle. */
async function readAfter(
  server: Server,
  at: number,
  what: string,
  test: (request: RequestLog) => boolean = () => true,
): Promise<void> {
  await waitFor(() =>
    expect(
      server.log.slice(at).some((request) => isTableRead(request) && test(request)),
      what,
    ).toBe(true),
  );
  await settled(server);
}

/** Clicks page `n` of the list's pagination and waits for that page to be read. */
async function toPage(server: Server, n: number): Promise<void> {
  const pager = main().querySelector<HTMLElement>(`.ant-pagination-item-${n}`);
  expect(pager, `page ${n} of the pagination`).not.toBeNull();
  const at = server.log.length;
  await click(pager!);
  await readAfter(
    server,
    at,
    `the read of page ${n}`,
    (request) => request.query['page'] === String(n),
  );
}

/** The withdrawal moves PAYING → PAID_API on the server (paid by the payout process). */
function paidOnServer(server: Server, id: string): void {
  const item = server.state.find((one) => one.withdrawal_id === id);
  expect(item, `server row ${id}`).toBeDefined();
  item!.status = 'PAID_API';
  item!.display_status = 'paid_auto_system';
  item!.paid_at = '2026-11-19T12:05:00+08:00';
}

type Clearing = 'query' | 'reset' | 'tab';

async function receiptCase(clearing: Clearing): Promise<void> {
  const rows = mixedRows();
  const { a, b, p } = rows;
  const rest = older();
  const server = serverFor([...listOf(rows), ...rest]);
  server.once('POST', '/admin/v1/payout-batches', () =>
    executedReply(
      server,
      [a.withdrawal_id],
      [{ withdrawal_id: b.withdrawal_id, reason: 'channel_disabled' }],
    ),
  );
  await mount(server, SUPER);
  expect(rowsOf(main(), rest[19]!.out_biz_no), 'page one holds 20 rows').toEqual([]);
  await select([p, b, a]);
  const modal = await openBatch(server);
  await confirm(server, modal);
  const at = server.log.length;
  await verify();
  await waitFor(() => expect(writes(server)).toHaveLength(1));
  await settled(server);
  assertBatch(server, 0, [a.withdrawal_id, b.withdrawal_id]);
  await readAfter(server, at, 'the list read again after the execution');
  await closeResult();
  await waitFor(() =>
    expect(shows(cellOf(a.out_biz_no, STATUS_COLUMN), STATUS_SHOWN.PAYING)).toBe(true),
  );
  await settled(server);
  expect(dialogs(), 'asserted on the list, not in a dialog').toEqual([]);
  const receipts = {
    a: line(TEXT.paying),
    b: line(LEFT_TEXT.channel_disabled),
    p: line(TEXT.unreviewed),
  };
  expect(resultLines(a.out_biz_no), `${a.out_biz_no}: the receipt`).toEqual(receipts.a);
  expect(resultLines(b.out_biz_no), `${b.out_biz_no}: the receipt`).toEqual(receipts.b);
  expect(resultLines(p.out_biz_no), `${p.out_biz_no}: the receipt`).toEqual(receipts.p);

  // The same page session reads the list again; this time the server has paid A (PAID_API).
  await toPage(server, 2);
  await waitFor(() => expect(rowsOf(main(), rest[19]!.out_biz_no)).toHaveLength(1));
  expect(rowsOf(main(), a.out_biz_no), 'page two does not hold A').toEqual([]);
  paidOnServer(server, a.withdrawal_id);
  await toPage(server, 1);
  await waitFor(() =>
    expect(shows(cellOf(a.out_biz_no, STATUS_COLUMN), STATUS_NAME.PAID_API)).toBe(true),
  );
  await settled(server);
  expect(dialogs()).toEqual([]);
  const status = cellOf(a.out_biz_no, STATUS_COLUMN);
  expect(shows(status, STATUS_SHOWN.PAYING), `${a.out_biz_no}: the status column moved on`).toBe(
    false,
  );
  expect(resultLines(a.out_biz_no), `${a.out_biz_no}: still this execution's receipt`).toEqual(
    receipts.a,
  );
  expect(resultLines(b.out_biz_no), `${b.out_biz_no}: still its receipt`).toEqual(receipts.b);
  expect(resultLines(p.out_biz_no), `${p.out_biz_no}: still its receipt`).toEqual(receipts.p);
  expect(
    shows(cellOf(a.out_biz_no, '原因 / 执行结果'), STATUS_NAME.PAID_API),
    'the receipt column does not take the new status',
  ).toBe(false);
  expect(writeLines(server), 'the rereads write nothing').toEqual(ONE_BATCH);

  // 【查询】 / 【重置】 / another status tab: the receipt is gone.
  const before = server.log.length;
  if (clearing === 'query') {
    await click(button(main(), QUERY));
    await readAfter(server, before, `the read of ${QUERY}`);
  } else if (clearing === 'reset') {
    await click(button(main(), RESET));
    await readAfter(server, before, `the read of ${RESET}`);
  } else {
    await click(statusTab(TAB_NAMES.auto));
    await readAfter(
      server,
      before,
      `the read of the tab ${TAB_NAMES.auto}`,
      (request) => request.query['status'] === 'PAID_API',
    );
  }
  await waitFor(() => expect(rowsOf(main(), a.out_biz_no)).toHaveLength(1));
  await settled(server);
  expect(shows(cellOf(a.out_biz_no, STATUS_COLUMN), STATUS_NAME.PAID_API)).toBe(true);
  expect(resultLines(a.out_biz_no), `${clearing}: ${a.out_biz_no} has no receipt`).toEqual([]);
  if (clearing === 'tab') {
    const back = server.log.length;
    await click(statusTab(TAB_NAMES.all));
    await readAfter(
      server,
      back,
      `the read of the tab ${TAB_NAMES.all}`,
      (request) => request.query['status'] === undefined,
    );
    await waitFor(() => expect(rowsOf(main(), b.out_biz_no)).toHaveLength(1));
    await settled(server);
    expect(resultLines(a.out_biz_no), `back on ${TAB_NAMES.all}: no receipt`).toEqual([]);
  }
  expect(resultLines(b.out_biz_no), `${clearing}: ${b.out_biz_no} has no receipt`).toEqual([]);
  expect(resultLines(p.out_biz_no), `${clearing}: ${p.out_biz_no} has no receipt`).toEqual([]);
  expect(shows(main(), '本次执行结果：'), `${clearing}: no receipt left anywhere in the list`).toBe(
    false,
  );
  expect(writeLines(server), `${clearing}: nothing written`).toEqual(ONE_BATCH);
}

it(
  '[AC-F1-08anb-LIST#2] 回执不随到账改写：执行后列表重读，进入打款那行「执行结果」恰为「本次执行结果：已发起打款」；同一页面会话里翻到第 2 页再回第 1 页，服务端已把该单改为 PAID_API：状态列显示「接口打款成功」、不再是「打款中」，「执行结果」仍恰为这次的回执原文（留下与未审核两行也不变）；点【查询】后回执清空，该行不再有「本次执行结果：」',
  { timeout: 180_000 },
  async () => {
    await receiptCase('query');
  },
);

it(
  '[AC-F1-08anb-LIST#3] 回执不随到账改写，点【重置】后清空：同 LIST#2 的执行与重读（状态列为「接口打款成功」、执行结果仍为这次回执原文），点【重置】后列表重读，三行都不再有「本次执行结果：」',
  { timeout: 180_000 },
  async () => {
    await receiptCase('reset');
  },
);

it(
  '[AC-F1-08anb-LIST#4] 回执不随到账改写，切状态页签后清空：同 LIST#2 的执行与重读，切到「自动」页签（status=PAID_API）列出该单、它不再有「本次执行结果：」；切回「全部」三行都没有回执',
  { timeout: 180_000 },
  async () => {
    await receiptCase('tab');
  },
);
