// @vitest-environment jsdom
// F1-08at（FU-ADMIN-UNKNOWN-ON-RELOGIN，编排 D10-2075 / D10-2061）：「批准调账单」对话框（系统预填单，
// adminApproveAdjustment 短信档 / adminRejectAdjustment 不验证，BR-FUND-24 ①⑧）的批准或驳回一旦进入「上次提交
// 结果未知」，再按同一个决定收到 10001（会话失效）就走全局重新登录，对话框卸载、键与请求体丢失。本单只补一个
// 不含业务数据的标记（页面、有一笔结果未知、发生时刻），重新登录回到调账与核销页时在页面顶部提示「有一笔提交
// 结果未知，请先到列表核对」（含发生时刻），手动关闭后清掉；不自动重试、不恢复对话框。约定见 ./helpers.ts 开头。
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BASE_URL, MENU_ID } from '../admin-adjustments-readonly/fixtures.ts';
import {
  ADJ,
  ADJUSTER,
  ADJUSTMENTS,
  ADJUSTMENT_ORDER,
  COLUMN,
  REASON,
  TEXT,
  USER,
  approvePath,
  createApproveServer,
  failure,
  networkDown,
  rejectPath,
  type ApproveServer,
} from '../admin-adjustment-approve/fixtures.ts';
import {
  approveWithSms,
  dialogsTitled,
  hasText,
  openApprove,
  pressApprove,
  pressReject,
  refreshedAfter,
  rowOf,
  settled,
  typeReason,
  usable,
  verifySms,
  waitColumn,
} from '../admin-adjustment-approve/helpers.ts';
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
  type Console,
} from './helpers.ts';

/** The stored marker's page: the menu id of 调账与核销. */
const PAGE = MENU_ID;
const FIRST = accountOf('finance-jia', ADMIN_ID.first, ADJUSTER);
const SECOND = accountOf('finance-yi', ADMIN_ID.second, ADJUSTER);
/** texts/adjustments.ts approve.unknown (frozen F1-08as): a decision got no reply in the envelope. */
const UNKNOWN =
  '上次提交结果未知：可能已经生效。重新读取后仍待批准时，再按同一个决定用原内容原样重新提交（不会重复执行），或按【去列表核对】查看是否已处理。';

/** 调账与核销 is shown and its 调账单 list (unchanged: nothing took effect) read after `since`. */
async function ready(server: ApproveServer, since: number): Promise<void> {
  await waitFor(() => expect(readSince(server.log, since, ADJUSTMENTS)).toBe(true));
  await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
  await settled(server);
}

/** 调账与核销 signed in as FIRST (fund.adjust, sms tier), before anything is stored. */
async function begin(): Promise<{ server: ApproveServer; app: Console }> {
  startClock();
  const server = createApproveServer();
  const app = createConsole({ baseUrl: BASE_URL, fetch: server.fetch, accounts: [FIRST, SECOND] });
  await app.signIn(FIRST);
  await app.render(PAGE);
  await ready(server, 0);
  takeBaseline();
  return { server, app };
}

/** One decision of the dialog: how it gets lost, how it is pressed again. */
interface Decision {
  /** Makes the decision once; it never reaches the service: result unknown, the form PENDING. */
  lose(server: ApproveServer, dialog: HTMLElement): Promise<void>;
  /** Presses the same decision again; it is answered 10001 and the login page shows. */
  expire(server: ApproveServer, dialog: HTMLElement): Promise<void>;
  /** What the submission carried (never kept or shown by this task). */
  readonly values: readonly string[];
  sent(server: ApproveServer): number;
}

function expired(): Response {
  return failure(10001, undefined, '未登录');
}
function smsAsked(): boolean {
  return dialogsTitled('二次验证 · 短信').length === 1;
}

const APPROVE: Decision = {
  async lose(server, dialog) {
    server.once('POST', approvePath(ADJ.prefilled), networkDown);
    const first = await approveWithSms(server, dialog);
    await waitFor(() => expect(refreshedAfter(server, first, ADJ.prefilled)).toBe(true));
    await settled(server);
    await waitFor(() => expect(usable(dialog, TEXT.approve)).toHaveLength(1));
  },
  async expire(server, dialog) {
    server.once('POST', approvePath(ADJ.prefilled), expired);
    await pressApprove(dialog);
    await passStepUpsUntil(loggedOut, smsAsked, () => verifySms(server));
  },
  values: [ADJ.prefilled, USER.deleting],
  sent: (server) => server.approvals().length,
};

const REJECT: Decision = {
  async lose(server, dialog) {
    await typeReason(dialog, REASON);
    server.once('POST', rejectPath(ADJ.prefilled), networkDown);
    await pressReject(dialog);
    await waitFor(() => expect(server.rejections()).toHaveLength(1));
    const first = server.rejections()[0]!;
    await waitFor(() => expect(refreshedAfter(server, first, ADJ.prefilled)).toBe(true));
    await settled(server);
    await waitFor(() => expect(usable(dialog, TEXT.reject)).toHaveLength(1));
  },
  async expire(server, dialog) {
    server.once('POST', rejectPath(ADJ.prefilled), expired);
    await pressReject(dialog);
    await waitFor(() => expect(loggedOut()).toBe(true));
  },
  values: [ADJ.prefilled, USER.deleting, REASON],
  sent: (server) => server.rejections().length,
};

/** The Idempotency-Key of the first decision sent. */
function keyOf(server: ApproveServer): string {
  const first = [...server.approvals(), ...server.rejections()][0];
  return first?.headers.get('Idempotency-Key') ?? '';
}

/**
 * The whole flow of one decision: result unknown → marker → 10001 on the same decision → login
 * page (marker kept) → the same account again → the prompt on top of 调账与核销, nothing resent,
 * no dialog restored, the form still PENDING → 关闭: gone and cleared → refresh: not shown again.
 */
async function promptAfterRelogin(decision: Decision): Promise<void> {
  const { server, app } = await begin();
  const dialog = await openApprove(server, rowOf(ADJ.prefilled));
  await decision.lose(server, dialog);
  expect(hasText(dialog, UNKNOWN), 'the result-unknown notice').toBe(true);
  const business = [keyOf(server), ...decision.values];
  expectMarker(PAGE, business);

  moveClock(LATER);
  await decision.expire(server, dialog);
  await settled(server);
  expect(openDialogs()).toEqual([]);
  expectMarker(PAGE, business);
  const sent = decision.sent(server);
  expect(sent).toBe(2);

  let since = server.log.length;
  await app.loginWith(FIRST);
  await ready(server, since);
  await expectBanner(business);
  expect(openDialogs(), 'the dialog is not restored').toEqual([]);
  expect(decision.sent(server), 'nothing is resent by itself').toBe(sent);
  expect(server.forms.find((form) => form.adjust_id === ADJ.prefilled)?.status).toBe('PENDING');
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
  expect(decision.sent(server)).toBe(sent);
}

it(
  '[AC-F1-08at-APPROVE#1] 批准调账单：批准没拿到带外壳的回答 → 结果未知（重新读取后仍待批准），只存一项标记，整个值等于 {page: adjustments, unknown: true, at: 发生时刻}（不含调账单号、用户、幂等键）；再按【批准并短信验证】短信验证后收到 10001 走全局重新登录、标记仍在；同一账号重新登录回到调账与核销页，页面顶部提示「有一笔提交结果未知，请先到列表核对」与发生时刻 2026-11-18 12:00:00、只有一个【关闭】按钮；不自动重试、不恢复对话框、该单仍待批准；【关闭】后消失并清掉，再刷新不再出现',
  { timeout: 240_000 },
  async () => {
    await promptAfterRelogin(APPROVE);
  },
);

it(
  '[AC-F1-08at-REJECT#1] 驳回调账单：驳回没拿到带外壳的回答 → 结果未知（重新读取后仍待批准），只存一项标记，整个值等于 {page: adjustments, unknown: true, at: 发生时刻}（不含调账单号、用户、驳回原因、幂等键）；再按【驳回】收到 10001 走全局重新登录、标记仍在；同一账号重新登录回到调账与核销页，页面顶部提示「有一笔提交结果未知，请先到列表核对」与发生时刻、只有一个【关闭】按钮；不自动重试、不恢复对话框、该单仍待批准；【关闭】后消失并清掉，再刷新不再出现',
  { timeout: 240_000 },
  async () => {
    await promptAfterRelogin(REJECT);
  },
);
