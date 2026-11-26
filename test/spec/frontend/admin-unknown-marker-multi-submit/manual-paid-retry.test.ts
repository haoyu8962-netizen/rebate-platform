// @vitest-environment jsdom
import { act, cleanup, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
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
  startClock,
  takeBaseline,
} from '../admin-unknown-relogin-marker/helpers.ts';
import {
  GRANTS,
  MANUAL,
  approvedRows,
  assertReplay,
  click,
  confirm,
  failure,
  fillRows,
  main,
  notice,
  open,
  paid,
  reply,
  rowsOf,
  select,
  serverFor,
  settled,
  verify,
  writes,
  type Server,
  type Withdrawal,
} from '../admin-withdrawal-manual-paid/helpers.ts';
import { BASE_URL, TRACE_ID } from '../admin-withdrawals/fixtures.ts';
import {
  AFTER_ANSWERS,
  UNKNOWN_AT,
  dismissBanner,
  expectNewBanner,
  expectStoredMarker,
} from './helpers.ts';

const PAGE = 'withdrawals';
const ACCOUNT = accountOf('finance-jia', ADMIN_ID.first, GRANTS);

async function leaveDuringRetry(answer: (server: Server, row: Withdrawal) => Response) {
  startClock();
  const rows = approvedRows(2);
  const row = rows[0]!;
  const otherRow = rows[1]!;
  const server = serverFor(rows);
  const app = createConsole({ baseUrl: BASE_URL, fetch: server.fetch, accounts: [ACCOUNT] });
  const ready = () => waitFor(() => expect(rowsOf(main(), otherRow.out_biz_no)).toHaveLength(1));
  await app.signIn(ACCOUNT);
  await app.render(PAGE);
  await ready();
  await settled(server);
  takeBaseline();

  server.once('POST', MANUAL, () => {
    throw new Error('连接中断，未收到首次录入回答');
  });
  await select([row]);
  const dialog = await open();
  const body = await fillRows(dialog, [row]);
  await confirm(server, dialog);
  await verify();
  await notice('上次提交结果未知', dialog);
  await settled(server);
  expectStoredMarker(PAGE, AT);

  const release = server.hold('POST', MANUAL, () => answer(server, row));
  await click(within(dialog).getByRole('button', { name: '重试' }));
  await verify();
  await waitFor(() => expect(writes(server)).toHaveLength(2));
  assertReplay(server, body, 2);
  cleanup();
  await app.render(PAGE);
  await ready();
  await waitFor(() => expect(server.pending).toBe(1));
  await expectBanner([]);
  return { app, ready, release, server };
}

async function expectSettledRetry(answer: (server: Server, row: Withdrawal) => Response) {
  const { app, ready, release, server } = await leaveDuringRetry(answer);
  moveClock(UNKNOWN_AT);
  await act(async () => release());
  await settled(server);
  expectNothingStored();

  moveClock(AFTER_ANSWERS);
  await app.expire();
  await app.loginWith(ACCOUNT);
  await ready();
  await settled(server);
  expectNothingStored();
  expect(noticeShown()).toBe(false);
  expect(writes(server), '重新登录没有重发').toHaveLength(2);
}

// 主干上红在重试成功后的空存储断言，ManualPaid 卸载后提前返回，原未知标记没有释放。
it('[AC-F1-08atb-MANUAL-RETRY#1] 批量手动打款结果未知后重试，在途时离页，收到成功即清标记，重新登录无提示', async () => {
  await expectSettledRetry((server, row) => reply(server, paid([row])));
}, 180_000);

// 主干上红在重新登录后的三项存储断言，ManualPaid 卸载后忽略 10001，关闭旧提示后没有新标记。
it('[AC-F1-08atb-MANUAL-RETRY#2] 批量手动打款重试在途时离页，回来关闭旧提示后收到 10001，重新登录显示该笔及会话失效时刻', async () => {
  const { app, ready, release, server } = await leaveDuringRetry(() =>
    Response.json({ code: 10001, msg: '未登录', trace_id: TRACE_ID }, { status: 401 }),
  );
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
  await app.loginWith(ACCOUNT);
  await ready();
  await settled(server);
  expect(writes(server), '重新登录没有重发').toHaveLength(2);
  expectStoredMarker(PAGE, UNKNOWN_AT);
  await expectNewBanner();
}, 180_000);

// 主干上红在重试确定拒绝后的空存储断言，ManualPaid 卸载后跳过拒绝分支，原未知标记没有释放。
it('[AC-F1-08atb-MANUAL-RETRY#3] 批量手动打款结果未知后重试，在途时离页，收到确定拒绝即清标记，重新登录无提示', async () => {
  await expectSettledRetry(() => failure(20001, { fields: ['items'] }));
}, 180_000);
