// @vitest-environment jsdom
import { expect, it } from 'vitest';
import {
  ADJ,
  ADJUSTMENT_ORDER,
  COLUMN,
  TEXT,
  VIEW_GRANTS,
  WRITEOFF_COLUMN,
  WRITEOFF_ORDER,
  createServer,
} from './fixtures.ts';
import {
  assertNoStepUp,
  buttons,
  mount,
  openDetail,
  openTab,
  settled,
  waitColumn,
} from './helpers.ts';

/**
 * The entries of the writes that come later (F1-08cb new form and reversal, F1-08cc approve and
 * reject of a prefilled form, F1-08cd approve a write-off): fund.view never gets any of them,
 * neither shown nor disabled (buttons are hidden by status and permission point, not greyed out).
 */
const WRITE_ENTRIES: readonly string[] = [
  '新建调账',
  '调整余额',
  '提交并生效',
  '红冲',
  '批准',
  '批准并短信验证',
  '驳回',
  '批准核销',
  '核销',
  '撤回',
];

/** Every write entry found on the whole page (main area, drawer, dialogs), by name. */
function writeEntries(): string[] {
  return WRITE_ENTRIES.filter((name) => buttons(document.body, name).length > 0);
}

it(
  '[AC-F1-08ca-READONLY#1] 只持 fund.view：调账单列表、已生效未红冲单与系统预填待批单的详情、坏账核销候选单（含 PENDING）都不出现【新建调账】【红冲】【批准并短信验证】【驳回】【批准核销】等写入口；全程只发三个 GET、不弹验证',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    expect(writeEntries()).toEqual([]);

    await openDetail(server, ADJ.reconFix);
    expect(writeEntries()).toEqual([]);
    await openDetail(server, ADJ.prefilled);
    expect(writeEntries()).toEqual([]);

    await openTab(TEXT.writeoffsTab);
    await waitColumn(WRITEOFF_COLUMN.id, WRITEOFF_ORDER);
    await settled(server);
    expect(writeEntries()).toEqual([]);

    expect(server.log.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(server.others()).toEqual([]);
    assertNoStepUp(server);
  },
);
