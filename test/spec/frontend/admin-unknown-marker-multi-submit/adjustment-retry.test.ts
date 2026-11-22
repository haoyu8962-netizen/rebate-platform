// @vitest-environment jsdom
import { act, cleanup, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJUSTER,
  ADJUSTMENTS,
  ADJUSTMENT_ORDER,
  COLUMN,
  DOC,
  NOTE,
  TEXT,
  USER,
  createWriteServer,
  createdId,
  failure,
  networkDown,
  reasonName,
  rejected,
  type WriteServer,
} from '../admin-adjustment-create/fixtures.ts';
import {
  assertSameWrites,
  click,
  fillForm,
  hasText,
  openCreate,
  settled,
  submitWithSms,
  verifySms,
  waitColumn,
  type NewForm,
} from '../admin-adjustment-create/helpers.ts';
import { BASE_URL, MENU_ID } from '../admin-adjustments-readonly/fixtures.ts';
import {
  ADMIN_ID,
  AT,
  LATER,
  accountOf,
  createConsole,
  expectBanner,
  expectNothingStored,
  loggedOut,
  moveClock,
  noticeShown,
  readSince,
  startClock,
  takeBaseline,
} from '../admin-unknown-relogin-marker/helpers.ts';
import {
  AFTER_ANSWERS,
  UNKNOWN_AT,
  dismissBanner,
  expectNewBanner,
  expectStoredMarker,
} from './helpers.ts';

const ACCOUNT = accountOf('finance-jia', ADMIN_ID.first, ADJUSTER);
const FORM: NewForm = {
  user: USER.recon,
  direction: '调增',
  amount: '8.80',
  reason: reasonName('RECON_FIX'),
  refs: [['recon_diff', DOC.reconDiff]],
  note: NOTE.reconFix,
  subject: '佣金收入',
};

async function leaveDuringRetry(hold: (server: WriteServer) => () => void) {
  startClock();
  const server = createWriteServer();
  const app = createConsole({ baseUrl: BASE_URL, fetch: server.fetch, accounts: [ACCOUNT] });
  await app.signIn(ACCOUNT);
  await app.render(MENU_ID);
  await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
  await settled(server);
  takeBaseline();

  const drawer = await openCreate();
  await fillForm(drawer, FORM);
  server.once('POST', ADJUSTMENTS, networkDown);
  const first = await submitWithSms(server, drawer);
  await waitFor(() => expect(hasText(drawer, TEXT.unknown)).toBe(true));
  expectStoredMarker(MENU_ID, AT);

  const release = hold(server);
  await click(within(drawer).getByRole('button', { name: TEXT.retry }));
  await verifySms(server);
  await waitFor(() => expect(server.writes()).toHaveLength(2));
  assertSameWrites(server, first.body);
  cleanup();
  await app.render(MENU_ID);
  await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
  await waitFor(() => expect(server.pending).toBe(1));
  await expectBanner([]);
  return { app, release, server };
}

async function expectSettledRetry(hold: (server: WriteServer) => () => void, created: boolean) {
  const { app, release, server } = await leaveDuringRetry(hold);
  moveClock(UNKNOWN_AT);
  await act(async () => release());
  await settled(server);
  expect(server.forms.some(({ adjust_id }) => adjust_id === createdId(1))).toBe(created);
  expectNothingStored();

  moveClock(AFTER_ANSWERS);
  await app.expire();
  const sinceExpiry = server.log.length;
  await app.loginWith(ACCOUNT);
  await waitFor(() => expect(readSince(server.log, sinceExpiry, ADJUSTMENTS)).toBe(true));
  await settled(server);
  expectNothingStored();
  expect(noticeShown()).toBe(false);
  expect(server.writes(), '重新登录没有重发').toHaveLength(2);
}

// 主干上红在重试成功后的空存储断言，useAdjustmentWrite 卸载后提前返回，原未知标记没有释放。
it('[AC-F1-08atb-ADJUST-RETRY#1] 新建调账结果未知后重试，在途时离页，收到成功即清标记，重新登录无提示', async () => {
  await expectSettledRetry((server) => server.hold('POST', ADJUSTMENTS), true);
}, 180_000);

// 主干上红在重新登录后的三项存储断言，useAdjustmentWrite 卸载后忽略 10001，关闭旧提示后没有新标记。
it('[AC-F1-08atb-ADJUST-RETRY#2] 新建调账重试在途时离页，回来关闭旧提示后收到 10001，重新登录显示该笔及会话失效时刻', async () => {
  const { app, release, server } = await leaveDuringRetry((fake) => {
    const pending = Promise.withResolvers<Response>();
    fake.once('POST', ADJUSTMENTS, () => pending.promise);
    return () => pending.resolve(failure(10001, undefined, '未登录'));
  });
  moveClock(LATER);
  await dismissBanner();
  expect(server.pending).toBe(1);
  expectNothingStored();
  expect(noticeShown()).toBe(false);

  moveClock(UNKNOWN_AT);
  await act(async () => release());
  await waitFor(() => expect(loggedOut()).toBe(true));
  await settled(server);
  moveClock(AFTER_ANSWERS);
  const sinceExpiry = server.log.length;
  await app.loginWith(ACCOUNT);
  await waitFor(() => expect(readSince(server.log, sinceExpiry, ADJUSTMENTS)).toBe(true));
  await settled(server);
  expect(server.writes(), '重新登录没有重发').toHaveLength(2);
  expectStoredMarker(MENU_ID, UNKNOWN_AT);
  await expectNewBanner();
}, 180_000);

// 主干上红在重试确定拒绝后的空存储断言，useAdjustmentWrite 卸载后跳过拒绝分支，原未知标记没有释放。
it('[AC-F1-08atb-ADJUST-RETRY#3] 新建调账结果未知后重试，在途时离页，收到确定拒绝即清标记，重新登录无提示', async () => {
  await expectSettledRetry((server) => {
    const pending = Promise.withResolvers<Response>();
    server.once('POST', ADJUSTMENTS, () => pending.promise);
    return () => pending.resolve(rejected(['amount_fen']));
  }, false);
}, 180_000);
