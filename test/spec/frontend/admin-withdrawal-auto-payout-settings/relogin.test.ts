// @vitest-environment jsdom
// F1-08ap (D10-2075 / D10-2061, as F1-08at): a save of 「自动到账设置」 in the result-unknown state
// keeps the marker of components/unknown-marker — exactly one stored item whose whole value is
// {page: withdrawals, unknown: true, at} (no key, value, version, amount, step-up pass or request
// body); a retry answered 10001 ends the session; signing in again as the same account lands on
// 提现审核 with 「有一笔提交结果未知，请先到列表核对」 on top of the page, nothing resent by itself;
// 【关闭】 removes the prompt and the marker. The conventions are those of
// admin-unknown-relogin-marker/helpers.ts (its exported helpers only).
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BASE_URL, LIST } from '../admin-payouts-readonly/fixtures.ts';
import { panelOf, selectTab } from '../admin-payouts-readonly/helpers.ts';
import {
  ADMIN_ID,
  LATER,
  accountOf as consoleAccount,
  banners,
  closeBanner,
  createConsole,
  expectBanner,
  expectMarker,
  expectNothingStored,
  loggedOut,
  moveClock,
  noticeShown,
  passStepUpsUntil,
  readSince,
  settle as markerSettle,
  startClock,
  takeBaseline,
} from '../admin-unknown-relogin-marker/helpers.ts';
import {
  KEY,
  LABEL,
  NOTICE,
  RETRY,
  SUPER,
  TAB,
  allowedHereToo,
  dropped,
  failedWith,
  passOf,
  rowOf,
  scriptBatch,
  serverFor,
  type PayoutServer,
} from './fixtures.ts';
import {
  batches,
  click,
  input,
  itemReads,
  main,
  markedInvalid,
  pageTabNames,
  passUntilSent,
  save,
  settled,
  shows,
  stepDialogs,
  typeInto,
  usable,
  verify,
} from './helpers.ts';

/** The stored marker's page: the menu id of 提现审核. */
const PAGE = 'withdrawals';
const FIRST = consoleAccount('finance-jia', ADMIN_ID.first, SUPER);
const SECOND = consoleAccount('finance-yi', ADMIN_ID.second, SUPER);

/** 提现审核 is shown with its tabs, and its list was read after the first `since` requests. */
async function ready(server: PayoutServer, since: number): Promise<void> {
  await waitFor(() => expect(readSince(server.log, since, LIST)).toBe(true));
  await waitFor(() => expect(pageTabNames()).toContain(TAB.auto));
  await settled(server);
}

/** Opens 「自动到账设置」 and waits until its amount input shows. */
async function openTab(server: PayoutServer): Promise<HTMLElement> {
  const panel = await panelOf(await selectTab(main(), TAB.auto));
  await waitFor(() => expect(itemReads(server).length).toBeGreaterThan(0));
  await settled(server);
  await waitFor(() => input(panel, LABEL.maxAmount));
  return panel;
}

it(
  '[AC-F1-08ap-RELOGIN#1] 自动到账设置：保存连接中断 → 结果未知，只存一项标记，整个值等于 {page: withdrawals, unknown: true, at: 发生时刻}（不含配置键、值、版本、动态码凭证、请求体）；【原样重试】收到 10001 走全局重新登录、标记仍在；同一账号重新登录回到提现审核页，页面顶部提示「有一笔提交结果未知，请先到列表核对」与发生时刻、只有一个【关闭】按钮；不自动重发；【关闭】后消失并清掉',
  { timeout: 240_000 },
  async () => {
    startClock();
    const server = serverFor();
    const accounts = [FIRST, SECOND];
    const app = createConsole({ baseUrl: BASE_URL, fetch: server.fetch, accounts });
    await app.signIn(FIRST);
    await app.render(PAGE);
    await ready(server, 0);
    takeBaseline();

    const panel = await openTab(server);
    scriptBatch(server, () => dropped());
    await typeInto(panel, LABEL.maxAmount, '300');
    await save(server, panel);
    await shows(panel, NOTICE.unknown);
    await settled(server);
    const business = [
      KEY.maxAmount,
      'max_amount_fen',
      '30000',
      passOf(1),
      JSON.stringify(batches(server)[0]!.body),
    ];
    expectMarker(PAGE, business);

    moveClock(LATER);
    scriptBatch(server, () => failedWith(10001, undefined, '未登录'));
    await click(usable(panel, RETRY));
    await passStepUpsUntil(loggedOut, () => stepDialogs().length === 1, verify);
    await settled(server);
    expectMarker(PAGE, business);
    const sent = batches(server).length;
    expect(sent, 'the save and its retry').toBe(2);

    const since = server.log.length;
    await app.loginWith(FIRST);
    await ready(server, since);
    await expectBanner(business);
    expect(stepDialogs(), 'nothing asked for by itself').toEqual([]);
    expect(batches(server), 'nothing is resent by itself').toHaveLength(sent);
    expectMarker(PAGE, business);

    await closeBanner();
    expectNothingStored();
    expect(batches(server)).toHaveLength(sent);
    const others = server.log.filter((request) => !allowedHereToo(request));
    const named = others.map((request) => `${request.method} ${request.path}`);
    expect(named, 'only the allowed reads, the verification and the config batch').toEqual([]);
  },
);

/**
 * Signed in as FIRST through the real guard: a save is dropped (marker kept), then 【原样重试】 gets
 * `answer` (undefined: the contract's answer, a success) and settles the result; the marker is gone
 * by itself. After the session ends and FIRST signs in again, no prompt shows and nothing is sent.
 */
async function settledByRetry(
  answer: ((server: PayoutServer) => void) | undefined,
  check: (server: PayoutServer, panel: HTMLElement) => Promise<void>,
): Promise<void> {
  startClock();
  const server = serverFor();
  const app = createConsole({ baseUrl: BASE_URL, fetch: server.fetch, accounts: [FIRST, SECOND] });
  await app.signIn(FIRST);
  await app.render(PAGE);
  await ready(server, 0);
  takeBaseline();

  const panel = await openTab(server);
  scriptBatch(server, () => dropped());
  await typeInto(panel, LABEL.maxAmount, '300');
  await save(server, panel);
  await shows(panel, NOTICE.unknown);
  await settled(server);
  const business = [KEY.maxAmount, 'max_amount_fen', '30000', passOf(1)];
  expectMarker(PAGE, business);

  if (answer !== undefined) answer(server);
  const before = batches(server).length;
  await click(usable(panel, RETRY));
  await passUntilSent(server, before);
  await check(server, panel);
  await waitFor(() => expectNothingStored());
  const sent = batches(server).length;

  moveClock(LATER);
  await app.expire();
  const since = server.log.length;
  await app.loginWith(FIRST);
  await ready(server, since);
  await markerSettle();
  expect(banners(), 'no prompt for a settled result').toEqual([]);
  expect(noticeShown(), 'no prompt anywhere').toBe(false);
  expectNothingStored();
  expect(stepDialogs(), 'nothing asked for by itself').toEqual([]);
  expect(batches(server), 'nothing is resent by itself').toHaveLength(sent);
}

it(
  '[AC-F1-08ap-RELOGIN#2] 自动到账设置（真实登录外壳）：保存连接中断 → 结果未知、存标记；【原样重试】成功：标记随确定结果清除；会话结束后同一账号重新登录，不再出现「有一笔提交结果未知」提示、不自动重发',
  { timeout: 240_000 },
  async () => {
    await settledByRetry(undefined, async (server, panel) => {
      await shows(panel, NOTICE.saved);
      expect(rowOf(server, KEY.maxAmount).value).toBe(30000);
    });
  },
);

it(
  '[AC-F1-08ap-RELOGIN#3] 自动到账设置（真实登录外壳）：保存连接中断 → 结果未知、存标记；【原样重试】收到 20001 [max_amount_fen]（确定拒绝）：解锁并标出金额上限，标记随之清除；同一账号重新登录不再出现提示、不自动重发',
  { timeout: 240_000 },
  async () => {
    await settledByRetry(
      (server) => scriptBatch(server, () => failedWith(20001, { fields: [KEY.maxAmount] })),
      async (server, panel) => {
        await settled(server);
        await waitFor(() => expect(markedInvalid(panel, LABEL.maxAmount)).toBe(true));
        expect(rowOf(server, KEY.maxAmount).value, 'nothing was written').toBe(25050);
      },
    );
  },
);
