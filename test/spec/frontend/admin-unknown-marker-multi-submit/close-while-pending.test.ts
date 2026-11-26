// @vitest-environment jsdom
import { act, cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BASE_URL } from '../admin-payouts-readonly/fixtures.ts';
import { panelOf, selectTab } from '../admin-payouts-readonly/helpers.ts';
import {
  ADMIN_ID,
  AT,
  LATER,
  accountOf,
  createConsole,
  expectBanner,
  moveClock,
  noticeShown,
  startClock,
  stored,
  takeBaseline,
} from '../admin-unknown-relogin-marker/helpers.ts';
import {
  BUSINESS_GRANTS,
  LABEL,
  NOTICE,
  SAVE,
  TAB,
  accountOf as snapshotOf,
  dropped,
  scriptBatch,
  serverFor,
} from '../admin-withdrawal-auto-payout-settings/fixtures.ts';
import {
  batches,
  click,
  input,
  main,
  pageTabNames,
  save,
  settled,
  shows,
  typeInto,
  usable,
  verify,
} from '../admin-withdrawal-auto-payout-settings/helpers.ts';
import { UNKNOWN_AT, dismissBanner, expectStoredMarker } from './helpers.ts';

const PAGE = 'withdrawals';
const GRANTS = [...BUSINESS_GRANTS, 'switch.all'] as const;
const ACCOUNT = accountOf('finance-jia', ADMIN_ID.first, snapshotOf(GRANTS));

async function openSettings(): Promise<HTMLElement> {
  await waitFor(() => expect(pageTabNames()).toContain(TAB.auto));
  const panel = await panelOf(await selectTab(main(), TAB.auto));
  await waitFor(() => input(panel, LABEL.maxAmount));
  return panel;
}

// 主干上红在回答前的空存储断言，关闭旧提示会触发仍在等待回答的设置页立即补写标记。
it('[AC-F1-08atb-CLOSE#1] 自动到账设置保存仍在途时关闭旧提示，回答前存储为空且不再弹提示，断网后才登记', async () => {
  startClock();
  const server = serverFor({ permissions: GRANTS });
  const app = createConsole({ baseUrl: BASE_URL, fetch: server.fetch, accounts: [ACCOUNT] });
  await app.signIn(ACCOUNT);
  await app.render(PAGE);
  const first = await openSettings();
  await settled(server);
  takeBaseline();

  scriptBatch(server, dropped);
  await typeInto(first, LABEL.maxAmount, '300');
  await save(server, first);
  await shows(first, NOTICE.unknown);
  expectStoredMarker(PAGE, AT);
  cleanup();
  await app.render(PAGE);
  const second = await openSettings();
  await expectBanner([]);

  const pending = Promise.withResolvers<Response>();
  scriptBatch(server, () => pending.promise);
  await typeInto(second, LABEL.userDaily, '5');
  await click(usable(second, SAVE));
  await verify();
  await waitFor(() => expect(batches(server)).toHaveLength(2));
  moveClock(LATER);
  await dismissBanner();
  await waitFor(() => expect(server.pending).toBe(1));
  const storageBeforeAnswer = stored();
  const noticeBeforeAnswer = noticeShown();

  moveClock(UNKNOWN_AT);
  await act(async () => pending.reject(new Error('连接中断，未收到设置保存回答')));
  await shows(second, NOTICE.unknown);
  await settled(server);
  expect(storageBeforeAnswer, '关闭后到回答前没有补写').toEqual([]);
  expect(noticeBeforeAnswer, '关闭后到回答前提示没有再次弹出').toBe(false);
  expectStoredMarker(PAGE, UNKNOWN_AT);
}, 180_000);
