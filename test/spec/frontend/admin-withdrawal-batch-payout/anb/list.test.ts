// @vitest-environment jsdom
// F1-08anb LIST（BR-WDR-12 后台【批量自动打款】：逐单结果写入列表「执行结果」列；勾选中的待审核单结果列显示「未审核」）。
// 结果对话框关闭、列表重读完成之后，按单号定位每一行「原因 / 执行结果」单元格里的本次执行结果，三行各自对应、
// 不串行；没勾的行没有结果行。约定见 ../helpers.ts 与 ./helpers.ts 开头。
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { REVIEW_MODE_NAME, STATUS_NAME, samples } from '../../admin-withdrawals/fixtures.ts';
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

// ---- LIST#2–#5: the receipt is this execution's answer, not the row's later status ------------
// 本次执行结果只取这次回答（WithdrawalsPage 列说明：列表重读后状态以服务端为准）：同一页面会话里再读一次列表、
// 该单到账为 PAID_API，状态列跟着变，「执行结果」仍恰为这次的回执原文；点【查询】【重置】或切状态页签后回执清空。
// 重读时的夹具照契约 listAdminWithdrawals：人工审核单（review_mode manual，LIST#2–#4）为 display_status
// paid_auto_review，自动审核单（review_mode auto，LIST#5）为 paid_auto_system；状态列按 status 显示「接口打款成功」，
// 其下是审核方式「人工审核」/「自动到账」（admin_dict）。
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

type Mode = 'manual' | 'auto';
/**
 * listAdminWithdrawals display_status of a PAID_API withdrawal: paid_auto_system only for an
 * auto-reviewed one (review_mode auto), paid_auto_review otherwise (contracts AdminWithdrawalDisplayStatus).
 */
const PAID_DISPLAY: Readonly<Record<Mode, Withdrawal['display_status']>> = {
  manual: 'paid_auto_review',
  auto: 'paid_auto_system',
};

/** The withdrawal moves PAYING → PAID_API on the server (paid by the payout process). */
function paidOnServer(server: Server, id: string, mode: Mode): void {
  const item = server.state.find((one) => one.withdrawal_id === id);
  expect(item, `server row ${id}`).toBeDefined();
  expect(item!.review_mode, `fixture: ${id} review_mode`).toBe(mode);
  item!.status = 'PAID_API';
  item!.display_status = PAID_DISPLAY[mode];
  item!.paid_at = '2026-11-19T12:05:00+08:00';
}

/**
 * The status cell of a PAID_API row, exactly: the status name (admin_dict.withdrawal_status.PAID_API)
 * and the review mode name under it (admin_dict.withdrawals.review_mode.<mode>), no mark.
 */
function paidStatusCell(mode: Mode): string {
  return compact(`${STATUS_NAME.PAID_API}${REVIEW_MODE_NAME[mode]}`);
}

/** A: APPROVED alipay ¥12,345.67 reviewed by `mode` (auto: the auto decision of an auto row). */
function rowsFor(mode: Mode): ReturnType<typeof mixedRows> {
  const rows = mixedRows();
  if (mode === 'manual') return rows;
  const decided = samples().find((one) => one.review_mode === 'auto')?.auto_decision;
  expect(decided?.result, 'fixture: an auto decision').toBe('auto');
  expect(decided?.execute_blocked, 'fixture: not blocked').toBeNull();
  return {
    ...rows,
    a: row(1, 'APPROVED', 1234567, 'alipay', {
      review_mode: 'auto',
      auto_decision: decided!,
      reviewer_id: null,
    }),
  };
}

type Clearing = 'query' | 'reset' | 'tab';

async function receiptCase(clearing: Clearing, mode: Mode = 'manual'): Promise<void> {
  const rows = rowsFor(mode);
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
  paidOnServer(server, a.withdrawal_id, mode);
  await toPage(server, 1);
  await waitFor(() =>
    expect(shows(cellOf(a.out_biz_no, STATUS_COLUMN), STATUS_NAME.PAID_API)).toBe(true),
  );
  await settled(server);
  expect(dialogs()).toEqual([]);
  const reread = server.state.find((one) => one.withdrawal_id === a.withdrawal_id);
  expect(
    [reread?.status, reread?.review_mode, reread?.display_status],
    `${a.out_biz_no}: as listAdminWithdrawals answers a ${mode} PAID_API row`,
  ).toEqual(['PAID_API', mode, PAID_DISPLAY[mode]]);
  const status = cellOf(a.out_biz_no, STATUS_COLUMN);
  expect(compact(status.textContent), `${a.out_biz_no}: the status column of ${mode}`).toBe(
    paidStatusCell(mode),
  );
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
  '[AC-F1-08anb-LIST#2] 回执不随到账改写：执行后列表重读，进入打款那行「执行结果」恰为「本次执行结果：已发起打款」；同一页面会话里翻到第 2 页再回第 1 页，服务端已把该人工审核单（review_mode manual）改为 PAID_API、display_status paid_auto_review：状态列恰为「接口打款成功」与「人工审核」、不再是「打款中」，「执行结果」仍恰为这次的回执原文（留下与未审核两行也不变）；点【查询】后回执清空，该行不再有「本次执行结果：」',
  { timeout: 180_000 },
  async () => {
    await receiptCase('query');
  },
);

it(
  '[AC-F1-08anb-LIST#3] 回执不随到账改写，点【重置】后清空：同 LIST#2 的执行与重读（人工审核单 PAID_API、display_status paid_auto_review，状态列恰为「接口打款成功」与「人工审核」、执行结果仍为这次回执原文），点【重置】后列表重读，三行都不再有「本次执行结果：」',
  { timeout: 180_000 },
  async () => {
    await receiptCase('reset');
  },
);

it(
  '[AC-F1-08anb-LIST#4] 回执不随到账改写，切状态页签后清空：同 LIST#2 的执行与重读（人工审核单 display_status paid_auto_review），切到「自动」页签（status=PAID_API）列出该单、它不再有「本次执行结果：」；切回「全部」三行都没有回执',
  { timeout: 180_000 },
  async () => {
    await receiptCase('tab');
  },
);

it(
  '[AC-F1-08anb-LIST#5] 回执不随到账改写（自动审核单）：进入打款那张为 review_mode auto 的待执行单，同 LIST#2 的执行与重读；服务端把它改为 PAID_API、display_status paid_auto_system：状态列恰为「接口打款成功」与「自动到账」、不再是「打款中」，「执行结果」仍恰为「本次执行结果：已发起打款」（留下与未审核两行也不变）；点【查询】后回执清空',
  { timeout: 180_000 },
  async () => {
    await receiptCase('query', 'auto');
  },
);

// ---- LIST#6: an auto withdrawal whose first (system) execution was blocked by the paused queue ----
// BR-WDR-12 / BR-WDR-30：判 auto 的单由系统建 kind=auto 批次执行，① 队列暂停（payout.queue_paused）即整批拒绝、
// 什么都不写：单据留在 APPROVED、不挂批次（batch_id null），auto_decision 追加 execute_blocked=queue_paused
// （契约 AdminWithdrawalAutoDecision），转人工执行。持 payout.execute 勾它组人工批次执行；执行受阻的标记随
// auto_decision 留在状态列（marksOf），「执行结果」只取这次回执。

it(
  '[AC-F1-08anb-LIST#6] 自动审核通过、首次自动执行因打款队列暂停受阻（review_mode auto、auto_decision.execute_blocked=queue_paused、留在 APPROVED、未挂批次）的待执行单：超管勾它执行，服务端回 executed、paying 恰为这一张；关闭结果对话框、列表重读后该行「执行结果」恰为「本次执行结果：已发起打款」；翻到第 2 页再回第 1 页，服务端已把它改为 PAID_API、display_status paid_auto_system：状态列恰为「接口打款成功」「自动到账」与执行受阻标记、不再是「打款中」，「执行结果」仍恰为这次回执原文；只发一笔写',
  { timeout: 180_000 },
  async () => {
    const decided = samples().find((one) => one.review_mode === 'auto')?.auto_decision;
    expect(decided?.result, 'fixture: an auto decision').toBe('auto');
    // Created 2026-11-19 10:58:00 +08:00 (row 1), decided and reviewed by the system right after.
    const blocked = row(1, 'APPROVED', 1234567, 'alipay', {
      review_mode: 'auto',
      auto_decision: {
        ...decided!,
        decided_at: '2026-11-19T10:58:05+08:00',
        execute_blocked: 'queue_paused',
      },
      reviewer_id: null,
      reviewed_at: '2026-11-19T10:58:06+08:00',
      batch_id: null,
      batch: null,
      batch_items: [],
    });
    /** The execute-blocked mark beside the status (texts executeBlocked, the raw code). */
    const mark = '执行受阻：queue_paused';
    const statusCell = (status: 'APPROVED' | 'PAYING' | 'PAID_API'): string =>
      compact(`${STATUS_NAME[status]}${REVIEW_MODE_NAME.auto}${mark}`);
    const rest = older();
    const server = serverFor([blocked, ...rest]);
    server.once('POST', '/admin/v1/payout-batches', () =>
      executedReply(server, [blocked.withdrawal_id], []),
    );
    await mount(server, SUPER);
    expect(rowsOf(main(), rest[19]!.out_biz_no), 'page one holds 20 rows').toEqual([]);
    expect(
      compact(cellOf(blocked.out_biz_no, STATUS_COLUMN).textContent),
      `${blocked.out_biz_no}: APPROVED, auto, blocked by the paused queue`,
    ).toBe(statusCell('APPROVED'));
    expect(resultLines(blocked.out_biz_no), 'no receipt before the execution').toEqual([]);

    await select([blocked]);
    const modal = await openBatch(server);
    await confirm(server, modal);
    const at = server.log.length;
    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(1));
    await settled(server);
    assertBatch(server, 0, [blocked.withdrawal_id]);
    await readAfter(server, at, 'the list read again after the execution');
    await closeResult();
    await waitFor(() =>
      expect(shows(cellOf(blocked.out_biz_no, STATUS_COLUMN), STATUS_SHOWN.PAYING)).toBe(true),
    );
    await settled(server);
    expect(dialogs(), 'asserted on the list, not in a dialog').toEqual([]);
    expect(
      compact(cellOf(blocked.out_biz_no, STATUS_COLUMN).textContent),
      `${blocked.out_biz_no}: PAYING after the reread`,
    ).toBe(statusCell('PAYING'));
    const receipt = line(TEXT.paying);
    expect(resultLines(blocked.out_biz_no), `${blocked.out_biz_no}: the receipt`).toEqual(receipt);

    // The same page session reads the list again; this time the server has paid it (PAID_API).
    await toPage(server, 2);
    await waitFor(() => expect(rowsOf(main(), rest[19]!.out_biz_no)).toHaveLength(1));
    expect(rowsOf(main(), blocked.out_biz_no), 'page two does not hold it').toEqual([]);
    expect(resultLines(rest[19]!.out_biz_no), 'an unticked row has no receipt').toEqual([]);
    paidOnServer(server, blocked.withdrawal_id, 'auto');
    await toPage(server, 1);
    await waitFor(() =>
      expect(shows(cellOf(blocked.out_biz_no, STATUS_COLUMN), STATUS_NAME.PAID_API)).toBe(true),
    );
    await settled(server);
    expect(dialogs()).toEqual([]);
    const reread = server.state.find((one) => one.withdrawal_id === blocked.withdrawal_id);
    expect(
      [
        reread?.status,
        reread?.review_mode,
        reread?.display_status,
        reread?.auto_decision?.execute_blocked,
      ],
      `${blocked.out_biz_no}: as listAdminWithdrawals answers an auto PAID_API row`,
    ).toEqual(['PAID_API', 'auto', 'paid_auto_system', 'queue_paused']);
    const status = cellOf(blocked.out_biz_no, STATUS_COLUMN);
    expect(compact(status.textContent), `${blocked.out_biz_no}: the new status`).toBe(
      statusCell('PAID_API'),
    );
    expect(shows(status, STATUS_SHOWN.PAYING), `${blocked.out_biz_no}: no longer paying`).toBe(
      false,
    );
    expect(
      resultLines(blocked.out_biz_no),
      `${blocked.out_biz_no}: still this execution's receipt`,
    ).toEqual(receipt);
    expect(
      shows(cellOf(blocked.out_biz_no, '原因 / 执行结果'), STATUS_NAME.PAID_API),
      'the receipt column does not take the new status',
    ).toBe(false);
    for (const one of rest.slice(0, 19))
      expect(resultLines(one.out_biz_no), `${one.out_biz_no}: not ticked, no receipt`).toEqual([]);
    expect(writeLines(server), 'the rereads write nothing').toEqual(ONE_BATCH);
  },
);
