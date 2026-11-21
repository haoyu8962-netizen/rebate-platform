// @vitest-environment jsdom
// F1-08anb AMOUNT（BR-WDR-11：不设批次第二人批准；例「批次 30 单合计 ¥20,000 → 不需第二人批准，执行人 step-up 后执行」）。
// 照真实交互写：列表每页固定 20 行、没有每页条数选择与全选框、翻页清空勾选、【一键组批】只选当前页，一次批量最多勾到
// 当前页 20 张（30 单的原例在当前交互下做不到，另由编排定）。服务端 total=30，第 1 页 20 张待执行单实付合计恰为
// 2000000 分（¥20,000.00）：逐张勾选或【一键组批】选中这 20 张 → 一次确认 + 一次动态码 → 恰 1 笔 POST，
// withdrawal_ids 恰为这 20 张、按列表顺序；页面上没有「需他人批准」「第二人」类提示；除这 1 笔外没有别的写请求。
// 夹具照真实能执行的情形（批量接口的桩把 20 张都标成 PAYING）：打款概览里打款开、队列运行，所用通道（含银行卡）
// 都开通未暂停、余额 W 已录入且远大于本批合计，确认里的执行前检查全部满足。
// 约定见 ../helpers.ts 与 ./helpers.ts 开头。
import { addFen, formatYuanAdmin, parseFen, subFen } from '@couli/money';
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { overview, type OverviewChannel } from '../../admin-payouts-readonly/fixtures.ts';
import {
  EXECUTOR,
  NAME,
  TEXT,
  VERIFY,
  assertBatch,
  button,
  check,
  click,
  confirm,
  executedReply,
  isTableRead,
  main,
  mount,
  numbersIn,
  openBatch,
  row,
  select,
  serverFor,
  settled,
  shows,
  ticked,
  verify,
  writes,
  type Overview,
  type Server,
  type Withdrawal,
} from '../helpers.ts';
import { ONE_BATCH, SECOND_PERSON_HINTS, writeLines } from './helpers.ts';

/** BR-WDR-11 例：合计 ¥20,000（分）。 */
const BATCH_TOTAL_FEN = 2_000_000;
const ON_SERVER = 30;
const PER_PAGE = 20;

/** 30 APPROVED withdrawals (newest first), ¥1,000.00 each, mixed alipay / bank card. */
function thirty(): Withdrawal[] {
  return Array.from({ length: ON_SERVER }, (_, index) =>
    row(index + 1, 'APPROVED', 100_000, index % 4 === 3 ? 'bank_card' : 'alipay'),
  );
}

function sumOf(rows: readonly Withdrawal[]): bigint {
  let total = parseFen(0);
  for (const one of rows) total = addFen(total, parseFen(one.net_fen));
  return total;
}

function noSecondPerson(where: string): void {
  for (const hint of SECOND_PERSON_HINTS)
    expect(shows(document.body, hint), `${where}: no hint ${hint}`).toBe(false);
}

/** W entered on every channel (¥1,000,000.00), far above any batch here. */
const AMPLE_W_FEN = 100_000_000;

/**
 * The overview the batch really runs under (the stub marks all 20 PAYING): payout on, queue
 * running, every channel (bank card included) open and not paused, W entered and fresh, far above
 * the batch; P per channel is that channel's share of page one; the daily limits of the sample.
 */
function ampleOverview(page: readonly Withdrawal[]): Overview {
  const sample = overview();
  const entered = sample.channels.find((one) => one.watermark !== null)!.watermark!;
  return {
    ...sample,
    payout_enabled: true,
    queue_paused: false,
    channels: sample.channels.map((one): OverviewChannel => ({
      ...one,
      enabled: true,
      paused: false,
      watermark: { ...entered, available_fen: AMPLE_W_FEN },
      forecast_withdrawal_fen: page
        .filter((item) => item.payout_channel === one.channel)
        .reduce((total, item) => total + item.net_fen, 0),
      water_level: 'normal',
    })),
  };
}

/** The fake server of the 30 rows under ampleOverview of page one, every used channel checked. */
function serverOn(rows: readonly Withdrawal[], page: readonly Withdrawal[]): Server {
  const view = ampleOverview(page);
  const used = new Set(page.map((one) => one.payout_channel));
  expect(used.has('bank_card'), 'fixture: page one holds bank card rows').toBe(true);
  for (const channel of used) {
    const found = view.channels.filter((one) => one.channel === channel);
    expect(found, `fixture: one overview channel ${channel}`).toHaveLength(1);
    const one = found[0]!;
    expect([one.enabled, one.paused], `fixture: ${channel} open, not paused`).toEqual([
      true,
      false,
    ]);
    expect(one.water_level, `fixture: ${channel} W fresh`).toBe('normal');
    const batch = page.reduce((total, item) => total + item.net_fen, 0);
    expect(
      one.watermark!.available_fen >= 10 * batch,
      `fixture: ${channel} W far above the batch`,
    ).toBe(true);
  }
  expect([view.payout_enabled, view.queue_paused], 'fixture: payout on, queue running').toEqual([
    true,
    false,
  ]);
  return serverFor(rows, { overview: view });
}

/** Every pre-check of the confirmation is met (the fixture is a batch that really runs). */
function allMet(modal: HTMLElement, where: string): void {
  expect(shows(modal, '（未满足）'), `${where}: no unmet pre-check`).toBe(false);
}

it(
  '[AC-F1-08anb-AMOUNT#1] 服务端 30 张待执行单（total=30），列表第 1 页 20 张、实付合计恰 ¥20,000.00：逐张勾选与【一键组批】各一次，都只选中这 20 张；一次确认 + 一次动态码 → 恰 1 笔 POST，withdrawal_ids 恰为这 20 张、按列表顺序；确认里本次合计 ¥20,000.00；页面上没有「需他人批准」「第二人」类提示；除这 1 笔外没有别的写请求',
  { timeout: 300_000 },
  async () => {
    for (const how of ['tick', 'group'] as const) {
      const rows = thirty();
      const page = rows.slice(0, PER_PAGE);
      const ids = page.map((one) => one.withdrawal_id);
      const numbers = rows.map((one) => one.out_biz_no);
      expect(sumOf(page), 'fixture: page one sums to ¥20,000').toBe(parseFen(BATCH_TOTAL_FEN));

      const server = serverOn(rows, page);
      server.once('POST', '/admin/v1/payout-batches', () => executedReply(server, ids));
      await mount(server, EXECUTOR);
      const read = server.log.find(isTableRead);
      expect(read?.query['page_size'], `${how}: pages of 20`).toBe(String(PER_PAGE));
      expect(shows(main(), '共 30 条'), `${how}: total=30`).toBe(true);
      expect(numbersIn(main(), numbers), `${how}: page one holds the 20 newest`).toEqual(
        page.map((one) => one.out_biz_no),
      );

      if (how === 'tick') await select(page);
      else {
        await click(button(main(), NAME.group));
        await settled(server);
        expect(server.writes(), `${how}: 一键组批 sends nothing`).toEqual([]);
      }
      expect(ticked(), `${how}: the 20 rows of the page ticked`).toHaveLength(PER_PAGE);
      noSecondPerson(`${how} ticked`);

      const modal = await openBatch(server);
      expect(numbersIn(modal, numbers), `${how}: the batch in list order`).toEqual(
        page.map((one) => one.out_biz_no),
      );
      const view = server.view.current;
      await waitFor(() =>
        expect(shows(modal, '单日限额余量'), `${how}: the checks read`).toBe(true),
      );
      allMet(modal, how);
      const left = subFen(parseFen(view.daily_cap_fen), parseFen(view.daily_sent_fen));
      const total = parseFen(BATCH_TOTAL_FEN);
      const daily = check(
        '单日限额余量',
        `${formatYuanAdmin(left)}，本次合计 ${formatYuanAdmin(total)}`,
        total <= left,
      );
      expect(shows(modal, daily), `${how}: ${daily}`).toBe(true);
      noSecondPerson(`${how} confirmation`);

      await confirm(server, modal);
      await verify();
      await waitFor(() => expect(writes(server)).toHaveLength(1));
      await settled(server);
      expect(server.requests('POST', VERIFY), `${how}: one dynamic code`).toHaveLength(1);
      expect(writes(server), `${how}: one batch write`).toHaveLength(1);
      assertBatch(server, 0, ids);
      expect(writeLines(server), `${how}: nothing else written`).toEqual(ONE_BATCH);
      await waitFor(() => expect(shows(modal, TEXT.paying)).toBe(true));
      noSecondPerson(`${how} result`);
      cleanup();
    }
  },
);

/** Just over the example: ¥20,000.01 (fen). */
const OVER_TOTAL_FEN = 2_000_001;
/** The row (0-based, on page one) that carries the one extra fen. */
const ONE_MORE = 7;

/** As thirty(), with row ONE_MORE one fen more: page one sums to ¥20,000.01. */
function thirtyOver(): Withdrawal[] {
  const rows = thirty();
  const base = rows[ONE_MORE]!;
  rows[ONE_MORE] = row(ONE_MORE + 1, 'APPROVED', base.net_fen + 1, base.payout_channel);
  return rows;
}

it(
  '[AC-F1-08anb-AMOUNT#2] 边界：服务端 30 张待执行单（total=30），列表第 1 页 20 张、实付合计 2,000,001 分（其中一张多 1 分）：逐张勾选与【一键组批】各一次，都只选中这 20 张；同样一次确认 + 一次动态码 → 恰 1 笔 POST，withdrawal_ids 恰为这 20 张、按列表顺序；确认里本次合计 ¥20,000.01；页面上没有「需他人批准」「第二人」类提示；除这 1 笔外没有别的写请求',
  { timeout: 300_000 },
  async () => {
    for (const how of ['tick', 'group'] as const) {
      const rows = thirtyOver();
      const page = rows.slice(0, PER_PAGE);
      const ids = page.map((one) => one.withdrawal_id);
      const numbers = rows.map((one) => one.out_biz_no);
      expect(sumOf(page), 'fixture: page one sums to ¥20,000.01').toBe(parseFen(OVER_TOTAL_FEN));
      expect(page[ONE_MORE]!.net_fen, 'fixture: the one row one fen more').toBe(100_001);

      const server = serverOn(rows, page);
      server.once('POST', '/admin/v1/payout-batches', () => executedReply(server, ids));
      await mount(server, EXECUTOR);
      const read = server.log.find(isTableRead);
      expect(read?.query['page_size'], `${how}: pages of 20`).toBe(String(PER_PAGE));
      expect(shows(main(), '共 30 条'), `${how}: total=30`).toBe(true);
      expect(numbersIn(main(), numbers), `${how}: page one holds the 20 newest`).toEqual(
        page.map((one) => one.out_biz_no),
      );

      if (how === 'tick') await select(page);
      else {
        await click(button(main(), NAME.group));
        await settled(server);
        expect(server.writes(), `${how}: 一键组批 sends nothing`).toEqual([]);
      }
      expect(ticked(), `${how}: the 20 rows of the page ticked`).toHaveLength(PER_PAGE);
      noSecondPerson(`${how} ticked`);

      const modal = await openBatch(server);
      expect(numbersIn(modal, numbers), `${how}: the batch in list order`).toEqual(
        page.map((one) => one.out_biz_no),
      );
      const view = server.view.current;
      await waitFor(() =>
        expect(shows(modal, '单日限额余量'), `${how}: the checks read`).toBe(true),
      );
      allMet(modal, how);
      const left = subFen(parseFen(view.daily_cap_fen), parseFen(view.daily_sent_fen));
      const total = parseFen(OVER_TOTAL_FEN);
      const daily = check(
        '单日限额余量',
        `${formatYuanAdmin(left)}，本次合计 ${formatYuanAdmin(total)}`,
        total <= left,
      );
      expect(shows(modal, daily), `${how}: ${daily}`).toBe(true);
      noSecondPerson(`${how} confirmation`);

      await confirm(server, modal);
      await verify();
      await waitFor(() => expect(writes(server)).toHaveLength(1));
      await settled(server);
      expect(server.requests('POST', VERIFY), `${how}: one dynamic code`).toHaveLength(1);
      expect(writes(server), `${how}: one batch write`).toHaveLength(1);
      assertBatch(server, 0, ids);
      expect(writeLines(server), `${how}: nothing else written`).toEqual(ONE_BATCH);
      await waitFor(() => expect(shows(modal, TEXT.paying)).toBe(true));
      noSecondPerson(`${how} result`);
      cleanup();
    }
  },
);
