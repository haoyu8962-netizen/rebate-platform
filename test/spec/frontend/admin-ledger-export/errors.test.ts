// @vitest-environment jsdom
// F1-08fb 依据摘录 4: distinguish a definite refusal from an unknown creation result.
import { expect, it } from 'vitest';
import {
  FILTER_LABEL,
  UID,
  denied,
  failure,
  rejected,
  subAccountName,
} from '../admin-ledger-readonly/fixtures.ts';
import {
  applyFilters,
  choose,
  filterForm,
  isDisabled,
  mountLedger,
  ownTexts,
  queryUser,
  settled,
  tableRows,
} from '../admin-ledger-readonly/helpers.ts';
import { EXPORTER, createServer } from './fixtures.ts';
import {
  expectOnlyExportsWritten,
  expectRequest,
  expectSuccess,
  exportButton,
  notice,
  submit,
} from './helpers.ts';

async function failedThenManualExport(reply: () => Response | Promise<Response>, text: string) {
  const server = createServer();
  server.replyNext(reply);
  await mountLedger(server, EXPORTER);
  await queryUser(server, UID);
  const reads = server.pageReads();
  const rows = tableRows();
  await submit(server);
  await notice(text);
  await settled(server);
  expect(ownTexts(document.body).filter((text) => /^已创建导出任务 /.test(text))).toEqual([]);
  expectRequest(server.exportPosts()[0]!, { user_id: UID });
  expect(server.exportPosts()).toHaveLength(1);
  expectOnlyExportsWritten(server, 1);
  expect(isDisabled(exportButton())).toBe(false);
  expect(window.location.pathname).toBe('/ledger');
  expect(server.pageReads()).toEqual(reads);
  expect(tableRows()).toEqual(rows);
  expect(server.requests.filter((sent) => sent.method === 'GET')).toHaveLength(reads.length);

  // A later, deliberate click is a new export using the conditions applied after the failure.
  await choose(filterForm(), FILTER_LABEL.subAccount, subAccountName('frozen'));
  await applyFilters(server);
  expect(server.exportPosts()).toHaveLength(1);
  const laterReads = server.pageReads();
  await submit(server);
  expectRequest(server.exportPosts()[1]!, { user_id: UID, sub_account: 'frozen' });
  await expectSuccess(server, 'EX20261117000001');
  expectOnlyExportsWritten(server, 2);
  expect(server.pageReads()).toEqual(laterReads);
  return server;
}

it(
  '[AC-F1-08fb-ERROR#1] 10403 明确提示没有导出权限，不重发；按钮恢复后手动导出使用新筛选',
  { timeout: 60_000 },
  async () => {
    const server = await failedThenManualExport(
      () => denied(),
      '当前账号没有导出权限，未创建导出任务。',
    );
    expect(server.exportPosts()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08fb-ERROR#2] 20001 两个会计日字段提示起不能晚于止，不重发，允许按新条件手动导出',
  { timeout: 60_000 },
  async () => {
    const server = await failedThenManualExport(
      () => rejected(['accounting_date_from', 'accounting_date_to']),
      '会计日起不能晚于止，未创建导出任务。',
    );
    expect(server.exportPosts()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08fb-ERROR#3] 20001 fields 只含 accounting_date_from 仍显示会计日提示并恢复按钮',
  { timeout: 60_000 },
  async () => {
    const server = await failedThenManualExport(
      () => rejected(['accounting_date_from']),
      '会计日起不能晚于止，未创建导出任务。',
    );
    expect(server.exportPosts()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08fb-ERROR#4] 20001 fields 只含 accounting_date_to 仍显示会计日提示并恢复按钮',
  { timeout: 60_000 },
  async () => {
    const server = await failedThenManualExport(
      () => rejected(['accounting_date_to']),
      '会计日起不能晚于止，未创建导出任务。',
    );
    expect(server.exportPosts()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08fb-ERROR#5] 20001 非会计日字段是其他确定失败，不误报日期或创建成功，不自动重发',
  { timeout: 60_000 },
  async () => {
    const server = await failedThenManualExport(
      () => rejected(['user_id']),
      '导出任务未能创建，请稍后再试。',
    );
    expect(server.exportPosts()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08fb-ERROR#6] HTTP 500 带统一失败外壳是确定失败，不冒充网络结果未知，不自动重发',
  { timeout: 60_000 },
  async () => {
    const server = await failedThenManualExport(
      () => failure(50001, null, '服务暂时不可用'),
      '导出任务未能创建，请稍后再试。',
    );
    expect(server.exportPosts()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08fb-ERROR#7] 网络抛错提示可能已创建、先核对导出记录，不自动重发；手动再点发新筛选',
  { timeout: 60_000 },
  async () => {
    const server = await failedThenManualExport(
      () => Promise.reject(new TypeError('Failed to fetch')),
      '导出任务可能已创建，请先到【导出记录】核对，再决定是否重新导出。',
    );
    expect(server.exportPosts()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08fb-ERROR#8] HTTP 502 无法解析的响应提示结果未知并核对导出记录，不自动重发',
  { timeout: 60_000 },
  async () => {
    const server = await failedThenManualExport(
      () => new Response('<html>Bad Gateway</html>', { status: 502 }),
      '导出任务可能已创建，请先到【导出记录】核对，再决定是否重新导出。',
    );
    expect(server.exportPosts()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08fb-ERROR#9] HTTP 202 JSON 但没有统一外壳也提示结果未知，不推断创建成功、不重发',
  { timeout: 60_000 },
  async () => {
    const server = await failedThenManualExport(
      () => Response.json({ accepted: true }, { status: 202 }),
      '导出任务可能已创建，请先到【导出记录】核对，再决定是否重新导出。',
    );
    expect(server.exportPosts()).toHaveLength(2);
  },
);
