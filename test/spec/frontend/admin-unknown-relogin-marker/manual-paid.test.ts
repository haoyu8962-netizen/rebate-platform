// @vitest-environment jsdom
// F1-08at（FU-ADMIN-UNKNOWN-ON-RELOGIN，编排 D10-2075 / D10-2061）：批量手动打款（提现审核页的 ManualPaid 对话框，
// BR-WDR-16、BR-ID-34 动态码档）一旦进入「上次提交结果未知」，【重试】收到 10001（会话失效）就走全局重新登录，
// 对话框卸载、键与请求体丢失。本单只补一个不含业务数据的标记（页面、有一笔结果未知、发生时刻），重新登录回到
// 提现审核页时在页面顶部提示「有一笔提交结果未知，请先到列表核对」（含发生时刻），手动关闭后清掉；不自动重试、
// 不恢复表单；同一会话内正常解除时也清掉；换另一个账号登录看不到。约定见 ./helpers.ts 开头。
import { formatFen, parseFen } from '@couli/money';
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BASE_URL, LIST } from '../admin-withdrawals/fixtures.ts';
import {
  GRANTS,
  MANUAL,
  approvedRows,
  confirm,
  dialogs,
  failure,
  fillRows,
  main,
  notice,
  open,
  paid,
  reply,
  retry,
  rowsOf,
  select,
  serverFor,
  settled,
  unknown,
  verify,
  writes,
  type Server,
  type Withdrawal,
} from '../admin-withdrawal-manual-paid/helpers.ts';
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
  noticeShown,
  readSince,
  settle,
  startClock,
  takeBaseline,
  type Console,
} from './helpers.ts';

/** The stored marker's page: the menu id of 提现审核. */
const PAGE = 'withdrawals';
const FIRST = accountOf('finance-jia', ADMIN_ID.first, GRANTS);
const SECOND = accountOf('finance-yi', ADMIN_ID.second, GRANTS);

/**
 * 提现审核 is shown and its list was read after the first `since` requests: the list row of the
 * first withdrawal is on the page (as the frozen manual-paid `mount()` waits). 【批量手动打款】 only
 * appears once an APPROVED row is ticked (frozen selection.test.ts / flow.test.ts), so it is not
 * waited for here.
 */
async function ready(server: Server, since: number): Promise<void> {
  await waitFor(() => expect(readSince(server.log, since, LIST)).toBe(true));
  await waitFor(() => expect(rowsOf(main(), server.state[0]!.out_biz_no)).toHaveLength(1));
  await settled(server);
}

/** 提现审核 signed in as FIRST over the APPROVED `rows`, before anything is stored. */
async function begin(rows: readonly Withdrawal[]): Promise<{ server: Server; app: Console }> {
  startClock();
  const server = serverFor([...rows]);
  const app = createConsole({ baseUrl: BASE_URL, fetch: server.fetch, accounts: [FIRST, SECOND] });
  await app.signIn(FIRST);
  await app.render(PAGE);
  await ready(server, 0);
  await waitFor(() => expect(rowsOf(main(), rows[0]!.out_biz_no)).toHaveLength(1));
  takeBaseline();
  return { server, app };
}

/**
 * Ticks `rows`, fills the batch, confirms with the dynamic code; the write never reaches the
 * service and its reply is lost: the dialog is in the result-unknown state (frozen F1-08as).
 */
async function enterUnknown(server: Server, rows: readonly Withdrawal[]): Promise<HTMLElement> {
  server.once('POST', MANUAL, () => {
    throw new Error('response lost');
  });
  await select(rows);
  const modal = await open();
  await fillRows(modal, rows);
  await confirm(server, modal);
  await verify();
  await settled(server);
  await unknown(modal);
  return modal;
}

/** Everything of the submission that must never be kept or shown by this task. */
function businessOf(server: Server, rows: readonly Withdrawal[]): string[] {
  const first = writes(server)[0]!;
  return [
    first.headers.get('Idempotency-Key') ?? '',
    server.rawBodies[0] ?? '',
    'Serial-1-Aa',
    'Serial-2-Aa',
    ...rows.flatMap((row) => [
      row.out_biz_no,
      row.withdrawal_id,
      row.user.user_id,
      formatFen(parseFen(row.net_fen)),
    ]),
  ];
}

/** 【重试】 with the dynamic code; the write is answered 10001: the login page replaces the page. */
async function expireOnRetry(server: Server, modal: HTMLElement): Promise<void> {
  server.once('POST', MANUAL, () => failure(10001, undefined));
  await retry(server, modal);
  await waitFor(() => expect(loggedOut()).toBe(true));
  expect(dialogs()).toEqual([]);
}

it(
  '[AC-F1-08at-MANUAL#1] 批量手动打款：结果未知时只存一项标记，整个值等于 {page: withdrawals, unknown: true, at: 发生时刻}（不含单号、金额、流水号、用户、幂等键、请求体）；【重试】收到 10001 走全局重新登录后标记仍在；同一账号重新登录回到提现审核页，页面顶部提示「有一笔提交结果未知，请先到列表核对」并显示发生时刻 2026-11-18 12:00:00（不是重新登录时刻）、提示条只有一个【关闭】按钮且无无角色的点击 / 按键处理；不自动重试（不再发写）、不恢复对话框；按【关闭】后提示消失、存储清掉，再刷新不再出现',
  { timeout: 240_000 },
  async () => {
    const rows = approvedRows(2);
    const { server, app } = await begin(rows);
    const modal = await enterUnknown(server, rows);
    const business = businessOf(server, rows);
    expectMarker(PAGE, business);

    moveClock(LATER);
    await expireOnRetry(server, modal);
    expectMarker(PAGE, business);
    const sent = writes(server).length;
    expect(sent).toBe(2);

    let since = server.log.length;
    await app.loginWith(FIRST);
    await ready(server, since);
    await expectBanner(business);
    expect(dialogs(), 'the form is not restored').toEqual([]);
    expect(writes(server), 'nothing is resent by itself').toHaveLength(sent);
    expectMarker(PAGE, business);

    await closeBanner();
    expectNothingStored();
    expect(writes(server)).toHaveLength(sent);

    cleanup();
    since = server.log.length;
    await app.render(PAGE);
    await ready(server, since);
    await settle();
    expect(noticeShown()).toBe(false);
    expectNothingStored();
    expect(writes(server)).toHaveLength(sent);
  },
);

it(
  '[AC-F1-08at-MANUAL#2] 批量手动打款：结果未知（已存标记）后同一会话内【重试】原键原体拿到确定结果「已录入 2 张，跳过 0 张」→ 标记清掉；之后会话过期、同一账号重新登录回到提现审核页，不出现「有一笔提交结果未知，请先到列表核对」',
  { timeout: 240_000 },
  async () => {
    const rows = approvedRows(2);
    const { server, app } = await begin(rows);
    const modal = await enterUnknown(server, rows);
    expectMarker(PAGE, businessOf(server, rows));

    server.once('POST', MANUAL, () => reply(server, paid(rows)));
    await retry(server, modal);
    await notice('已录入 2 张，跳过 0 张', modal);
    await settled(server);
    await waitFor(() => expectNothingStored());

    moveClock(LATER);
    await app.expire();
    const since = server.log.length;
    await app.loginWith(FIRST);
    await ready(server, since);
    await settle();
    expect(noticeShown()).toBe(false);
    expectNothingStored();
    expect(writes(server)).toHaveLength(2);
  },
);

it(
  '[AC-F1-08at-MANUAL#3] 批量手动打款：结果未知（已存标记）后【重试】收到 10001 走全局重新登录；换另一个账号登录（同样的权限，落到提现审核页）看不到「有一笔提交结果未知，请先到列表核对」，也不发任何写',
  { timeout: 240_000 },
  async () => {
    const rows = approvedRows(2);
    const { server, app } = await begin(rows);
    const modal = await enterUnknown(server, rows);
    expectMarker(PAGE, businessOf(server, rows));

    moveClock(LATER);
    await expireOnRetry(server, modal);
    const since = server.log.length;
    await app.loginWith(SECOND);
    expect(app.current()).toBe(SECOND);
    await ready(server, since);
    await settle();
    expect(noticeShown()).toBe(false);
    expect(dialogs()).toEqual([]);
    expect(writes(server)).toHaveLength(2);
  },
);
