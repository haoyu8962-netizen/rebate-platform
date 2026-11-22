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
  expectNothingStored,
  moveClock,
  noticeShown,
  startClock,
  takeBaseline,
} from '../admin-unknown-relogin-marker/helpers.ts';
import {
  BATCHES,
  EXECUTOR,
  TEXT,
  approvedRows,
  confirm,
  main,
  networkDown,
  notice,
  openBatch,
  rowsOf,
  runBatch,
  select,
  serverFor,
  settled,
  verify,
  writes,
} from '../admin-withdrawal-batch-payout/helpers.ts';
import { BASE_URL } from '../admin-withdrawals/fixtures.ts';
import {
  AFTER_ANSWERS,
  UNKNOWN_AT,
  dismissBanner,
  expectNewBanner,
  expectStoredMarker,
} from './helpers.ts';

const PAGE = 'withdrawals';
const ACCOUNT = accountOf('finance-jia', ADMIN_ID.first, EXECUTOR);

// 主干上红在重新登录后的三项存储断言，BatchPayout 卸载后忽略断网回答，关闭旧提示后没有新标记。
it('[AC-F1-08atb-BATCH#1] 批量打款在途时离开提现审核，回来关闭旧提示后断网，重新登录显示该笔及断网时刻', async () => {
  startClock();
  const [earlier, target] = approvedRows();
  const server = serverFor([earlier!, target!]);
  const app = createConsole({ baseUrl: BASE_URL, fetch: server.fetch, accounts: [ACCOUNT] });
  const ready = () => waitFor(() => expect(rowsOf(main(), target!.out_biz_no)).toHaveLength(1));
  await app.signIn(ACCOUNT);
  await app.render(PAGE);
  await ready();
  await settled(server);
  takeBaseline();

  server.once('POST', BATCHES, networkDown);
  const first = await runBatch(server, [earlier!]);
  await notice(TEXT.unknown, first);
  expectStoredMarker(PAGE, AT);
  cleanup();
  await app.render(PAGE);
  await ready();

  const pending = Promise.withResolvers<Response>();
  server.once('POST', BATCHES, () => pending.promise);
  await select([target!]);
  const second = await openBatch(server);
  await confirm(server, second);
  await verify();
  await waitFor(() => expect(writes(server)).toHaveLength(2));
  cleanup();
  await app.render(PAGE);
  await ready();
  await expectBanner([]);

  moveClock(LATER);
  await dismissBanner();
  await waitFor(() => expect(server.pending).toBe(1));
  expectNothingStored();
  expect(noticeShown()).toBe(false);

  moveClock(UNKNOWN_AT);
  await act(async () => pending.reject(new Error('连接中断，未收到批量打款回答')));
  await settled(server);
  moveClock(AFTER_ANSWERS);
  await app.expire();
  await app.loginWith(ACCOUNT);
  await ready();
  await settled(server);
  expect(writes(server), '重新登录没有重发').toHaveLength(2);
  expectStoredMarker(PAGE, UNKNOWN_AT);
  await expectNewBanner();
}, 180_000);
