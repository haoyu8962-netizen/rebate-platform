// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJUSTMENTS,
  ADJUSTMENT_ORDER,
  ADJUST_GRANTS,
  COLUMN,
  OTHER_GRANTS,
  SUPER,
  TEXT,
  VIEW_GRANTS,
  WRITEOFFS,
  WRITEOFF_COLUMN,
  WRITEOFF_GRANTS,
  WRITEOFF_ORDER,
  createServer,
  snapshot,
} from './fixtures.ts';
import {
  dataRowCount,
  hasText,
  main,
  menuLinks,
  mount,
  settled,
  tabNames,
  waitColumn,
} from './helpers.ts';

// Read points (contracts/openapi.yaml): adminListAdjustments and adminGetAdjustment take any of
// fund.adjust or fund.view; adminListBadDebtWriteoffs any of fund.writeoff or fund.view. The menu
// stays as apps/admin/src/resources has it (fund.adjust or fund.writeoff).

it(
  '[AC-F1-08ca-ACCESS#1] 只持 fund.adjust：菜单「调账与核销」恰 1 个，页签只有「调账单」并按返回顺序列出八张调账单；不请求坏账核销候选单',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: ADJUST_GRANTS });
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    expect(menuLinks()).toHaveLength(1);
    expect(tabNames()).toEqual([TEXT.adjustmentsTab]);
    expect(server.requestsUnder(WRITEOFFS)).toEqual([]);
    expect(hasText(main(), TEXT.forbidden)).toBe(false);
  },
);

it(
  '[AC-F1-08ca-ACCESS#2] 只持 fund.writeoff：菜单恰 1 个，页签只有「坏账核销」并列出四张候选单；不发任何调账单请求',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: WRITEOFF_GRANTS });
    await mount(server);
    await waitColumn(WRITEOFF_COLUMN.id, WRITEOFF_ORDER);
    await settled(server);
    expect(menuLinks()).toHaveLength(1);
    expect(tabNames()).toEqual([TEXT.writeoffsTab]);
    expect(server.requestsUnder(ADJUSTMENTS)).toEqual([]);
    expect(hasText(main(), TEXT.forbidden)).toBe(false);
  },
);

it(
  '[AC-F1-08ca-ACCESS#3] 只持 fund.view：菜单不出现（菜单不改），直达 /adjustments 照常只读：两个页签「调账单」「坏账核销」，先列出调账单',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    expect(menuLinks()).toEqual([]);
    expect(tabNames()).toEqual([TEXT.adjustmentsTab, TEXT.writeoffsTab]);
    expect(hasText(main(), TEXT.forbidden)).toBe(false);
  },
);

it(
  '[AC-F1-08ca-ACCESS#4] 超管：菜单恰 1 个，两个页签，先列出调账单',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    await mount(server, { snapshot: SUPER });
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    expect(menuLinks()).toHaveLength(1);
    expect(tabNames()).toEqual([TEXT.adjustmentsTab, TEXT.writeoffsTab]);
  },
);

it(
  '[AC-F1-08ca-ACCESS#5] fund.adjust / fund.writeoff / fund.view 都没有（只持 withdraw.review）：直达 /adjustments 显示「无权限查看调账与核销」，没有页签与表格，两个列表都不请求',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: OTHER_GRANTS });
    await mount(server);
    await waitFor(() => expect(hasText(main(), TEXT.forbidden)).toBe(true));
    await settled(server);
    expect(menuLinks()).toEqual([]);
    expect(tabNames()).toEqual([]);
    expect(dataRowCount(main())).toBe(0);
    expect(server.requestsUnder(ADJUSTMENTS)).toEqual([]);
    expect(server.requestsUnder(WRITEOFFS)).toEqual([]);
  },
);

it(
  '[AC-F1-08ca-ACCESS#6] 列表返回 10403（本地快照有 fund.adjust / fund.writeoff、服务端不认）：各自显示「无权限查看调账与核销」，不显示行',
  { timeout: 60_000 },
  async () => {
    const adjust = createServer({ permissions: OTHER_GRANTS });
    await mount(adjust, { snapshot: snapshot(ADJUST_GRANTS) });
    await waitFor(() => expect(adjust.tableReads(ADJUSTMENTS)).toHaveLength(1));
    await settled(adjust);
    await waitFor(() => expect(hasText(main(), TEXT.forbidden)).toBe(true));
    expect(dataRowCount(main())).toBe(0);
    expect(adjust.others()).toEqual([]);
    cleanup();

    const writeoff = createServer({ permissions: OTHER_GRANTS });
    await mount(writeoff, { snapshot: snapshot(WRITEOFF_GRANTS) });
    await waitFor(() => expect(writeoff.tableReads(WRITEOFFS)).toHaveLength(1));
    await settled(writeoff);
    await waitFor(() => expect(hasText(main(), TEXT.forbidden)).toBe(true));
    expect(dataRowCount(main())).toBe(0);
    expect(writeoff.others()).toEqual([]);
  },
);
