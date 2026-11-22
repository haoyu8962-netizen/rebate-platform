// @vitest-environment jsdom
import { act, cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADMIN_ID,
  AT,
  LATER,
  accountOf,
  createConsole,
  expectBanner,
  moveClock,
  startClock,
  takeBaseline,
} from '../admin-unknown-relogin-marker/helpers.ts';
import {
  GRANTS,
  MANUAL,
  approvedRows,
  confirm,
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
import { BASE_URL } from '../admin-withdrawals/fixtures.ts';
import { AFTER_ANSWERS, UNKNOWN_AT, dismissBanner, expectStoredMarker } from './helpers.ts';

const ACCOUNT = accountOf('finance-jia', ADMIN_ID.first, GRANTS);
const PAGE = 'withdrawals';

async function send(server: Server, row: Withdrawal): Promise<HTMLElement> {
  const before = writes(server).length;
  await select([row]);
  const dialog = await open();
  await fillRows(dialog, [row]);
  await confirm(server, dialog);
  await verify();
  await waitFor(() => expect(writes(server)).toHaveLength(before + 1));
  return dialog;
}

// 主干上红在最后的三项存储断言，ManualPaid 卸载后丢掉 A 的断网回答，关闭旧提示后没有新标记。
it('[AC-F1-08atb-MANUAL#1] 批量手动打款 A 提交在途时离页，返回关闭旧提示后 A 断网；另一张单 B 录入成功后仍保留 A 的结果未知标记', async () => {
  startClock();
  const rows = approvedRows(3);
  const earlierRow = rows[0]!;
  const firstRow = rows[1]!;
  const secondRow = rows[2]!;
  const server = serverFor(rows);
  const app = createConsole({ baseUrl: BASE_URL, fetch: server.fetch, accounts: [ACCOUNT] });
  await app.signIn(ACCOUNT);
  await app.render(PAGE);
  await waitFor(() => expect(rowsOf(main(), earlierRow.out_biz_no)).toHaveLength(1));
  await settled(server);
  takeBaseline();

  server.once('POST', MANUAL, () => {
    throw new Error('连接中断，未收到旧提交回答');
  });
  const earlier = await send(server, earlierRow);
  await notice('上次提交结果未知', earlier);
  expectStoredMarker(PAGE, AT);
  cleanup();
  await app.render(PAGE);
  await waitFor(() => expect(rowsOf(main(), firstRow.out_biz_no)).toHaveLength(1));

  const pending = Promise.withResolvers<Response>();
  server.once('POST', MANUAL, () => pending.promise);
  await send(server, firstRow);
  cleanup();
  await app.render(PAGE);
  await waitFor(() => expect(rowsOf(main(), secondRow.out_biz_no)).toHaveLength(1));
  await expectBanner([]);

  moveClock(LATER);
  await dismissBanner();
  await waitFor(() => expect(server.pending).toBe(1));
  moveClock(UNKNOWN_AT);
  await act(async () => pending.reject(new Error('连接中断，未收到手动打款回答')));
  await settled(server);

  moveClock(AFTER_ANSWERS);
  server.once('POST', MANUAL, () => reply(server, paid([secondRow])));
  const second = await send(server, secondRow);
  await notice('已录入 1 张，跳过 0 张', second);
  await settled(server);
  expect(writes(server)).toHaveLength(3);
  expectStoredMarker(PAGE, UNKNOWN_AT);
}, 180_000);
