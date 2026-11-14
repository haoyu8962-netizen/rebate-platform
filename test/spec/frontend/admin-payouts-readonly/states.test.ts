// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  EXECUTE,
  LIST,
  OVERVIEW,
  QNO,
  REVIEW,
  UNKNOWN,
  VIEW,
  VIEW_EXECUTE,
  createPayoutServer,
  failure,
  getOf,
  type RequestLog,
} from './fixtures.ts';
import {
  EMPTY,
  FIELD,
  FLOW_TIMEOUT,
  FORBIDDEN,
  LOAD_FAILED,
  MULTI_TIMEOUT,
  TAB,
  click,
  entry,
  everyGrant,
  exactTexts,
  listed,
  loadingIn,
  mount,
  numbersIn,
  openTab,
  settled,
  textOf,
  values,
} from './helpers.ts';

// F1-08ba ⑥: the states of the two tabs. While a read is on its way the tab shows that it is
// loading; a failed read (50001) shows a failure with a 【重试】 that reads again; an empty answer
// shows the empty notice; 10403 shows the no-permission notice. The overview cards and the queue
// table are independent: one failing does not hide the other.

const ALL_ROWS = [QNO.approvedA, QNO.paying, QNO.approvedB, QNO.stuck, QNO.untried];
const UNKNOWN_ROWS = [QNO.stuck, QNO.untried];
const RETRY_NAME = '重试';
/** The W of the overview sample as the card shows it. */
const W_SHOWN = '¥30,000.00';

/** A read of the queue table (GET /admin/v1/withdrawals with status=PAYING). */
const payingRead = (request: RequestLog): boolean =>
  request.method === 'GET' && request.path === LIST && request.query['status'] === 'PAYING';
/** A read of the queue table (GET /admin/v1/withdrawals with status APPROVED or PAYING). */
const queueRead = (request: RequestLog): boolean =>
  request.method === 'GET' &&
  request.path === LIST &&
  ['APPROVED', 'PAYING'].includes(request.query['status'] ?? '');
const serverError = (): Response => failure(50001, undefined, '服务异常');

it(
  '[AC-F1-08ba-STATES#1] 加载中：payout-overview 与队列表请求未返回时「打款队列」显示加载中、不显示卡片值与行；返回后显示 W 与 5 张单、不再显示加载中；unknown-payouts 未返回时「结果待确认」同样显示加载中，返回后列出 2 张',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({ permissions: VIEW_EXECUTE });
    await mount(server, everyGrant(VIEW_EXECUTE));
    await settled(server);
    const releaseOverview = server.holdWhere(getOf(OVERVIEW));
    const releaseQueue = server.holdWhere(queueRead);
    const queue = await openTab(TAB.queue);
    await waitFor(() => expect(server.overviewReads()).toHaveLength(1));
    await waitFor(() => expect(loadingIn(queue), 'loading').toBe(true));
    expect(exactTexts(queue, [W_SHOWN]), 'no W yet').toEqual([]);
    expect(numbersIn(queue), 'no rows yet').toEqual([]);
    releaseOverview();
    releaseQueue();
    await settled(server);
    await waitFor(() => expect(values(queue, FIELD.available)).toEqual([W_SHOWN]));
    await listed(queue, ALL_ROWS);
    await waitFor(() => expect(loadingIn(queue), 'loaded').toBe(false));

    const releaseUnknown = server.holdWhere(getOf(UNKNOWN));
    const unknown = await openTab(TAB.unknown);
    await waitFor(() => expect(server.unknownReads()).toHaveLength(1));
    await waitFor(() => expect(loadingIn(unknown), 'loading').toBe(true));
    expect(numbersIn(unknown), 'no rows yet').toEqual([]);
    releaseUnknown();
    await settled(server);
    await listed(unknown, UNKNOWN_ROWS);
    await waitFor(() => expect(loadingIn(unknown), 'loaded').toBe(false));
  },
);

it(
  '[AC-F1-08ba-STATES#2] payout-overview 失败（50001）：卡片处显示失败与【重试】、不显示 W，队列表照常列出 5 张；点【重试】再读一次 payout-overview 并显示 W ¥30,000.00',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({ permissions: VIEW_EXECUTE });
    server.onceWhere(getOf(OVERVIEW), serverError);
    await mount(server, everyGrant(VIEW_EXECUTE));
    const queue = await openTab(TAB.queue);
    await waitFor(() => expect(textOf(queue)).toMatch(LOAD_FAILED));
    await listed(queue, ALL_ROWS);
    await settled(server);
    expect(exactTexts(queue, [W_SHOWN]), 'no W').toEqual([]);
    await click(entry(queue, RETRY_NAME));
    await waitFor(() => expect(server.overviewReads()).toHaveLength(2));
    await settled(server);
    await waitFor(() => expect(values(queue, FIELD.available)).toEqual([W_SHOWN]));
  },
);

it(
  '[AC-F1-08ba-STATES#3] 队列表请求失败（50001）：队列表显示失败与【重试】、不显示行，卡片照常显示 W；点【重试】重读后列出 5 张',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({ permissions: VIEW_EXECUTE });
    await mount(server, everyGrant(VIEW_EXECUTE));
    await settled(server);
    server.onceWhere(payingRead, serverError);
    const queue = await openTab(TAB.queue);
    await waitFor(() => expect(textOf(queue)).toMatch(LOAD_FAILED));
    await settled(server);
    expect(numbersIn(queue), 'no rows').toEqual([]);
    await waitFor(() => expect(values(queue, FIELD.available)).toEqual([W_SHOWN]));
    const reads = server.queueReads().length;
    await click(entry(queue, RETRY_NAME));
    await waitFor(() => expect(server.queueReads().length).toBeGreaterThan(reads));
    await settled(server);
    await listed(queue, ALL_ROWS);
  },
);

it(
  '[AC-F1-08ba-STATES#4] unknown-payouts 失败（50001）：「结果待确认」显示失败与【重试】、不显示行；点【重试】再读一次并列出 2 张',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({ permissions: VIEW_EXECUTE });
    server.onceWhere(getOf(UNKNOWN), serverError);
    await mount(server, everyGrant(VIEW_EXECUTE));
    const unknown = await openTab(TAB.unknown);
    await waitFor(() => expect(textOf(unknown)).toMatch(LOAD_FAILED));
    await settled(server);
    expect(numbersIn(unknown), 'no rows').toEqual([]);
    await click(entry(unknown, RETRY_NAME));
    await waitFor(() => expect(server.unknownReads()).toHaveLength(2));
    await settled(server);
    await listed(unknown, UNKNOWN_ROWS);
  },
);

it(
  '[AC-F1-08ba-STATES#5] 空列表：队列没有待执行与打款中的单时「打款队列」显示空态、没有行（卡片照常）；unknown-payouts 为空时「结果待确认」显示空态、没有行',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({
      withdrawals: [],
      unknown: [],
      permissions: VIEW_EXECUTE,
    });
    await mount(server, everyGrant(VIEW_EXECUTE));
    const queue = await openTab(TAB.queue);
    await waitFor(() => expect(server.queueReads().length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(textOf(queue)).toMatch(EMPTY));
    expect(numbersIn(queue), 'no rows').toEqual([]);
    await waitFor(() => expect(values(queue, FIELD.available)).toEqual([W_SHOWN]));

    const unknown = await openTab(TAB.unknown);
    await waitFor(() => expect(server.unknownReads()).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(textOf(unknown)).toMatch(EMPTY));
    expect(numbersIn(unknown), 'no rows').toEqual([]);
  },
);

it(
  '[AC-F1-08ba-STATES#6] 10403（快照有 fund.view + payout.execute、服务端只认 withdraw.review）：payout-overview 与 unknown-payouts 各请求一次，两个页签都显示无权限、不显示 W 与结果待确认的行，队列表照常列出 5 张',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({ permissions: REVIEW });
    await mount(server, everyGrant(VIEW_EXECUTE));
    const queue = await openTab(TAB.queue);
    await waitFor(() => expect(server.overviewReads()).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(textOf(queue)).toMatch(FORBIDDEN));
    expect(exactTexts(queue, [W_SHOWN]), 'no W').toEqual([]);
    await listed(queue, ALL_ROWS);

    const unknown = await openTab(TAB.unknown);
    await waitFor(() => expect(server.unknownReads()).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(textOf(unknown)).toMatch(FORBIDDEN));
    expect(numbersIn(unknown), 'no rows').toEqual([]);
  },
);

it(
  '[AC-F1-08ba-STATES#7] 只持 payout.execute（读不了提现单）：「打款队列」卡片照常显示 W、队列表处显示无权限且没有行；只持 fund.view（读不了 unknown-payouts）：「结果待确认」显示无权限且没有行',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const executor = createPayoutServer({ permissions: EXECUTE });
    await mount(executor, everyGrant(EXECUTE));
    const queue = await openTab(TAB.queue);
    await waitFor(() => expect(values(queue, FIELD.available)).toEqual([W_SHOWN]));
    await settled(executor);
    await waitFor(() => expect(textOf(queue)).toMatch(FORBIDDEN));
    expect(numbersIn(queue), 'no rows').toEqual([]);
    cleanup();

    const viewer = createPayoutServer({ permissions: VIEW });
    await mount(viewer, everyGrant(VIEW));
    const unknown = await openTab(TAB.unknown);
    await settled(viewer);
    await waitFor(() => expect(textOf(unknown)).toMatch(FORBIDDEN));
    expect(numbersIn(unknown), 'no rows').toEqual([]);
  },
);
