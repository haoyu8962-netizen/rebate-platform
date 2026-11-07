/// <reference types="@vitest/browser-playwright" />
// DSX-50: screenshot baseline comparison of the H5 key pages (规则、帮助、公告、收益明细、订单找回、
// 消息、邀请), light and dark, at 375×844. Each page is mounted as in its own browser rule test
// (shared fixtures: fake HTTP server or fake bridge, example data only). Report only: see
// compare.ts. Also the mutation switch self-check (against a reference screenshot of the same
// run, inside the mutated button's box), the two-screenshot stability check and the report check.
import { createElement, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { EarningsPage } from '../../../../apps/h5/src/entries/app/pages/earnings/index.ts';
import { FindOrderPage } from '../../../../apps/h5/src/entries/app/pages/find-order/index.ts';
import { HelpPage } from '../../../../apps/h5/src/entries/app/pages/help/index.ts';
import { MemoryRouter } from '../../../../apps/h5/src/entries/app/pages/help/router.ts';
import { InvitePage } from '../../../../apps/h5/src/entries/app/pages/invite/index.ts';
import { MessagesPage } from '../../../../apps/h5/src/entries/app/pages/messages/index.ts';
import { NoticePage } from '../../../../apps/h5/src/entries/app/pages/notices/index.ts';
import { MemoryRouter as NoticeRouter } from '../../../../apps/h5/src/entries/app/pages/notices/router.ts';
import { RulesPage } from '../../../../apps/h5/src/entries/app/pages/rules/index.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import '../../../../apps/h5/src/shared/styles/index.css';
import {
  copy as earningsCopy,
  earningsServer,
  NOW as EARNINGS_NOW,
} from '../h5-earnings/earnings-fixtures.ts';
import {
  fixture as findOrderFixture,
  NOW as FIND_ORDER_NOW,
  texts as findOrderTexts,
} from '../h5-find-order/find-order-fixtures.ts';
import { fakeBridge, helpServer } from '../h5-help/fixtures.ts';
import { inviteCode, inviteServer, myInvite } from '../h5-invite/invite-fixtures.ts';
import {
  list as messageList,
  messages,
  messagesServer,
  texts as messageTexts,
  tracked,
} from '../h5-messages/messages-fixtures.ts';
import { notices, reply, server as noticesServer } from '../h5-notices/fixtures.ts';
import {
  BODY_TEXT as RULES_BODY,
  CDN as RULES_CDN,
  server as rulesServer,
} from '../h5-rules/fixtures.ts';
import {
  CASE_TIMEOUT,
  WAIT,
  capture,
  checkPage,
  compareCaptures,
  enterStableEnvironment,
  expectBaseline,
  leaveStableEnvironment,
  readEntry,
  record,
  recordRun,
  regionOf,
  setMutation,
  settle,
  writeSummary,
} from './compare.ts';
import {
  H5_EARNINGS,
  H5_FIND_ORDER,
  H5_HELP,
  H5_INVITE,
  H5_MESSAGES,
  H5_NOTICES,
  H5_PAGES,
  H5_RULES,
  STABLE_PERCENT,
  THRESHOLD_PERCENT,
  type Theme,
  type VisualPage,
} from './pages.ts';

/** Clock of the pages whose fixtures have no own NOW (as in h5-messages). */
const H5_NOW = '2026-10-22T12:00:00+08:00';

let root: Root | undefined;
let client: ReturnType<typeof createQueryClient> | undefined;
let idle: HTMLElement | undefined;
let stopIdle: (() => void) | undefined;

afterEach(async () => {
  root?.unmount();
  root = undefined;
  stopIdle?.();
  stopIdle = undefined;
  idle = undefined;
  client?.clear();
  client = undefined;
  document.body.replaceChildren();
  await leaveStableEnvironment();
});

afterAll(async () => {
  await writeSummary('h5');
});

/**
 * Mounts a page under a fresh query client. A hidden marker carries the number of running
 * queries and mutations (data-busy), so a case can wait for the data to settle.
 */
function mount(content: ReactElement): void {
  const container = document.createElement('div');
  container.style.fontFamily = 'var(--font-family-system)';
  document.body.append(container);
  const queries = createQueryClient();
  client = queries;
  const marker = document.createElement('span');
  marker.hidden = true;
  const update = (): void => {
    marker.dataset['busy'] = String(queries.isFetching() + queries.isMutating());
  };
  update();
  const stopQueries = queries.getQueryCache().subscribe(update);
  const stopMutations = queries.getMutationCache().subscribe(update);
  stopIdle = () => {
    stopQueries();
    stopMutations();
  };
  idle = marker;
  document.body.append(marker);
  let failure: unknown;
  root = createRoot(container, {
    onUncaughtError: (error) => {
      failure = error;
    },
  });
  flushSync(() => root?.render(createQueryProvider(content, queries)));
  if (failure !== undefined) throw failure;
}

/** No query or mutation running, then fonts, images and animations settled. */
async function quiet(): Promise<void> {
  await expect.element(idle ?? null, WAIT).toHaveAttribute('data-busy', '0');
  await settle();
  await expect.element(idle ?? null, WAIT).toHaveAttribute('data-busy', '0');
}

async function openRules(): Promise<void> {
  mount(createElement(RulesPage, { api: rulesServer().api, mediaCdnOrigin: RULES_CDN }));
  await expect
    .element(page.getByRole('heading', { name: '返利规则', level: 1 }), WAIT)
    .toBeVisible();
  await expect.element(page.getByText(RULES_BODY, { exact: true }), WAIT).toBeVisible();
  await expect.element(page.getByText('提现规则', { exact: true }), WAIT).toBeVisible();
}

async function openHelp(): Promise<void> {
  mount(
    createElement(
      ApiProvider,
      { api: helpServer().api },
      createElement(
        MemoryRouter,
        { initialEntries: ['/help'] },
        createElement(HelpPage, { bridge: fakeBridge().bridge }),
      ),
    ),
  );
  await expect.element(page.getByRole('heading', { name: '帮助中心' }), WAIT).toBeVisible();
  await expect.element(page.getByRole('heading', { name: '常见问题' }), WAIT).toBeVisible();
  await expect
    .element(page.getByRole('button', { name: '联系客服', exact: true }), WAIT)
    .toBeVisible();
}

async function openNotices(): Promise<void> {
  mount(
    createElement(
      ApiProvider,
      { api: noticesServer().api },
      createElement(NoticeRouter, { initialEntries: ['/notice'] }, createElement(NoticePage, {})),
    ),
  );
  await expect.element(page.getByText(notices[0]!.title, { exact: true }), WAIT).toBeVisible();
  await expect.element(page.getByText('没有更多公告了'), WAIT).toBeVisible();
}

async function openEarnings(): Promise<void> {
  mount(
    createElement(
      ApiProvider,
      { api: earningsServer().api },
      createElement(
        MemoryRouter,
        { initialEntries: ['/earnings'] },
        createElement(EarningsPage, {}),
      ),
    ),
  );
  await expect.element(page.getByText(earningsCopy.self, { exact: true }), WAIT).toBeVisible();
}

async function openFindOrder(): Promise<void> {
  const fixture = findOrderFixture();
  mount(
    createElement(
      ApiProvider,
      { api: fixture.api },
      createElement(
        MemoryRouter,
        { initialEntries: ['/find-order'] },
        createElement(FindOrderPage, { bridge: fixture.bridge }),
      ),
    ),
  );
  await expect
    .element(page.getByText(findOrderTexts['claim.guide.paid_date'], { exact: false }), WAIT)
    .toBeVisible();
  await expect.element(page.getByLabelText(/^订单号/), WAIT).toBeVisible();
  await expect.element(page.getByRole('button', { name: /提交找回|^提交$/ }), WAIT).toBeVisible();
  await expect.element(page.getByText('淘宝', { exact: true }), WAIT).toBeVisible();
}

async function openMessages(): Promise<void> {
  const http = messagesServer({ list: () => reply(messageList(messages)) });
  mount(
    createElement(
      ApiProvider,
      { api: http.api },
      createElement(
        MemoryRouter,
        { initialEntries: ['/messages'] },
        createElement(MessagesPage, {}),
      ),
    ),
  );
  await expect.element(page.getByText(tracked.body, { exact: false }), WAIT).toBeVisible();
  await expect
    .element(page.getByRole('button', { name: messageTexts.readAll }), WAIT)
    .toBeVisible();
}

async function openInvite(): Promise<void> {
  // No poster: the fixture's poster host never answers, which would make the preview flicker.
  const http = inviteServer({ invite: () => reply(myInvite({ poster_url: null })) });
  mount(
    createElement(
      ApiProvider,
      { api: http.api },
      createElement(MemoryRouter, { initialEntries: ['/invite'] }, createElement(InvitePage, {})),
    ),
  );
  await expect.element(page.getByText(inviteCode, { exact: false }).first(), WAIT).toBeVisible();
  await expect.element(page.getByRole('button', { name: /复制邀请链接/ }), WAIT).toBeVisible();
}

async function compare(
  target: VisualPage,
  theme: Theme,
  open: () => Promise<void>,
  now: string,
): Promise<void> {
  await enterStableEnvironment({ theme, now, viewport: target.viewport });
  await open();
  await quiet();
  await checkPage(target, theme);
}

it(
  '[AC-DSX-50-H5#1] 规则页（浅色）与基准比对，差异百分比写入报告',
  () => compare(H5_RULES, 'light', openRules, H5_NOW),
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-H5#2] 规则页（深色）与基准比对，差异百分比写入报告',
  () => compare(H5_RULES, 'dark', openRules, H5_NOW),
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-H5#3] 帮助页（浅色）与基准比对，差异百分比写入报告',
  () => compare(H5_HELP, 'light', openHelp, H5_NOW),
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-H5#4] 帮助页（深色）与基准比对，差异百分比写入报告',
  () => compare(H5_HELP, 'dark', openHelp, H5_NOW),
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-H5#5] 公告页（浅色）与基准比对，差异百分比写入报告',
  () => compare(H5_NOTICES, 'light', openNotices, H5_NOW),
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-H5#6] 公告页（深色）与基准比对，差异百分比写入报告',
  () => compare(H5_NOTICES, 'dark', openNotices, H5_NOW),
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-H5#7] 收益明细页（浅色）与基准比对，差异百分比写入报告',
  () => compare(H5_EARNINGS, 'light', openEarnings, EARNINGS_NOW),
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-H5#8] 收益明细页（深色）与基准比对，差异百分比写入报告',
  () => compare(H5_EARNINGS, 'dark', openEarnings, EARNINGS_NOW),
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-H5#9] 订单找回页（浅色）与基准比对，差异百分比写入报告',
  () => compare(H5_FIND_ORDER, 'light', openFindOrder, FIND_ORDER_NOW),
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-H5#10] 订单找回页（深色）与基准比对，差异百分比写入报告',
  () => compare(H5_FIND_ORDER, 'dark', openFindOrder, FIND_ORDER_NOW),
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-H5#11] 消息页（浅色）与基准比对，差异百分比写入报告',
  () => compare(H5_MESSAGES, 'light', openMessages, H5_NOW),
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-H5#12] 消息页（深色）与基准比对，差异百分比写入报告',
  () => compare(H5_MESSAGES, 'dark', openMessages, H5_NOW),
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-H5#13] 邀请页（浅色）与基准比对，差异百分比写入报告',
  () => compare(H5_INVITE, 'light', openInvite, H5_NOW),
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-H5#14] 邀请页（深色）与基准比对，差异百分比写入报告',
  () => compare(H5_INVITE, 'dark', openInvite, H5_NOW),
  CASE_TIMEOUT,
);

// The self-check compares with a reference screenshot of this same run, never with the committed
// baseline: that one is rendered on another machine and changes with the page, so asserting on it
// would block merges. The baseline comparison of the reference is report only (it must exist).
it(
  '[AC-DSX-50-MUTATION#1] 变异开关打开（按钮圆角改为 50%）时订单找回页（浅色）提交按钮区域与同次运行的参照图差异超过 1% 且报告标出该页，关掉后与参照图差异小于 0.1%',
  async () => {
    await enterStableEnvironment({
      theme: 'light',
      now: FIND_ORDER_NOW,
      viewport: H5_FIND_ORDER.viewport,
    });
    await openFindOrder();
    await quiet();
    const submit = page.getByRole('button', { name: /提交找回|^提交$/ });
    await expect.element(submit, WAIT).not.toHaveStyle({ borderRadius: '50%' });
    const region = regionOf(submit.element());
    expect(region.width * region.height, '提交按钮的包围盒有面积').toBeGreaterThan(0);

    const reference = await capture();
    const baseline = await record(H5_FIND_ORDER, 'light', 'mutation-reference', reference);
    expectBaseline(baseline);

    setMutation(true);
    await settle();
    await expect.element(submit, WAIT).toHaveStyle({ borderRadius: '50%' });
    expect(regionOf(submit.element()), '变异不改提交按钮的位置与大小').toEqual(region);
    const mutated = await recordRun(
      H5_FIND_ORDER,
      'light',
      'mutation',
      await capture(),
      reference,
      region,
    );
    expect(mutated.diffPercent, '变异后提交按钮区域与参照图的差异百分比').toBeGreaterThan(
      THRESHOLD_PERCENT,
    );
    expect(mutated.overThreshold, '报告标出该页超过阈值').toBe(true);
    expect(await readEntry('mutation', H5_FIND_ORDER, 'light')).toMatchObject({
      page: 'h5-find-order',
      theme: 'light',
      variant: 'mutation',
      comparedWith: 'run',
      region,
      overThreshold: true,
    });

    setMutation(false);
    await settle();
    await expect.element(submit, WAIT).not.toHaveStyle({ borderRadius: '50%' });
    const after = await capture();
    const restored = await recordRun(
      H5_FIND_ORDER,
      'light',
      'mutation-off',
      after,
      reference,
      null,
    );
    expect(restored.diffPercent, '关掉变异开关后整页与参照图的差异百分比').toBeLessThan(
      STABLE_PERCENT,
    );
    expect(restored.overThreshold).toBe(false);
    const button = await compareCaptures(after, reference, region);
    expect(button.diffPercent, '关掉变异开关后提交按钮区域与参照图的差异百分比').toBeLessThan(
      THRESHOLD_PERCENT,
    );
  },
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-STABLE#1] 规则页（浅色）同一次运行连截两次差异小于 0.1%，并与基准比对',
  async () => {
    await enterStableEnvironment({ theme: 'light', now: H5_NOW, viewport: H5_RULES.viewport });
    await openRules();
    await quiet();
    const first = await capture();
    await settle();
    const second = await capture();
    const repeat = await compareCaptures(second, first);
    const entry = await record(H5_RULES, 'light', 'stability', second, repeat.diffPercent);
    expectBaseline(entry);
    expect(repeat.diffPercent, '同一页连截两次的差异百分比').toBeLessThan(STABLE_PERCENT);
    expect(entry.diffPercent, '第二张截图与基准的差异百分比').toEqual(expect.any(Number));
  },
  CASE_TIMEOUT,
);

// Runs last in this file: reads back the entries the comparison cases above wrote in this run.
it(
  '[AC-DSX-50-REPORT#1] 报告 test/.tmp/visual-baseline/ 含 H5 七页浅深共 14 项的差异百分比',
  async () => {
    const problems: string[] = [];
    for (const target of H5_PAGES) {
      for (const theme of target.themes) {
        const entry = await readEntry('page', target, theme);
        if (entry === null) problems.push(`${target.id}-${theme}：报告里没有这一页`);
        else if (typeof entry.diffPercent !== 'number')
          problems.push(`${target.id}-${theme}：没有差异百分比（基准缺失）`);
      }
    }
    expect(problems).toEqual([]);
  },
  CASE_TIMEOUT,
);
