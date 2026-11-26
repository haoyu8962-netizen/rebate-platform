// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { Fragment, createElement } from 'react';
import { expect, it } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { UnknownMarkerBanner } from '../../../../apps/admin/src/components/unknown-marker/index.ts';
import { AutoPayoutSettings } from '../../../../apps/admin/src/pages/withdrawals/AutoPayoutSettings.tsx';
import { BASE_URL, LIST } from '../admin-payouts-readonly/fixtures.ts';
import { panelOf, selectTab } from '../admin-payouts-readonly/helpers.ts';
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
  stored,
  takeBaseline,
  type Console,
} from '../admin-unknown-relogin-marker/helpers.ts';
import {
  BUSINESS_GRANTS,
  KEY,
  LABEL,
  NOTICE,
  RETRY,
  SAVE,
  TAB,
  accountOf as snapshotOf,
  answerNormally,
  dropped,
  failedWith,
  scriptBatch,
  serverError,
  serverFor,
  type PayoutServer,
} from '../admin-withdrawal-auto-payout-settings/fixtures.ts';
import {
  batches,
  click,
  input,
  main,
  markedInvalid,
  pageTabNames,
  passUntilSent,
  save,
  settled,
  shows,
  typeInto,
  usable,
  verify,
} from '../admin-withdrawal-auto-payout-settings/helpers.ts';
import {
  AFTER_ANSWERS,
  UNKNOWN_AT,
  dismissBanner,
  expectNewBanner,
  expectStoredMarker,
} from './helpers.ts';

const PAGE = 'withdrawals';
const GRANTS = [...BUSINESS_GRANTS, 'switch.all'] as const;
const ACCOUNT = accountOf('finance-jia', ADMIN_ID.first, snapshotOf(GRANTS));
const MAX_AMOUNT = { label: LABEL.maxAmount, value: '300' };
const USER_DAILY = { label: LABEL.userDaily, value: '5' };

async function ready(server: PayoutServer, since: number): Promise<void> {
  await waitFor(() => expect(readSince(server.log, since, LIST)).toBe(true));
  await waitFor(() => expect(pageTabNames()).toContain(TAB.auto));
}

async function begin(server: PayoutServer): Promise<Console> {
  const app = createConsole({ baseUrl: BASE_URL, fetch: server.fetch, accounts: [ACCOUNT] });
  await app.signIn(ACCOUNT);
  await app.render(PAGE);
  await ready(server, 0);
  await settled(server);
  takeBaseline();
  return app;
}

async function openSettings(): Promise<HTMLElement> {
  const panel = await panelOf(await selectTab(main(), TAB.auto));
  await waitFor(() => input(panel, LABEL.maxAmount));
  return panel;
}

async function sendHeldSave(
  server: PayoutServer,
  panel: HTMLElement,
  field: { label: RegExp; value: string },
) {
  const before = batches(server).length;
  const reply = Promise.withResolvers<Response>();
  scriptBatch(server, () => reply.promise);
  await typeInto(panel, field.label, field.value);
  await click(usable(panel, SAVE));
  await verify();
  await waitFor(() => expect(batches(server)).toHaveLength(before + 1));
  const request = batches(server)[before]!;
  return { ...reply, request };
}

async function closeOldPromptWhileBothPending(firstSucceeds: boolean) {
  moveClock(AT);
  const server = serverFor({ permissions: GRANTS });
  const app = await begin(server);
  const first = await sendHeldSave(server, await openSettings(), MAX_AMOUNT);
  await waitFor(() => expect(server.pending).toBe(1));

  cleanup();
  const since = server.log.length;
  await app.render(PAGE);
  await ready(server, since);
  await expectBanner([]);
  const panel = await openSettings();
  const second = await sendHeldSave(server, panel, USER_DAILY);
  await waitFor(() => expect(server.pending).toBe(2));

  moveClock(LATER);
  await dismissBanner();
  expect(server.pending, '关闭时两笔均未回答').toBe(2);

  moveClock(UNKNOWN_AT);
  await act(async () => {
    if (firstSucceeds) first.resolve(answerNormally(server, first.request));
    else first.reject(new Error('连接中断，未收到保存回答'));
  });
  await waitFor(() => expect(server.pending).toBe(1));

  moveClock(AFTER_ANSWERS);
  second.resolve(answerNormally(server, second.request));
  await settled(server);
  await shows(panel, NOTICE.saved);
  await app.expire();
  const sinceExpiry = server.log.length;
  await app.loginWith(ACCOUNT);
  await ready(server, sinceExpiry);
  await settled(server);
  expect(batches(server), '重新登录没有重发').toHaveLength(2);
}

// 主干上红在最终三项存储断言，关闭后只补写了 B，离页的 A 断网未登记，B 成功就删掉了整条标记。
it('[AC-F1-08atb-AUTO#1] 设置保存 A 在途离页，返回提交 B 后关闭旧提示；A 和 B 均成功时重新登录无提示，A 断网而 B 成功时重新登录仍提示 A 及断网时刻', async () => {
  startClock();
  await closeOldPromptWhileBothPending(true);
  expectNothingStored();
  expect(noticeShown()).toBe(false);
  cleanup();

  await closeOldPromptWhileBothPending(false);
  expectStoredMarker(PAGE, UNKNOWN_AT);
  await expectNewBanner();
}, 240_000);

async function mountIndependentSettings(app: Console): Promise<[HTMLElement, HTMLElement]> {
  // 在同一标签页挂两个可独立重试的真设置组件，覆盖两笔未知先后得到确定回答。
  const props = { canReadMaster: true, clock: { now: () => Date.now() } };
  render(
    createAdminShell({
      router: 'memory',
      initialRoute: { menuId: PAGE },
      permissionsProvider: async () => ACCOUNT.snapshot,
      account: { username: ACCOUNT.username, displayName: ACCOUNT.username },
      environment: 'test',
      onLogout: async () => {
        await app.api.auth.logout({});
      },
      dataProvider: app.api.data,
      authProvider: app.api.auth,
      renderPage: () =>
        createElement(
          Fragment,
          null,
          createElement(UnknownMarkerBanner, {
            scope: { page: PAGE, account: ACCOUNT.me.admin_id },
          }),
          createElement(
            'section',
            { 'aria-label': '设置 A' },
            createElement(AutoPayoutSettings, props),
          ),
          createElement(
            'section',
            { 'aria-label': '设置 B' },
            createElement(AutoPayoutSettings, props),
          ),
        ),
    }),
  );
  const first = await screen.findByRole('region', { name: '设置 A' });
  const second = await screen.findByRole('region', { name: '设置 B' });
  await waitFor(() => input(first, LABEL.maxAmount));
  await waitFor(() => input(second, LABEL.userDaily));
  return [first, second];
}

async function retry(server: PayoutServer, panel: HTMLElement): Promise<void> {
  const before = batches(server).length;
  await click(usable(panel, RETRY));
  await passUntilSent(server, before);
}

// 主干上红在 A 进入未知后的三项存储断言，【关闭】时提前补写，未知回答到达时仍沿用关闭时刻。
it('[AC-F1-08atb-AUTO#2] 两笔保存均在途时关闭旧提示，两笔先后进入未知；A 确定拒绝时 B 的标记仍在，B 成功后才清除', async () => {
  startClock();
  const server = serverFor({ permissions: GRANTS, passes: 6 });
  const app = await begin(server);
  const earlier = await openSettings();
  scriptBatch(server, () => dropped());
  await typeInto(earlier, MAX_AMOUNT.label, MAX_AMOUNT.value);
  await save(server, earlier);
  await waitFor(() => usable(earlier, RETRY));
  expectStoredMarker(PAGE, AT);

  cleanup();
  const [firstPanel, secondPanel] = await mountIndependentSettings(app);
  await settled(server);
  const first = await sendHeldSave(server, firstPanel, MAX_AMOUNT);
  const second = await sendHeldSave(server, secondPanel, USER_DAILY);
  expect(server.pending).toBe(2);
  moveClock(LATER);
  await dismissBanner();
  expect(server.pending).toBe(2);

  // 回答顺序由假服务控制。同一秒内依次进入未知，避免约定一个标记聚合多个未知时的时刻排序。
  moveClock(UNKNOWN_AT);
  first.reject(new Error('连接中断，未收到保存回答'));
  await waitFor(() => usable(firstPanel, RETRY));
  expect(server.pending).toBe(1);
  const afterFirst = stored();
  second.resolve(serverError());
  await waitFor(() => usable(secondPanel, RETRY));
  await settled(server);
  expectStoredMarker(PAGE, UNKNOWN_AT, afterFirst);
  expectStoredMarker(PAGE, UNKNOWN_AT);
  expect(batches(server), '两笔进入未知后没有自行重发').toHaveLength(3);

  moveClock(AFTER_ANSWERS);
  scriptBatch(server, () => failedWith(20902, { resource: 'config_item' }));
  await retry(server, firstPanel);
  await waitFor(() => usable(firstPanel, RETRY));
  expectStoredMarker(PAGE, UNKNOWN_AT);

  scriptBatch(server, () => failedWith(20001, { fields: [KEY.maxAmount] }));
  await retry(server, firstPanel);
  await waitFor(() => expect(markedInvalid(firstPanel, LABEL.maxAmount)).toBe(true));
  expectStoredMarker(PAGE, UNKNOWN_AT);

  await retry(server, secondPanel);
  await shows(secondPanel, NOTICE.saved);
  expectNothingStored();
  expect(noticeShown()).toBe(false);
  expect(batches(server)).toHaveLength(6);
}, 180_000);

// 主干上红在重新登录后的三项存储断言，关闭删掉了在途保存的旧标记，首次收到 10001 也没有重新登记。
it('[AC-F1-08atb-AUTO#3] 保存 A 在途离页，返回关闭旧提示后收到 10001；重新登录仍提示 A 及会话过期时刻', async () => {
  startClock();
  const server = serverFor({ permissions: GRANTS });
  const app = await begin(server);
  const first = await sendHeldSave(server, await openSettings(), MAX_AMOUNT);
  cleanup();
  const sinceLeave = server.log.length;
  await app.render(PAGE);
  await ready(server, sinceLeave);
  await expectBanner([]);

  moveClock(LATER);
  await dismissBanner();
  await waitFor(() => expect(server.pending).toBe(1));
  moveClock(UNKNOWN_AT);
  await act(async () => first.resolve(failedWith(10001, undefined, '未登录')));
  await waitFor(() => expect(loggedOut()).toBe(true));
  await settled(server);

  moveClock(AFTER_ANSWERS);
  const sinceExpiry = server.log.length;
  await app.loginWith(ACCOUNT);
  await ready(server, sinceExpiry);
  await settled(server);
  expect(batches(server), '重新登录没有重发').toHaveLength(1);
  expectStoredMarker(PAGE, UNKNOWN_AT);
  await expectNewBanner();
}, 180_000);
