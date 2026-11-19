// @vitest-environment jsdom
// F1-08fe ② 核销成功提示加【查看凭证】（只在真的记了 BAD_DEBT_WRITEOFF 凭证、候选单 APPROVED 时；CANCELLED
// 不写凭证，没有该入口），跳余额流水并预填该用户与候选单号（凭证 biz_id，BR-FUND-12 / BR-FUND-16）；
// ③ 批准核销被拦（20001 data.reason=writeoff_frozen_pending）时拦截提示加【去处理提现单】：拒绝回答里
// 没有提现单号，链到提现审核列表并带上该用户筛选。只加导航：不新增写操作、不改写请求。
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ALL_FUND,
  SUPER_ADMIN,
  TEXT,
  USER,
  WO,
  createWriteoffServer,
  yuan,
  type WriteoffServer,
} from '../admin-writeoff-approve/fixtures.ts';
import {
  approveDialog,
  approveWithSms,
  button,
  buttons,
  click,
  dialogsTitled,
  hasText,
  openApprove,
  ready,
  settle,
  settled,
  shows,
} from '../admin-writeoff-approve/helpers.ts';
import { COPY, LEDGER, PAGE, PAGE_SIZE, WITHDRAWALS } from './fixtures.ts';
import { inputValue, noticeWith, readsOf, waitTitle, writesSince } from './page-helpers.ts';

const FLOW = { timeout: 150_000 };

function userOf(server: WriteoffServer, id: string): string {
  const found = server.candidates.find((candidate) => candidate.id === id);
  expect(found, `candidate ${id}`).toBeDefined();
  return found!.user_id;
}

it(
  '[AC-F1-08fe-VOUCHER#3] 核销成功（APPROVED）提示里有【查看凭证】，已取消（CANCELLED，未记坏账）的提示里没有；点开进余额流水，「用户 UID」为候选单的用户，流水按 user_id + ref=候选单号读第 1 页；不再发写请求',
  FLOW,
  async () => {
    const server = createWriteoffServer({ permissions: ALL_FUND });
    await ready(server, SUPER_ADMIN);

    // The member of WO.blocked is back at or above 0 with nothing frozen: CANCELLED, no voucher.
    server.setBalance(userOf(server, WO.blocked), 500, 0);
    await approveWithSms(server, await openApprove(server, WO.blocked));
    const cancelled = TEXT.cancelled(WO.blocked);
    await waitFor(() => expect(shows(cancelled)).toBe(true));
    expect(buttons(noticeWith(cancelled), COPY.viewVoucher)).toEqual([]);

    // WO.recent (available −300): APPROVED, BAD_DEBT_WRITEOFF written under biz_id WO.recent.
    const user = userOf(server, WO.recent);
    expect(user).toBe(USER.negative);
    await approveWithSms(server, await openApprove(server, WO.recent));
    const approved = TEXT.approved(WO.recent, yuan(300));
    await waitFor(() => expect(shows(approved)).toBe(true));

    const since = server.log.length;
    await click(button(noticeWith(approved), COPY.viewVoucher));
    await settle();
    await waitTitle(PAGE.ledgerTitle);
    await waitFor(() => expect(readsOf(server, LEDGER, since).length).toBeGreaterThan(0));
    await settled(server);
    expect(readsOf(server, LEDGER, since)).toEqual([
      { user_id: user, ref: WO.recent, page: '1', page_size: PAGE_SIZE },
    ]);
    expect(inputValue(PAGE.uidLabel)).toBe(user);
    expect(inputValue(PAGE.refLabel)).toBe(WO.recent);
    expect(writesSince(server, since)).toEqual([]);
    expect(server.approvals()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08fe-INTERCEPT#1] 批准核销被拦（writeoff_frozen_pending）：拦截提示旁有【去处理提现单】；点开关对话框进提现审核，「用户 ID」预填候选单的用户，列表第一次读恰为 {page: 1, page_size: 20, user_id}；不重发批准、不发任何写请求',
  FLOW,
  async () => {
    const server = createWriteoffServer({ permissions: ALL_FUND });
    await ready(server, SUPER_ADMIN);
    const user = userOf(server, WO.recent);
    const dialog = await openApprove(server, WO.recent);
    expect(buttons(dialog, COPY.toWithdrawals), 'nothing intercepted yet').toEqual([]);

    // The member got frozen money after the list was read: the approval is refused.
    server.setBalance(user, -300, 2000);
    await approveWithSms(server, dialog);
    await waitFor(() => expect(hasText(approveDialog(), TEXT.frozenPending)).toBe(true));

    const since = server.log.length;
    await click(button(approveDialog(), COPY.toWithdrawals));
    await settle();
    await waitTitle(PAGE.withdrawalsTitle);
    await waitFor(() => expect(readsOf(server, WITHDRAWALS, since).length).toBeGreaterThan(0));
    await settled(server);
    expect(dialogsTitled(TEXT.title)).toEqual([]);
    expect(readsOf(server, WITHDRAWALS, since)[0]).toEqual({
      page: '1',
      page_size: PAGE_SIZE,
      user_id: user,
    });
    expect(inputValue(PAGE.withdrawalUserLabel)).toBe(user);
    expect(writesSince(server, since)).toEqual([]);
    expect(server.approvals()).toHaveLength(1);
  },
);
