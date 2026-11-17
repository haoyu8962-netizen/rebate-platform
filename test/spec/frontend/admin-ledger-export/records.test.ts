// @vitest-environment jsdom
// F1-08fb 依据摘录 5: assert the rendered resource column, not only a lookup function.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { EXPORTS } from '../admin-ledger-readonly/fixtures.ts';
import {
  click,
  control,
  main,
  mountLedger,
  pageTitle,
  settled,
  tableRows,
  tableTitles,
} from '../admin-ledger-readonly/helpers.ts';
import { EXPORTER, createServer, task } from './fixtures.ts';

it(
  '[AC-F1-08fb-RECORDS#1] 标题行导出记录入口照旧，资源列 ledger 显示余额流水，users 与 audit_logs 名称不变',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    server.records.push(
      task('EX20261117000011', 'ledger'),
      task('EX20261117000012', 'users'),
      task('EX20261117000013', 'audit_logs'),
    );
    await mountLedger(server, EXPORTER);
    await click(control(main(), '导出记录'));
    await settled(server);
    await waitFor(() => expect(tableRows()).toHaveLength(3));
    expect(window.location.pathname).toBe('/exports');
    expect(pageTitle()).toBe('导出记录');
    const titles = tableTitles();
    const resourceColumn = titles.indexOf('资源');
    const idColumn = titles.indexOf('任务编号');
    expect(resourceColumn).toBeGreaterThanOrEqual(0);
    expect(idColumn).toBeGreaterThanOrEqual(0);
    expect(tableRows().map((cells) => [cells[idColumn], cells[resourceColumn]])).toEqual([
      ['EX20261117000011', '余额流水'],
      ['EX20261117000012', '用户列表'],
      ['EX20261117000013', '操作日志'],
    ]);
    expect(server.requests.map((sent) => [sent.method, sent.path])).toEqual([['GET', EXPORTS]]);
    expect(server.exportPosts()).toEqual([]);
  },
);
