// @vitest-environment jsdom
// F1-08at（FU-ADMIN-UNKNOWN-ON-RELOGIN，编排 D10-2075 / D10-2061）：调账页写入层 useAdjustmentWrite 的新建调账与红冲
// （BR-FUND-24 ①⑥、BR-ID-34 短信档）一旦进入「上次提交结果未知」，【重试】收到 10001（会话失效）就走全局重新登录，
// 抽屉 / 对话框卸载、键与请求体丢失。本单只补一个不含业务数据的标记（页面、有一笔结果未知、发生时刻），重新登录
// 回到调账与核销页时在页面顶部提示「有一笔提交结果未知，请先到列表核对」（含发生时刻），手动关闭后清掉；不自动
// 重试、不恢复表单；同一会话内正常解除时也清掉；换另一个账号登录看不到。约定见 ./helpers.ts 开头。
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BASE_URL, MENU_ID } from '../admin-adjustments-readonly/fixtures.ts';
import {
  ADJ,
  ADJUSTER,
  ADJUSTMENTS,
  ADJUSTMENT_ORDER,
  COLUMN,
  DOC,
  LABEL,
  NOTE,
  TEXT,
  USER,
  createWriteServer,
  createdId,
  failure,
  reasonName,
  type WriteServer,
} from '../admin-adjustment-create/fixtures.ts';
import {
  assertUnknown,
  button,
  click,
  createDrawer,
  dialogsTitled,
  fillForm,
  hasText,
  openCreate,
  openReverse,
  panel,
  prompted,
  retryWithSms,
  reverseDialog,
  rowWith,
  settled,
  submitWithSms,
  typeInto,
  verifySms,
  waitColumn,
  type NewForm,
} from '../admin-adjustment-create/helpers.ts';
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
/** The list once the lost write took effect (the new form, or the reversal, lists first). */
const AFTER_WRITE: readonly string[] = [createdId(1), ...ADJUSTMENT_ORDER];

/** A RECON_FIX increase of ¥8.80 for USER.recon (the frozen F1-08as form). */
const INCREASE: NewForm = {
  user: USER.recon,
  direction: '调增',
  amount: '8.80',
  reason: reasonName('RECON_FIX'),
  refs: [['recon_diff', DOC.reconDiff]],
  note: NOTE.reconFix,
  subject: '佣金收入',
};

/** 调账与核销 is shown, its 调账单 list was read after the first `since` requests and reads `order`. */
async function ready(server: WriteServer, since: number, order: readonly string[]): Promise<void> {
  await waitFor(() => expect(readSince(server.log, since, ADJUSTMENTS)).toBe(true));
  await waitColumn(COLUMN.id, order);
  await settled(server);
}

/** 调账与核销 signed in as FIRST (fund.adjust, sms tier), before anything is stored. */
async function begin(): Promise<{ server: WriteServer; app: Console }> {
  startClock();
  const server = createWriteServer();
  const app = createConsole({ baseUrl: BASE_URL, fetch: server.fetch, accounts: [FIRST, SECOND] });
  await app.signIn(FIRST);
  await app.render(PAGE);
  await ready(server, 0, ADJUSTMENT_ORDER);
  takeBaseline();
  return { server, app };
}

/** The new form takes effect, its reply is lost: the drawer is in the result-unknown state. */
async function lostCreate(server: WriteServer): Promise<HTMLElement> {
  const root = await openCreate();
  await fillForm(root, INCREASE);
  server.lose('POST', ADJUSTMENTS);
  await submitWithSms(server, root);
  await waitFor(() => expect(hasText(createDrawer(), TEXT.unknown)).toBe(true));
  assertUnknown(root);
  return root;
}

/** The reversal of ADJ.reconFix takes effect, its reply is lost: the dialog is unknown. */
async function lostReversal(server: WriteServer): Promise<HTMLElement> {
  const dialog = await openReverse(rowWith(panel(), COLUMN.id, ADJ.reconFix).element);
  await typeInto(dialog, LABEL.reverseNote, NOTE.reversal);
  server.lose('POST', ADJUSTMENTS);
  await submitWithSms(server, dialog);
  await waitFor(() => expect(hasText(reverseDialog(), TEXT.unknown)).toBe(true));
  assertUnknown(dialog);
  return dialog;
}

/** Everything of the submission that must never be kept or shown by this task. */
function businessOf(server: WriteServer, values: readonly string[]): string[] {
  const first = server.writes()[0]!;
  return [
    first.headers.get('Idempotency-Key') ?? '',
    server.rawOf(first) ?? '',
    createdId(1),
    ...values,
  ];
}
const CREATE_DATA: readonly string[] = [USER.recon, DOC.reconDiff, NOTE.reconFix, '8.80'];
const REVERSAL_DATA: readonly string[] = [ADJ.reconFix, NOTE.reversal];

function smsAsked(): boolean {
  return dialogsTitled('二次验证 · 短信').length === 1;
}

/**
 * 【重试】 of `root`, passing each sms verification asked for; the write is answered 10001: the
 * login page replaces the page.
 */
async function expireOnRetry(server: WriteServer, root: HTMLElement): Promise<void> {
  server.once('POST', ADJUSTMENTS, () => failure(10001, undefined, '未登录'));
  await click(button(root, TEXT.retry));
  await settle();
  await passStepUpsUntil(loggedOut, smsAsked, () => verifySms(server));
  await settled(server);
  expect(openDialogs()).toEqual([]);
}

/**
 * The whole flow of one entry: result unknown → marker → 10001 on 【重试】 → login page (marker
 * kept) → the same account again → the prompt on top of 调账与核销, nothing resent, no form
 * restored → 关闭: gone and cleared → refresh: not shown again.
 */
async function promptAfterRelogin(
  lost: (server: WriteServer) => Promise<HTMLElement>,
  values: readonly string[],
): Promise<void> {
  const { server, app } = await begin();
  const root = await lost(server);
  const business = businessOf(server, values);
  expectMarker(PAGE, business);

  moveClock(LATER);
  await expireOnRetry(server, root);
  expectMarker(PAGE, business);
  const sent = server.writes().length;

  let since = server.log.length;
  await app.loginWith(FIRST);
  await ready(server, since, AFTER_WRITE);
  await expectBanner(business);
  expect(openDialogs(), 'the form is not restored').toEqual([]);
  expect(server.writes(), 'nothing is resent by itself').toHaveLength(sent);
  expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);
  expectMarker(PAGE, business);

  await closeBanner();
  expectNothingStored();

  cleanup();
  since = server.log.length;
  await app.render(PAGE);
  await ready(server, since, AFTER_WRITE);
  await settle();
  expect(noticeShown()).toBe(false);
  expectNothingStored();
  expect(server.writes()).toHaveLength(sent);
  expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);
}

it(
  '[AC-F1-08at-ADJUST#1] 新建调账：结果未知时只存一项标记，整个值等于 {page: adjustments, unknown: true, at: 发生时刻}（不含调账单号、用户、金额、单据、说明、幂等键、请求体）；【重试】短信验证后收到 10001 走全局重新登录、标记仍在；同一账号重新登录回到调账与核销页，页面顶部提示「有一笔提交结果未知，请先到列表核对」与发生时刻 2026-11-18 12:00:00、只有一个【关闭】按钮、无无角色的点击 / 按键处理；不自动重试、不恢复抽屉；【关闭】后消失并清掉，再刷新不再出现',
  { timeout: 240_000 },
  async () => {
    await promptAfterRelogin(lostCreate, CREATE_DATA);
  },
);

it(
  '[AC-F1-08at-REVERSE#1] 红冲：结果未知时只存一项标记，整个值等于 {page: adjustments, unknown: true, at: 发生时刻}（不含原调账单号、红冲原因、幂等键、请求体）；【重试】短信验证后收到 10001 走全局重新登录、标记仍在；同一账号重新登录回到调账与核销页，页面顶部提示「有一笔提交结果未知，请先到列表核对」与发生时刻、只有一个【关闭】按钮；不自动重试、不恢复对话框；【关闭】后消失并清掉，再刷新不再出现',
  { timeout: 240_000 },
  async () => {
    await promptAfterRelogin(lostReversal, REVERSAL_DATA);
  },
);

it(
  '[AC-F1-08at-ADJUST#2] 新建调账：结果未知（已存标记）后同一会话内【重试】原键原体拿到幂等回放的成功（提示新单号与调账前后余额）→ 标记清掉；之后会话过期、同一账号重新登录回到调账与核销页，不出现「有一笔提交结果未知，请先到列表核对」',
  { timeout: 240_000 },
  async () => {
    const { server, app } = await begin();
    const root = await lostCreate(server);
    expectMarker(PAGE, businessOf(server, CREATE_DATA));

    await retryWithSms(server, root);
    const prompt = TEXT.createdPrompt(createdId(1), '¥500.00', '¥508.80');
    await waitFor(() => expect(prompted(prompt)).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.createTitle)).toEqual([]));
    await settled(server);
    await waitFor(() => expectNothingStored());

    moveClock(LATER);
    await app.expire();
    const since = server.log.length;
    await app.loginWith(FIRST);
    await ready(server, since, AFTER_WRITE);
    await settle();
    expect(noticeShown()).toBe(false);
    expectNothingStored();
    expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);
  },
);

it(
  '[AC-F1-08at-ADJUST#3] 新建调账：结果未知（已存标记）后【重试】收到 10001 走全局重新登录；换另一个账号登录（同样的权限，落到调账与核销页）看不到「有一笔提交结果未知，请先到列表核对」，也不发任何写',
  { timeout: 240_000 },
  async () => {
    const { server, app } = await begin();
    const root = await lostCreate(server);
    expectMarker(PAGE, businessOf(server, CREATE_DATA));

    moveClock(LATER);
    await expireOnRetry(server, root);
    const sent = server.writes().length;
    const since = server.log.length;
    await app.loginWith(SECOND);
    expect(app.current()).toBe(SECOND);
    await ready(server, since, AFTER_WRITE);
    await settle();
    expect(noticeShown()).toBe(false);
    expect(openDialogs()).toEqual([]);
    expect(server.writes()).toHaveLength(sent);
  },
);
