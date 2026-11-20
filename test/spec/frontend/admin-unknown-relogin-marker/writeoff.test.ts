// @vitest-environment jsdom
// F1-08at（FU-ADMIN-UNKNOWN-ON-RELOGIN，编排 D10-2075 / D10-2061）：「批准坏账核销」对话框
// （adminApproveBadDebtWriteoff 短信档，BR-FUND-12、BR-ID-34）的批准一旦进入「上次提交结果未知」，再按【批准核销】
// 收到 10001（会话失效）就走全局重新登录，对话框卸载、键与请求体丢失。本单只补一个不含业务数据的标记（页面、
// 有一笔结果未知、发生时刻），重新登录回到调账与核销页时在页面顶部提示「有一笔提交结果未知，请先到列表核对」
// （含发生时刻），手动关闭后清掉；不自动重试、不恢复对话框。约定见 ./helpers.ts 开头。
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BASE_URL, MENU_ID } from '../admin-adjustments-readonly/fixtures.ts';
import {
  READ_TEXT,
  WO,
  WRITEOFFER,
  WRITEOFFS,
  WRITEOFF_COLUMN,
  WRITEOFF_ORDER,
  approvePath,
  createWriteoffServer,
  failure,
  networkDown,
  type WriteoffServer,
} from '../admin-writeoff-approve/fixtures.ts';
import {
  approveOpen,
  approveWithSms,
  dialogsTitled,
  hasText,
  openApprove,
  openTab,
  pressApprove,
  refreshedAfter,
  settled,
  verifySms,
  waitColumn,
} from '../admin-writeoff-approve/helpers.ts';
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
  openDialogs,
  passStepUpsUntil,
  readSince,
  settle,
  startClock,
  takeBaseline,
} from './helpers.ts';

/** The stored marker's page: the menu id of 调账与核销. */
const PAGE = MENU_ID;
const FIRST = accountOf('finance-jia', ADMIN_ID.first, WRITEOFFER);
const SECOND = accountOf('finance-yi', ADMIN_ID.second, WRITEOFFER);
/** texts/adjustments.ts writeoffApprove.unknown (frozen F1-08as). */
const UNKNOWN =
  '上次提交结果未知：可能已经生效。重新读取后仍待批准时，再按【批准核销】用原内容原样重新提交（不会重复核销），或按【去列表核对】查看是否已处理。';

/** 调账与核销 is shown on its 坏账核销 tab, the list (unchanged) read after the first `since`. */
async function ready(server: WriteoffServer, since: number): Promise<void> {
  await waitFor(() => expect(readSince(server.log, since, WRITEOFFS)).toBe(true));
  await openTab(READ_TEXT.writeoffsTab);
  await waitColumn(WRITEOFF_COLUMN.id, WRITEOFF_ORDER);
  await settled(server);
}

function smsAsked(): boolean {
  return dialogsTitled('二次验证 · 短信').length === 1;
}

it(
  '[AC-F1-08at-WRITEOFF#1] 批准坏账核销：批准没拿到带外壳的回答 → 结果未知（重新读取列表后仍待批准），只存一项标记，整个值等于 {page: adjustments, unknown: true, at: 发生时刻}（不含候选单号、用户、幂等键）；再按【批准核销】短信验证后收到 10001 走全局重新登录、标记仍在；同一账号重新登录回到调账与核销页，页面顶部提示「有一笔提交结果未知，请先到列表核对」与发生时刻 2026-11-18 12:00:00、只有一个【关闭】按钮；不自动重试、不恢复对话框、候选单仍待批准；【关闭】后消失并清掉，再刷新不再出现',
  { timeout: 240_000 },
  async () => {
    startClock();
    const server = createWriteoffServer();
    const app = createConsole({
      baseUrl: BASE_URL,
      fetch: server.fetch,
      accounts: [FIRST, SECOND],
    });
    await app.signIn(FIRST);
    await app.render(PAGE);
    await ready(server, 0);
    takeBaseline();

    const dialog = await openApprove(server, WO.recent);
    server.once('POST', approvePath(WO.recent), networkDown);
    const first = await approveWithSms(server, dialog);
    await waitFor(() => expect(refreshedAfter(server, first)).toBe(true));
    await settled(server);
    await waitFor(() => expect(approveOpen(dialog)).toBe(true));
    expect(hasText(dialog, UNKNOWN), 'the result-unknown notice').toBe(true);
    const candidate = server.candidates.find((one) => one.id === WO.recent)!;
    const business = [first.headers.get('Idempotency-Key') ?? '', WO.recent, candidate.user_id];
    expectMarker(PAGE, business);

    moveClock(LATER);
    server.once('POST', approvePath(WO.recent), () => failure(10001, undefined, '未登录'));
    await pressApprove(dialog);
    await passStepUpsUntil(loggedOut, smsAsked, () => verifySms(server));
    await settled(server);
    expect(openDialogs()).toEqual([]);
    expectMarker(PAGE, business);
    expect(server.approvals()).toHaveLength(2);

    let since = server.log.length;
    await app.loginWith(FIRST);
    await ready(server, since);
    await expectBanner(business);
    expect(openDialogs(), 'the dialog is not restored').toEqual([]);
    expect(server.approvals(), 'nothing is resent by itself').toHaveLength(2);
    expect(candidate.status).toBe('PENDING');
    expectMarker(PAGE, business);

    await closeBanner();
    expectNothingStored();

    cleanup();
    since = server.log.length;
    await app.render(PAGE);
    await ready(server, since);
    await settle();
    expect(noticeShown()).toBe(false);
    expectNothingStored();
    expect(server.approvals()).toHaveLength(2);
  },
);
