// @vitest-environment jsdom
// F1-08fe ① 余额流水「关联单据」：流水表的业务单号按 AdminLedgerEntry.link（type + id）做成链接，跳现有的
// 后台页；link 为 null 时保持纯文字；单元格文字不变（仍是凭证 biz_id）。只加导航：不发写请求。
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  CLAWED,
  ENTRIES,
  FROZE,
  LEDGER as LEDGER_PATH,
  SUPER,
  UID,
  createServer,
  ok,
  rowShown,
} from '../admin-ledger-readonly/fixtures.ts';
import {
  ADJUSTMENTS,
  LINKED_ADJUSTMENT,
  LINKED_ENTRIES,
  PAGE,
  WITHDRAWALS,
  WRITEOFFS,
} from './fixtures.ts';
import {
  bizLink,
  bizLinks,
  click,
  landedOn,
  mountLedger,
  nonGets,
  queryUser,
  selectedTab,
  settle,
  tableRows,
  waitGet,
} from './ledger-helpers.ts';

const FLOW = { timeout: 90_000 };

it(
  '[AC-F1-08fe-LINK#1] 有 link 的行，业务单号单元格恰有一个链接、文字是凭证 biz_id；link 为 null 的行（邀请奖励）没有链接；各行文字与原来逐格相同',
  FLOW,
  async () => {
    const server = createServer();
    await mountLedger(server, SUPER);
    await queryUser(server, UID);
    expect(tableRows()).toEqual(ENTRIES.map(rowShown));
    ENTRIES.forEach((entry, index) => {
      expect(bizLinks(index), `row ${entry.entry_id}`).toEqual(
        entry.link === null ? [] : [entry.voucher.biz_id],
      );
    });
    expect(nonGets(server)).toEqual([]);
  },
);

it(
  '[AC-F1-08fe-LINK#2] 提现单的链接进该提现单详情：地址 /withdrawals/{withdrawal_id}，读该提现单（GET /admin/v1/withdrawals/{id}），不发写请求',
  FLOW,
  async () => {
    const server = createServer();
    await mountLedger(server, SUPER);
    await queryUser(server, UID);
    const id = FROZE.link!.id;
    await click(bizLink(ENTRIES.indexOf(FROZE)));
    await settle();
    await landedOn(`/withdrawals/${id}`);
    await waitGet(server, `${WITHDRAWALS}/${id}`);
    expect(nonGets(server)).toEqual([]);
  },
);

it('[AC-F1-08fe-LINK#3] 订单的链接进订单页（/orders…），不发写请求', FLOW, async () => {
  const server = createServer();
  await mountLedger(server, SUPER);
  await queryUser(server, UID);
  await click(bizLink(ENTRIES.indexOf(CLAWED)));
  await settle();
  await waitForPath((path) => path === '/orders' || path.startsWith('/orders/'));
  expect(nonGets(server)).toEqual([]);
});

it(
  '[AC-F1-08fe-LINK#4] 调账单的链接进调账与核销并打开该调账单详情：地址 /adjustments，读 GET /admin/v1/adjustments/{adjust_id}，不发写请求',
  FLOW,
  async () => {
    const server = createServer();
    server.always('GET', LEDGER_PATH, () =>
      ok({ items: LINKED_ENTRIES, page: 1, page_size: 20, total: LINKED_ENTRIES.length }),
    );
    await mountLedger(server, SUPER);
    await queryUser(server, UID);
    expect(bizLinks(0)).toEqual([LINKED_ADJUSTMENT]);
    await click(bizLink(0));
    await settle();
    await landedOn('/adjustments');
    await waitGet(server, `${ADJUSTMENTS}/${LINKED_ADJUSTMENT}`);
    expect(nonGets(server)).toEqual([]);
  },
);

it(
  '[AC-F1-08fe-LINK#5] 核销候选单的链接进调账与核销的「坏账核销」页签：地址 /adjustments，该页签选中并读候选单列表，不发写请求',
  FLOW,
  async () => {
    const server = createServer();
    server.always('GET', LEDGER_PATH, () =>
      ok({ items: LINKED_ENTRIES, page: 1, page_size: 20, total: LINKED_ENTRIES.length }),
    );
    await mountLedger(server, SUPER);
    await queryUser(server, UID);
    await click(bizLink(1));
    await settle();
    await landedOn('/adjustments');
    await waitGet(server, WRITEOFFS);
    expect(selectedTab()?.startsWith(PAGE.writeoffsTab)).toBe(true);
    expect(nonGets(server)).toEqual([]);
  },
);

async function waitForPath(test: (path: string) => boolean): Promise<void> {
  await waitFor(() => expect(test(window.location.pathname), window.location.pathname).toBe(true));
}
