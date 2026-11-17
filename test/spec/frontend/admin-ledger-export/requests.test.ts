// @vitest-environment jsdom
// F1-08fb 依据摘录 2–3; adminCreateExport always creates a new task, with no paging.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  CLAWED,
  FILTER_LABEL,
  MANY_UID,
  PLAIN_UID,
  UID,
  subAccountName,
  typeName,
} from '../admin-ledger-readonly/fixtures.ts';
import {
  applyFilters,
  choose,
  click,
  fillDay,
  filterField,
  filterForm,
  isDisabled,
  mountLedger,
  nextPage,
  queryUser,
  resetFilters,
  settled,
  tableRows,
  typeInto,
  uidInput,
} from '../admin-ledger-readonly/helpers.ts';
import { EXPORTER, accepted, createServer, task } from './fixtures.ts';
import {
  expectOnlyExportsWritten,
  expectRequest,
  expectSuccess,
  exportButton,
  submit,
} from './helpers.ts';

it(
  '[AC-F1-08fb-REQUEST#1] 六个已生效筛选整包导出，未查询的 UID 与筛选草稿不进入请求；202 提示任务编号且不跳转、不重读流水',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server, EXPORTER);
    await queryUser(server, UID);
    await choose(filterForm(), FILTER_LABEL.ledgerType, typeName('CLAWBACK'));
    await typeInto(filterField(FILTER_LABEL.subType), 'PART_REFUND');
    await choose(filterForm(), FILTER_LABEL.subAccount, subAccountName('available'));
    await fillDay(filterField(FILTER_LABEL.dateFrom), '2026-11-01');
    await fillDay(filterField(FILTER_LABEL.dateTo), '2026-11-06');
    await typeInto(filterField(FILTER_LABEL.ref), CLAWED.voucher.biz_id);
    await applyFilters(server);

    await typeInto(uidInput(), PLAIN_UID);
    await choose(filterForm(), FILTER_LABEL.ledgerType, typeName('REWARD'));
    await typeInto(filterField(FILTER_LABEL.subType), 'invite');
    await choose(filterForm(), FILTER_LABEL.subAccount, subAccountName('frozen'));
    await fillDay(filterField(FILTER_LABEL.dateFrom), '2026-10-01');
    await fillDay(filterField(FILTER_LABEL.dateTo), '2026-10-02');
    await typeInto(filterField(FILTER_LABEL.ref), 'draft-only-ref');
    const reads = server.pageReads();
    const rows = tableRows();
    await submit(server);
    expectRequest(server.exportPosts()[0]!, {
      user_id: UID,
      ledger_type: 'CLAWBACK',
      sub_type: 'PART_REFUND',
      sub_account: 'available',
      accounting_date_from: '2026-11-01',
      accounting_date_to: '2026-11-06',
      ref: CLAWED.voucher.biz_id,
    });
    await expectSuccess(server, 'EX20261117000001');
    expectOnlyExportsWritten(server, 1);
    expect(server.pageReads()).toEqual(reads);
    expect(tableRows()).toEqual(rows);
    expect(server.requests.filter((sent) => sent.method === 'GET')).toHaveLength(reads.length);
  },
);

it(
  '[AC-F1-08fb-REQUEST#2] 第二页导出不带分页；重置后仅 user_id，换用户后使用新 UID，空筛选不发空串',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server, EXPORTER);
    await queryUser(server, MANY_UID);
    await choose(filterForm(), FILTER_LABEL.ledgerType, typeName('REBATE_CREDIT'));
    await applyFilters(server);
    await nextPage(server);
    expect(server.ledgerQueries().at(-1)?.['page']).toBe('2');
    await submit(server);
    expectRequest(server.exportPosts()[0]!, {
      user_id: MANY_UID,
      ledger_type: 'REBATE_CREDIT',
    });
    await expectSuccess(server, 'EX20261117000001');

    await resetFilters(server);
    await submit(server);
    expectRequest(server.exportPosts()[1]!, { user_id: MANY_UID });
    await expectSuccess(server, 'EX20261117000002');

    await queryUser(server, PLAIN_UID);
    await submit(server);
    expectRequest(server.exportPosts()[2]!, { user_id: PLAIN_UID });
    await expectSuccess(server, 'EX20261117000003');
    expectOnlyExportsWritten(server, 3);
  },
);

it(
  '[AC-F1-08fb-REQUEST#3] 同一轮连点与在途再点只发一次 POST；202 完成后按钮恢复可用，流水和摘要不重读',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    const held = Promise.withResolvers<Response>();
    server.replyNext(() => held.promise);
    await mountLedger(server, EXPORTER);
    await queryUser(server, UID);
    const reads = server.pageReads();
    try {
      await submit(server, true);
      await waitFor(() => expect(isDisabled(exportButton())).toBe(true));
      await click(exportButton());
      expect(server.exportPosts()).toHaveLength(1);
      expectRequest(server.exportPosts()[0]!, { user_id: UID });
      expectOnlyExportsWritten(server, 1);
      expect(server.pageReads()).toEqual(reads);
    } finally {
      held.resolve(accepted(task('EX20261117000999')));
    }
    await expectSuccess(server, 'EX20261117000999');
    await settled(server);
    expect(server.exportPosts()).toHaveLength(1);
    expect(server.pageReads()).toEqual(reads);
  },
);
