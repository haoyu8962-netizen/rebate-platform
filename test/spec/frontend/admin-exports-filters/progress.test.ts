// @vitest-environment jsdom
// F1-08fd 要的行为 4 and 5: while the page shown has a pending or running row, the page reads the
// same page with the same filters again at a fixed interval (the page's own constant, measured
// here on faked timers) and shows a running row's progress as 「进度 N%」 (texts/exports.ts);
// once every row of the page is final it stops; a tab change or leaving the page drops the old
// timer; a failed reread shows no error and the next one goes ahead. No 【重新导出】 at any point.
import { cleanup } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  COPY,
  DONE_PATCH,
  EXPORTS,
  createServer,
  exportRow,
  ids,
  listQuery,
  series,
  unavailable,
  update,
} from './exports-fixtures.ts';
import {
  CAP_MS,
  STEP_MS,
  actionsOf,
  chooseTab,
  expectNoError,
  expectNoReexport,
  mount,
  nextPage,
  nextRead,
  quietFor,
  reads,
  readsDone,
  rowsAre,
  statusOf,
} from './exports-helpers.ts';

it(
  '[AC-F1-08fd-PROGRESS#1] 当前页有生成中的行时按固定间隔重读同一页同一页签，生成中行显示「进度 N%」随重读更新',
  { timeout: 120_000 },
  async () => {
    const running = series('exp_PollRun', 25, 'running', { resource: 'users', progress: 10 });
    const done = series('exp_PollDone', 3, 'done');
    const server = createServer(undefined, [...running, ...done]);
    await mount(server, { fakeTimers: true });
    await readsDone(server, 1);

    await chooseTab(server, '生成中');
    await nextPage(server);
    const pageTwo = listQuery({ page: '2', status: 'running' });
    expect(reads(server)).toEqual([listQuery(), listQuery({ status: 'running' }), pageTwo]);
    const shown = ids(running.slice(20));
    await rowsAre(shown);
    expect(statusOf(shown[0]!)).toEqual(['生成中', '进度 10%']);

    update(server, shown[0]!, { progress: 60 });
    const first = await nextRead(server);
    expect(reads(server)[3]).toEqual(pageTwo);
    await rowsAre(shown);
    expect(statusOf(shown[0]!)).toEqual(['生成中', '进度 60%']);
    expect(statusOf(shown[1]!)).toEqual(['生成中', '进度 10%']);

    update(server, shown[1]!, { progress: 90 });
    const second = await nextRead(server);
    expect(reads(server)[4]).toEqual(pageTwo);
    expect(statusOf(shown[1]!)).toEqual(['生成中', '进度 90%']);
    // A fixed interval: the second wait is the first one (to the step of the fake clock).
    expect(Math.abs(second - first)).toBeLessThanOrEqual(STEP_MS);

    await nextRead(server);
    expect(reads(server)).toEqual([
      listQuery(),
      listQuery({ status: 'running' }),
      pageTwo,
      pageTwo,
      pageTwo,
      pageTwo,
    ]);
    expectNoReexport();
  },
);

it(
  '[AC-F1-08fd-PROGRESS#2] 排队中的行也触发重读，转生成中显示进度、到已完成后出现【下载】，当前页全部终态后不再重读；任何行都没有【重新导出】',
  { timeout: 120_000 },
  async () => {
    const queued = exportRow('exp_PollQueued0001', 'pending', { resource: 'ledger' });
    const done = exportRow('exp_PollDoneRow001', 'done');
    const failed = exportRow('exp_PollFailRow001', 'failed');
    const expired = exportRow('exp_PollExpired001', 'expired');
    const cancelled = exportRow('exp_PollCancel0001', 'cancelled', { resource: 'users' });
    const tasks = [queued, done, failed, expired, cancelled];
    const server = createServer(undefined, tasks);
    await mount(server, { fakeTimers: true });
    await readsDone(server, 1);
    await rowsAre(ids(tasks));
    expect(statusOf(queued.id)).toEqual(['排队中']);

    update(server, queued.id, { status: 'running', progress: 45 });
    await nextRead(server);
    expect(statusOf(queued.id)).toEqual(['生成中', '进度 45%']);
    expect(actionsOf(queued.id)).toEqual([]);

    update(server, queued.id, DONE_PATCH);
    await nextRead(server);
    expect(statusOf(queued.id)).toEqual(['已完成', '30 行']);
    expect(actionsOf(queued.id)).toEqual([COPY.download]);

    // Every row of the page is final now: no more rereads.
    await quietFor(server, CAP_MS);
    expect(reads(server)).toEqual([listQuery(), listQuery(), listQuery()]);
    expect(tasks.map((task) => actionsOf(task.id))).toEqual([
      [COPY.download],
      [COPY.download],
      [COPY.retry],
      [],
      [],
    ]);
    expectNoReexport();
  },
);

it(
  '[AC-F1-08fd-PROGRESS#3] 某次重读失败不弹错误、列表与进度保留，下一次按原间隔照常重读并更新进度',
  { timeout: 120_000 },
  async () => {
    const running = exportRow('exp_PollFlaky00001', 'running', {
      resource: 'users',
      progress: 20,
    });
    const done = exportRow('exp_PollFlakyDone1', 'done');
    const server = createServer(undefined, [running, done]);
    await mount(server, { fakeTimers: true });
    await readsDone(server, 1);
    await rowsAre([running.id, done.id]);
    expect(statusOf(running.id)).toEqual(['生成中', '进度 20%']);

    const first = await nextRead(server);

    server.once('GET', EXPORTS, () => unavailable());
    await nextRead(server);
    expectNoError();
    await rowsAre([running.id, done.id]);
    expect(statusOf(running.id)).toEqual(['生成中', '进度 20%']);
    expect(actionsOf(done.id)).toEqual([COPY.download]);

    update(server, running.id, { progress: 80 });
    const third = await nextRead(server);
    expect(Math.abs(third - first)).toBeLessThanOrEqual(STEP_MS);
    expectNoError();
    expect(statusOf(running.id)).toEqual(['生成中', '进度 80%']);
    expect(reads(server)).toEqual([listQuery(), listQuery(), listQuery(), listQuery()]);
  },
);

it(
  '[AC-F1-08fd-PROGRESS#4] 切页签后旧定时器不再发请求（新页签无在途行即不重读、有则按新条件重读），卸载后不再发任何请求',
  { timeout: 120_000 },
  async () => {
    const running = exportRow('exp_PollSwitch0001', 'running', { resource: 'users' });
    const done = exportRow('exp_PollSwitchDone', 'done');
    const cancelled = exportRow('exp_PollSwitchCanc', 'cancelled');
    const server = createServer(undefined, [running, done, cancelled]);
    await mount(server, { fakeTimers: true });
    await readsDone(server, 1);
    await rowsAre([running.id, done.id, cancelled.id]);

    const first = await nextRead(server);

    await chooseTab(server, '已完成');
    await rowsAre([done.id]);
    await quietFor(server, CAP_MS);

    await chooseTab(server, '全部');
    await rowsAre([running.id, done.id, cancelled.id]);
    const again = await nextRead(server);
    expect(Math.abs(again - first)).toBeLessThanOrEqual(STEP_MS);

    await chooseTab(server, '生成中');
    await rowsAre([running.id]);
    await nextRead(server);

    expect(reads(server)).toEqual([
      listQuery(),
      listQuery(),
      listQuery({ status: 'done' }),
      listQuery(),
      listQuery(),
      listQuery({ status: 'running' }),
      listQuery({ status: 'running' }),
    ]);

    // Leaving the page: no request at all afterwards.
    const sent = server.log.length;
    cleanup();
    await quietFor(server, CAP_MS);
    expect(server.log).toHaveLength(sent);
  },
);
