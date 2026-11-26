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
  readSince,
  startClock,
  takeBaseline,
} from '../admin-unknown-relogin-marker/helpers.ts';
import {
  BATCHES,
  EXECUTE,
  MANUAL,
  MANUAL_ENTRY,
  NAME,
  NUMBER,
  TEXT,
  WID,
  approved,
  fillEntry,
  main,
  networkDown,
  notice,
  openExecute,
  openManual,
  serverFor,
  settled,
  submit,
  verify,
  writes,
  type Server,
} from '../admin-withdrawal-detail-payout/helpers.ts';
import { BASE_URL, LIST, detailRoute } from '../admin-withdrawals/fixtures.ts';
import {
  AFTER_ANSWERS,
  UNKNOWN_AT,
  dismissBanner,
  expectNewBanner,
  expectStoredMarker,
} from './helpers.ts';

const PAGE = 'withdrawals';
const ACCOUNT = accountOf('finance-jia', ADMIN_ID.first, {
  ...EXECUTE,
  permissions: [...EXECUTE.permissions, 'payout.manual_entry'],
  stepUp: { ...EXECUTE.stepUp, ...MANUAL_ENTRY.stepUp },
});
const EARLIER = approved({
  withdrawal_id: 'e1000011-0000-4000-8000-000000000011',
  out_biz_no: 'W20261117000111',
});

async function expectUnknownAfterLeaving(
  path: string,
  open: (server: Server) => Promise<HTMLElement>,
  submitName: string,
): Promise<void> {
  startClock();
  const server = serverFor();
  server.state.push(structuredClone(EARLIER));
  const app = createConsole({ baseUrl: BASE_URL, fetch: server.fetch, accounts: [ACCOUNT] });
  await app.signIn(ACCOUNT);
  await app.render(detailRoute(EARLIER.withdrawal_id));
  await waitFor(() => expect(main().textContent).toContain(EARLIER.out_biz_no));
  await settled(server);
  takeBaseline();

  server.once('POST', BATCHES, networkDown);
  const first = await openExecute(server);
  await submit(server, first, NAME.executeSubmit);
  await verify();
  await notice(TEXT.unknown, first);
  await settled(server);
  expectStoredMarker(PAGE, AT);

  cleanup();
  await app.render(detailRoute(WID));
  await waitFor(() => expect(main().textContent).toContain(NUMBER));
  const second = await open(server);
  const drop = server.hold('POST', path, networkDown);
  await submit(server, second, submitName);
  await verify();
  await waitFor(() => expect(writes(server).map(({ path }) => path)).toEqual([BATCHES, path]));

  cleanup();
  const sinceLeave = server.log.length;
  await app.render(PAGE);
  await waitFor(() => expect(readSince(server.log, sinceLeave, LIST)).toBe(true));
  await waitFor(() => expect(main().textContent).toContain(NUMBER));
  await expectBanner([]);
  moveClock(LATER);
  await dismissBanner();
  await waitFor(() => expect(server.pending).toBe(1));
  expectNothingStored();
  expect(noticeShown()).toBe(false);

  moveClock(UNKNOWN_AT);
  await act(async () => drop());
  await settled(server);
  moveClock(AFTER_ANSWERS);
  await app.expire();
  const sinceExpiry = server.log.length;
  await app.loginWith(ACCOUNT);
  await waitFor(() => expect(readSince(server.log, sinceExpiry, LIST)).toBe(true));
  await settled(server);
  expect(writes(server), '重新登录没有重发').toHaveLength(2);
  expectStoredMarker(PAGE, UNKNOWN_AT);
  await expectNewBanner();
}

// 主干上红在重新登录后的三项存储断言，详情的执行打款离页后忽略断网回答，旧提示关闭后没有新标记。
it('[AC-F1-08atb-DETAIL#1] 详情页执行打款在途时离页，返回提现审核关闭旧提示后断网，重新登录显示该笔及断网时刻', async () => {
  await expectUnknownAfterLeaving(BATCHES, openExecute, NAME.executeSubmit);
}, 180_000);

// 主干上红在重新登录后的三项存储断言，详情的手动成功离页后忽略断网回答，旧提示关闭后没有新标记。
it('[AC-F1-08atb-DETAIL#2] 详情页手动成功在途时离页，返回提现审核关闭旧提示后断网，重新登录显示该笔及断网时刻', async () => {
  await expectUnknownAfterLeaving(
    MANUAL,
    async (server) => {
      const dialog = await openManual(server);
      await fillEntry(dialog);
      return dialog;
    },
    NAME.manualSubmit,
  );
}, 180_000);
