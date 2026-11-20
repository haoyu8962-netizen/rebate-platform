// @vitest-environment jsdom
// F1-08an：【批量自动打款】进入「上次提交结果未知」后会话过期（编排 D10-2075，F1-08at 的同一套标记）：只存一项
// {page: withdrawals, unknown: true, at} 的标记（不含单号、金额、用户、幂等键、请求体）；【重试】收到 10001 走全局
// 重新登录，同一账号重新登录回到提现审核页，页面顶部提示「有一笔提交结果未知，请先到列表核对」与发生时刻；不自动
// 重发、不恢复对话框；按【关闭】后提示与标记都清掉。登录守卫与标记检查沿用 admin-unknown-relogin-marker 的导出
// 帮助函数，提现假服务端与对话框流程见 ./helpers.ts 开头。
import { formatFen, parseFen } from '@couli/money';
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BASE_URL, LIST } from '../admin-withdrawals/fixtures.ts';
import {
  ADMIN_ID,
  LATER,
  accountOf,
  closeBanner,
  createConsole,
  expectBanner,
  expectMarker,
  expectNothingStored,
  loggedOut,
  moveClock,
  readSince,
  startClock,
  takeBaseline,
} from '../admin-unknown-relogin-marker/helpers.ts';
import {
  EXECUTOR,
  approvedRows,
  assertUnknown,
  confirm,
  dialogs,
  failure,
  keyOf,
  main,
  networkDown,
  openBatch,
  retry,
  rowsOf,
  select,
  serverFor,
  settled,
  verify,
  writes,
  type Server,
  type Withdrawal,
} from './helpers.ts';

const BATCHES = '/admin/v1/payout-batches';
/** The stored marker's page: the menu id of 提现审核. */
const PAGE = 'withdrawals';
const FIRST = accountOf('finance-jia', ADMIN_ID.first, EXECUTOR);

/** 提现审核 is shown and its list was read after the first `since` requests. */
async function ready(server: Server, since: number, rows: readonly Withdrawal[]): Promise<void> {
  await waitFor(() => expect(readSince(server.log, since, LIST)).toBe(true));
  await waitFor(() => expect(rowsOf(main(), rows[0]!.out_biz_no)).toHaveLength(1));
  await settled(server);
}

/** Everything of the submission that must never be kept or shown. */
function businessOf(server: Server, rows: readonly Withdrawal[]): string[] {
  return [
    keyOf(writes(server)[0]!) ?? '',
    server.raw[0] ?? '',
    ...rows.flatMap((one) => [
      one.out_biz_no,
      one.withdrawal_id,
      one.user.user_id,
      formatFen(parseFen(one.net_fen)),
    ]),
  ];
}

it(
  '[AC-F1-08an-RELOGIN#1] 批量自动打款结果未知：只存一项标记 {page: withdrawals, unknown: true, at: 发生时刻}（不含单号、金额、用户、幂等键、请求体）；【重试】收到 10001 走全局重新登录后标记仍在；同一账号重新登录回到提现审核页，页面顶部提示「有一笔提交结果未知，请先到列表核对」与发生时刻 2026-11-18 12:00:00，提示条只有【关闭】、无无角色的点击 / 按键处理；不自动重发、不恢复对话框；按【关闭】后提示消失、标记清掉',
  { timeout: 240_000 },
  async () => {
    startClock();
    const rows = approvedRows();
    const server = serverFor(rows);
    const app = createConsole({ baseUrl: BASE_URL, fetch: server.fetch, accounts: [FIRST] });
    await app.signIn(FIRST);
    await app.render(PAGE);
    await ready(server, 0, rows);
    takeBaseline();

    server.once('POST', BATCHES, networkDown);
    await select(rows);
    const modal = await openBatch(server);
    await confirm(server, modal);
    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(1));
    await settled(server);
    await assertUnknown(server, modal);
    const business = businessOf(server, rows);
    expectMarker(PAGE, business);

    moveClock(LATER);
    server.once('POST', BATCHES, () => failure(10001));
    await retry(server, modal);
    await waitFor(() => expect(loggedOut(), 'the login page after 10001').toBe(true));
    expect(dialogs()).toEqual([]);
    expectMarker(PAGE, business);
    const sent = writes(server).length;
    expect(sent).toBe(2);

    const since = server.log.length;
    await app.loginWith(FIRST);
    await ready(server, since, rows);
    await expectBanner(business);
    expect(dialogs(), 'the dialog is not restored').toEqual([]);
    expect(writes(server), 'nothing is resent by itself').toHaveLength(sent);
    expectMarker(PAGE, business);

    await closeBanner();
    expectNothingStored();
    expect(writes(server)).toHaveLength(sent);
  },
);
