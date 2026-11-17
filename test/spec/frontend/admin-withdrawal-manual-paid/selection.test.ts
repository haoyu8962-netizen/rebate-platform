// @vitest-environment jsdom
import { formatYuanAdmin, parseFen } from '@couli/money';
import { cleanup, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  GRANTS,
  MANUAL,
  approvedRows,
  assertRequest,
  button,
  buttons,
  checkbox,
  click,
  confirm,
  disabled,
  fillRows,
  inputs,
  main,
  mount,
  notice,
  ok,
  open,
  paid,
  rowOf,
  samples,
  select,
  serverFor,
  settled,
  verify,
} from './helpers.ts';

it(
  '[AC-F1-08al-ACCESS#1] 仅手动补录权限可勾真实 APPROVED；无此权限不可勾，不能借补录权限批量通过',
  { timeout: 90_000 },
  async () => {
    const rows = samples();
    const approved = rows.find((row) => row.status === 'APPROVED')!;
    approved.display_status = 'pending_review';
    for (const permissions of [
      { isSuper: false, permissions: ['fund.view'] },
      { isSuper: false, permissions: ['fund.view', 'payout.execute', 'export', 'config.business'] },
    ]) {
      const server = serverFor(rows);
      await mount(server, permissions);
      expect(
        within(rowOf(main(), approved.out_biz_no))
          .queryAllByRole('checkbox')
          .filter((node) => !disabled(node)),
      ).toEqual([]);
      expect(buttons(main(), '批量手动打款')).toEqual([]);
      expect(buttons(main(), '批量通过')).toEqual([]);
      expect(server.writes()).toEqual([]);
      cleanup();
    }
    const server = serverFor(rows);
    await mount(server, GRANTS);
    expect(buttons(main(), '批量手动打款')).toEqual([]);
    for (const row of rows) {
      const available = within(rowOf(main(), row.out_biz_no))
        .queryAllByRole('checkbox')
        .filter((node) => !disabled(node));
      expect(available).toEqual(row.status === 'APPROVED' ? [checkbox(row)] : []);
    }
    await select([approved]);
    expect(disabled(button(main(), '批量手动打款'))).toBe(false);
    expect(buttons(main(), '批量通过')).toEqual([]);
    await click(checkbox(approved));
    expect(buttons(main(), '批量手动打款')).toEqual([]);
    expect(server.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08al-ACCESS#2] 双权限及超管只选待审仍只有批量通过；混选后手动对话框只列待执行单',
  { timeout: 90_000 },
  async () => {
    for (const permissions of [
      { isSuper: false, permissions: ['withdraw.review', 'payout.manual_entry'] },
      { isSuper: true, permissions: [] },
    ]) {
      const rows = samples();
      const pending = rows[0]!;
      const approved = rows.find((row) => row.status === 'APPROVED')!;
      approved.display_status = 'pending_review';
      const server = serverFor(rows);
      await mount(server, permissions);
      await select([pending]);
      expect(disabled(button(main(), '批量通过'))).toBe(false);
      expect(buttons(main(), '批量手动打款')).toEqual([]);
      await select([approved]);
      expect(disabled(button(main(), '批量手动打款'))).toBe(false);
      expect(disabled(button(main(), '批量通过'))).toBe(false);
      const modal = await open();
      expect(within(modal).queryAllByText(pending.out_biz_no, { exact: true })).toEqual([]);
      expect(within(modal).queryAllByText(approved.out_biz_no, { exact: true })).toHaveLength(1);
      expect(server.writes()).toEqual([]);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08al-DIALOG#1] 按列表顺序显示单号、收款方式、应付；微信仅标跳过且无输入、不进入请求',
  { timeout: 60_000 },
  async () => {
    const rows = approvedRows();
    rows[2]!.payout_channel = 'wechat';
    rows[2]!.payout_method = 'wechat';
    const server = serverFor(rows);
    await mount(server);
    // Reverse click order must not become the batch order.
    await select([...rows].reverse());
    const modal = await open();
    expect(
      within(modal)
        .queryAllByRole('row')
        .slice(1)
        .map(
          (row) =>
            rows.find(
              (item) => within(row).queryAllByText(item.out_biz_no, { exact: true }).length === 1,
            )?.withdrawal_id,
        ),
    ).toEqual(rows.map((row) => row.withdrawal_id));
    for (const [index, item] of rows.entries()) {
      const row = rowOf(modal, item.out_biz_no);
      expect(
        within(row).queryAllByText(['支付宝', '银行卡', '微信零钱'][index]!, { exact: true }),
      ).toHaveLength(1);
      expect(
        within(row).queryAllByText(formatYuanAdmin(parseFen(item.net_fen)), { exact: true }),
      ).toHaveLength(1);
      expect(inputs(row)).toHaveLength(index === 2 ? 0 : 3);
    }
    await notice('跳过：微信零钱单不支持线下打款', rowOf(modal, rows[2]!.out_biz_no));
    const body = await fillRows(modal, rows.slice(0, 2));
    server.once('POST', MANUAL, () => ok({ items: paid(rows.slice(0, 2)) }));
    await confirm(server, modal);
    await verify();
    await settled(server);
    assertRequest(server, body);
  },
);

it(
  '[AC-F1-08al-DIALOG#2] 全选微信时全部标跳过，无录入输入、确认不可用且不发验证或写请求',
  { timeout: 60_000 },
  async () => {
    const rows = approvedRows(1);
    rows[0]!.payout_channel = 'wechat';
    rows[0]!.payout_method = 'wechat';
    const server = serverFor(rows);
    await mount(server);
    await select(rows);
    const modal = await open();
    await notice('跳过：微信零钱单不支持线下打款', rowOf(modal, rows[0]!.out_biz_no));
    expect(inputs(modal)).toEqual([]);
    expect(disabled(button(modal, '确认录入'))).toBe(true);
    await click(button(modal, '确认录入'));
    expect(server.writes()).toEqual([]);
  },
);
