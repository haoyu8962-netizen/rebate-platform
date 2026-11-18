// @vitest-environment jsdom
// F1-08fd 要的行为 3 and 6: the status is seven tabs (全部 / 排队中 / 生成中 / 已完成 / 失败 /
// 已过期 / 已取消) without any count; a tab sends `status=<value>` at once (全部 none) from page 1;
// the old status Select is gone. Status, 来源页面 and 发起时间 combine in one request and paging
// keeps them. Without `export` the page still says so and sends nothing.
import { within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  COPY,
  FROM_DAY,
  FROM_SENT,
  TAB_NAMES,
  TO_DAY,
  TO_SENT,
  createServer,
  exportRow,
  ids,
  listQuery,
  series,
} from './exports-fixtures.ts';
import {
  chooseSource,
  chooseTab,
  expectNoCounts,
  leaveTime,
  main,
  mount,
  nextPage,
  pause,
  query,
  reads,
  readsDone,
  rowIds,
  rowsAre,
  selectedTabs,
  tabNames,
  timeInputs,
  typeDay,
  unmount,
  until,
} from './exports-helpers.ts';

it(
  '[AC-F1-08fd-TABS#1] 状态为七个页签且不带计数、原状态 Select 不再出现，切页签即带 status（全部不带）并回第 1 页；无 export 照旧整页无权限、不发请求',
  { timeout: 120_000 },
  async () => {
    const done = series('exp_TabDone', 25, 'done');
    const failed = series('exp_TabFail', 2, 'failed');
    const expired = exportRow('exp_TabExpired0001', 'expired');
    const cancelled = exportRow('exp_TabCancel00001', 'cancelled');
    const tasks = [...done, ...failed, expired, cancelled];
    const server = createServer(undefined, tasks);
    await mount(server);
    await readsDone(server, 1);
    await rowsAre(ids(tasks.slice(0, 20)));

    expect(tabNames()).toEqual(TAB_NAMES);
    expect(selectedTabs()).toEqual(['全部']);
    expectNoCounts();
    expect(within(main()).queryAllByRole('combobox', { name: '状态' })).toHaveLength(0);

    await nextPage(server);
    expect(reads(server)[1]).toEqual(listQuery({ page: '2' }));
    await rowsAre(ids(tasks.slice(20)));

    await chooseTab(server, '失败');
    expect(reads(server)[2]).toEqual(listQuery({ status: 'failed' }));
    await rowsAre(ids(failed));
    expect(selectedTabs()).toEqual(['失败']);
    expect(tabNames()).toEqual(TAB_NAMES);
    expectNoCounts();

    await chooseTab(server, '全部');
    expect(reads(server)[3]).toEqual(listQuery());
    await rowsAre(ids(tasks.slice(0, 20)));

    await chooseTab(server, '已过期');
    expect(reads(server)[4]).toEqual(listQuery({ status: 'expired' }));
    await rowsAre([expired.id]);

    await chooseTab(server, '已取消');
    expect(reads(server)).toEqual([
      listQuery(),
      listQuery({ page: '2' }),
      listQuery({ status: 'failed' }),
      listQuery(),
      listQuery({ status: 'expired' }),
      listQuery({ status: 'cancelled' }),
    ]);
    await rowsAre([cancelled.id]);
    expect(tabNames()).toEqual(TAB_NAMES);
    expectNoCounts();

    // Without `export`: the whole page says so, no tab, no filter, no request.
    unmount();
    const denied = createServer(undefined, tasks);
    await mount(denied, { permissions: { isSuper: false, permissions: ['user.list'] } });
    await until(
      () => document.querySelector('main .ant-result-title') !== null,
      'the no-permission result',
    );
    for (let round = 0; round < 5; round += 1) await pause();
    expect(main().querySelector('.ant-result-title')?.textContent?.trim()).toBe(
      COPY.forbiddenTitle,
    );
    expect(tabNames()).toEqual([]);
    expect(within(main()).queryAllByRole('combobox')).toHaveLength(0);
    expect(rowIds()).toEqual([]);
    expect(reads(denied)).toEqual([]);
  },
);

it(
  '[AC-F1-08fd-TABS#2] 状态页签、来源页面、发起时间可组合：同一请求同时带 status resource from to，翻页保留，切页签回第 1 页仍带来源与时间',
  { timeout: 120_000 },
  async () => {
    const audits = series('exp_MixAudit', 25, 'done', { created_at: '2026-10-18T02:00:00Z' });
    const usersDone = series('exp_MixUsers', 2, 'done', {
      resource: 'users',
      created_at: '2026-10-18T03:00:00Z',
    });
    const outside = exportRow('exp_MixOutside001', 'done', { created_at: '2026-10-16T02:00:00Z' });
    const auditFailed = exportRow('exp_MixAuditFail01', 'failed', {
      created_at: '2026-10-19T02:00:00Z',
    });
    const usersFailed = exportRow('exp_MixUsersFail01', 'failed', {
      resource: 'users',
      created_at: '2026-10-19T02:00:00Z',
    });
    const tasks = [...audits, ...usersDone, outside, auditFailed, usersFailed];
    const server = createServer(undefined, tasks);
    await mount(server);
    await readsDone(server, 1);

    await chooseTab(server, '已完成');
    expect(reads(server)[1]).toEqual(listQuery({ status: 'done' }));
    await rowsAre(ids(audits.slice(0, 20)));

    await chooseSource('操作日志');
    const [start, end] = timeInputs();
    await typeDay(start!, FROM_DAY);
    await typeDay(end!, TO_DAY);
    await leaveTime();
    expect(reads(server)).toHaveLength(2);
    expect(rowIds()).toEqual(ids(audits.slice(0, 20)));

    const combined = { status: 'done', resource: 'audit_logs', from: FROM_SENT, to: TO_SENT };
    await query(server);
    expect(reads(server)[2]).toEqual(listQuery(combined));
    await rowsAre(ids(audits.slice(0, 20)));

    await nextPage(server);
    expect(reads(server)[3]).toEqual(listQuery({ ...combined, page: '2' }));
    await rowsAre(ids(audits.slice(20)));

    await chooseTab(server, '失败');
    expect(reads(server)).toEqual([
      listQuery(),
      listQuery({ status: 'done' }),
      listQuery(combined),
      listQuery({ ...combined, page: '2' }),
      listQuery({ ...combined, status: 'failed' }),
    ]);
    await rowsAre([auditFailed.id]);
    expect(selectedTabs()).toEqual(['失败']);
  },
);
