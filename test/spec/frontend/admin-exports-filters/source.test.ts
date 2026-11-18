// @vitest-environment jsdom
// F1-08fd 要的行为 1 and 5: 来源页面 lists every export_resource value (names from the resource
// table of texts/exports.ts, the code where there is none) after 全部; it applies on 【查询】 only,
// as `resource=<value>` (全部 sends none). No row of any status offers 【重新导出】.
import { expect, it } from 'vitest';
import {
  COPY,
  SOURCE_OPTIONS,
  createServer,
  exportRow,
  ids,
  listQuery,
} from './exports-fixtures.ts';
import {
  actionsOf,
  chooseSource,
  expectNoReexport,
  mount,
  pause,
  query,
  reads,
  readsDone,
  resourceOf,
  rowIds,
  rowsAre,
  sourceOptions,
  sourceShown,
} from './exports-helpers.ts';

const USERS_DONE = exportRow('exp_SrcUsersDone01', 'done', { resource: 'users' });
const AUDIT_FAILED = exportRow('exp_SrcAuditFail01', 'failed');
const TAX_DONE = exportRow('exp_SrcTaxDone0001', 'done', { resource: 'tax_withdrawals' });
const LEDGER_EXPIRED = exportRow('exp_SrcLedgerExp01', 'expired', { resource: 'ledger' });
const USERS_CANCELLED = exportRow('exp_SrcUsersCanc01', 'cancelled', { resource: 'users' });
const TASKS = [USERS_DONE, AUDIT_FAILED, TAX_DONE, LEDGER_EXPIRED, USERS_CANCELLED];

it(
  '[AC-F1-08fd-SOURCE#1] 来源页面列全部 export_resource（中文名取 resource 表、无名显示编码）外加全部，选定后按【查询】才带 resource，选全部不带；任何状态的行都没有【重新导出】',
  { timeout: 120_000 },
  async () => {
    const server = createServer(undefined, TASKS);
    await mount(server);
    await readsDone(server, 1);
    await rowsAre(ids(TASKS));

    expect(sourceShown()).toBe('全部');
    expect(await sourceOptions()).toEqual(SOURCE_OPTIONS);

    // Picking alone sends nothing and keeps the rows.
    await chooseSource('余额流水');
    for (let round = 0; round < 5; round += 1) await pause();
    expect(reads(server)).toHaveLength(1);
    expect(rowIds()).toEqual(ids(TASKS));

    await query(server);
    expect(reads(server)[1]).toEqual(listQuery({ resource: 'ledger' }));
    await rowsAre([LEDGER_EXPIRED.id]);
    expect(resourceOf(LEDGER_EXPIRED.id)).toBe('余额流水');

    await chooseSource('tax_withdrawals');
    await query(server);
    expect(reads(server)[2]).toEqual(listQuery({ resource: 'tax_withdrawals' }));
    await rowsAre([TAX_DONE.id]);
    expect(resourceOf(TAX_DONE.id)).toBe('tax_withdrawals');

    await chooseSource('用户列表');
    await query(server);
    expect(reads(server)[3]).toEqual(listQuery({ resource: 'users' }));
    await rowsAre([USERS_DONE.id, USERS_CANCELLED.id]);
    expect(resourceOf(USERS_DONE.id)).toBe('用户列表');

    await chooseSource('全部');
    await query(server);
    expect(reads(server)[4]).toEqual(listQuery());
    await rowsAre(ids(TASKS));
    expect(resourceOf(AUDIT_FAILED.id)).toBe('操作日志');

    expect(reads(server)).toEqual([
      listQuery(),
      listQuery({ resource: 'ledger' }),
      listQuery({ resource: 'tax_withdrawals' }),
      listQuery({ resource: 'users' }),
      listQuery(),
    ]);
    // 【下载】 and 【重试】 unchanged; nothing else in any row, 【重新导出】 nowhere.
    expect(TASKS.map((task) => actionsOf(task.id))).toEqual([
      [COPY.download],
      [COPY.retry],
      [COPY.download],
      [],
      [],
    ]);
    expectNoReexport();
    expect(server.log.filter((request) => request.method !== 'GET')).toEqual([]);
  },
);
