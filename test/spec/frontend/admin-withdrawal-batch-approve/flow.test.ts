// @vitest-environment jsdom
import { formatYuanAdmin, parseFen } from '@couli/money';
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  APPROVE,
  CONSEQUENCE,
  RESULT_TEXT,
  VERIFY,
  assertNoOtherActions,
  assertRequest,
  button,
  buttons,
  checkbox,
  click,
  confirm,
  dialogs,
  disabled,
  main,
  mount,
  notice,
  ok,
  open,
  pendingRows,
  rowOf,
  rowsOf,
  select,
  serverFor,
  settled,
  step,
  stepDialogs,
  succeed,
  verify,
  writes,
  type ResultItem,
} from './helpers.ts';

it(
  '[AC-F1-08ai-PREVIEW#1] 本地确认表按列表顺序列全选中单的单号、用户、金额及将通过，说明不自动打款；取消不发请求且焦点返回',
  { timeout: 60_000 },
  async () => {
    const items = pendingRows().slice(0, 2);
    const server = serverFor(items);
    await mount(server);
    await select([...items].reverse());
    const entry = button(main(), '批量通过');
    const reads = server.reads().length;
    const modal = await open();
    const headers = within(modal).queryAllByRole('columnheader');
    expect(headers.map((node) => node.textContent)).toEqual([
      '提现单号',
      '用户',
      '金额',
      '本次处理',
    ]);
    const preview = items.map((item) => rowOf(modal, item.out_biz_no));
    expect(
      preview[0]!.compareDocumentPosition(preview[1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    for (const [index, item] of items.entries()) {
      const row = preview[index]!;
      expect(within(row).queryAllByText(item.user.user_id, { exact: true })).toHaveLength(1);
      if (item.user.phone_masked !== null)
        expect(within(row).queryAllByText(item.user.phone_masked, { exact: true })).toHaveLength(1);
      const cells = within(row).queryAllByRole('cell');
      expect(cells).toHaveLength(4);
      expect(cells[0]!.textContent).toBe(item.out_biz_no);
      expect(cells[2]!.textContent).toBe(formatYuanAdmin(parseFen(item.amount_fen)));
      expect(cells[3]!.textContent).toBe('将通过');
    }
    expect(within(modal).queryAllByText(CONSEQUENCE, { exact: true })).toHaveLength(1);
    expect(server.reads()).toHaveLength(reads);
    expect(server.writes()).toEqual([]);
    await click(button(modal, '取消'));
    await waitFor(() => expect(dialogs()).toEqual([]));
    await waitFor(() => expect(document.activeElement).toBe(entry));
    expect(server.writes()).toEqual([]);
    expect(checkbox(items[0]!).checked).toBe(true);
    expect(checkbox(items[1]!).checked).toBe(true);
  },
);

it(
  '[AC-F1-08ai-SUBMIT#1] 一次动态码覆盖整批；按列表顺序去重提交，连点与在途再次点击不重发，原确认框保留且两处提交按钮禁用',
  { timeout: 60_000 },
  async () => {
    const items = pendingRows().slice(0, 3);
    const server = serverFor(items);
    const release = server.hold('POST', APPROVE, () => succeed(server, items));
    await mount(server);
    try {
      await select([...items].reverse());
      // Re-selecting must not append a duplicate id, and click order must not become payload order.
      await click(checkbox(items[1]!));
      await select([items[1]!]);
      const entry = button(main(), '批量通过');
      const modal = await open();
      const submit = button(modal, '确认通过');
      await confirm(server, modal, true);
      await verify(true);
      await waitFor(() => expect(writes(server)).toHaveLength(1));
      expect(disabled(entry)).toBe(true);
      expect(disabled(submit)).toBe(true);
      expect(dialogs().filter((node) => node === modal)).toHaveLength(1);
      await click(entry, true);
      await click(submit, true);
      assertRequest(server, items);
      expect(server.pending).toBe(1);
      assertNoOtherActions();
    } finally {
      release();
    }
    await settled(server);
    assertRequest(server, items);
    await waitFor(() => expect(buttons(main(), '批量通过')).toEqual([]));
  },
);

it(
  '[AC-F1-08ai-RESULT#1] 一批混合成功和四种跳过逐行对应显示；刷新待审列表及计数，已选全部清空，消失的单仍保留结果',
  { timeout: 60_000 },
  async () => {
    const items = pendingRows();
    const server = serverFor(items);
    const results: ResultItem[] = [
      { withdrawal_id: items[0]!.withdrawal_id, result: 'approved', reason: null },
      { withdrawal_id: items[1]!.withdrawal_id, result: 'skipped', reason: 'not_found' },
      { withdrawal_id: items[2]!.withdrawal_id, result: 'skipped', reason: 'not_pending' },
      { withdrawal_id: items[3]!.withdrawal_id, result: 'skipped', reason: 'negative_balance' },
      { withdrawal_id: items[4]!.withdrawal_id, result: 'skipped', reason: 'blocked' },
    ];
    server.once('POST', APPROVE, () => {
      server.state[0]!.status = 'APPROVED';
      server.state[2]!.status = 'PAYING';
      server.state[2]!.display_status = 'paying';
      server.state[4]!.blocked_reason = 'NEGATIVE_BALANCE';
      server.state.splice(1, 1);
      return ok({ items: results });
    });
    await mount(server);
    const tabs = within(main())
      .queryAllByRole('tab')
      .filter((tab) => within(tab).queryAllByText('待审', { exact: true }).length === 1);
    expect(tabs).toHaveLength(1);
    await click(tabs[0]!);
    await settled(server);
    expect(server.reads().at(-1)!.query['display_status']).toBe('pending_review');
    await select(items);
    const before = server.reads().length;
    const modal = await open();
    await confirm(server, modal);
    await verify();
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(before));
    await settled(server);
    assertRequest(server, items);
    expect(server.log.indexOf(server.reads().at(-1)!)).toBeGreaterThan(
      server.log.indexOf(writes(server)[0]!),
    );
    expect(server.reads().at(-1)!.query['display_status']).toBe('pending_review');
    const messages = [
      RESULT_TEXT.approved,
      RESULT_TEXT.not_found,
      RESULT_TEXT.not_pending,
      RESULT_TEXT.negative_balance,
      RESULT_TEXT.blocked,
    ];
    const outcomeRows: HTMLElement[] = [];
    for (const [index, item] of items.entries()) {
      const text = messages[index]!;
      await notice(text);
      // Require association with this exact number in the same row, not five global toasts.
      const rows = rowsOf(document.body, item.out_biz_no).filter(
        (row) => within(row).queryAllByText(text, { exact: true }).length === 1,
      );
      expect(rows, `${item.out_biz_no}: ${text}`).toHaveLength(1);
      outcomeRows.push(rows[0]!);
    }
    for (let index = 1; index < outcomeRows.length; index += 1)
      expect(
        outcomeRows[index - 1]!.compareDocumentPosition(outcomeRows[index]!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
    expect(buttons(main(), '批量通过')).toEqual([]);
    const selected = Array.from(
      main().querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).filter((node) => node.checked);
    expect(selected).toEqual([]);
    expect(within(main()).queryAllByText('共 3 条', { exact: true })).toHaveLength(1);
    // The frozen 待审 tab filters display_status, so APPROVED remains visible alongside the
    // two pending rows, but must no longer be selectable. not_found/PAYING leave this tab.
    const listRows = Array.from(main().querySelectorAll<HTMLElement>('tbody tr')).filter(
      (row) => !row.closest('[role="dialog"]') && buttons(row, '详情').length === 1,
    );
    expect(listRows).toHaveLength(3);
    expect(
      listRows.map((row) =>
        items
          .filter(
            (item) => within(row).queryAllByText(item.out_biz_no, { exact: true }).length === 1,
          )
          .map((item) => item.out_biz_no),
      ),
    ).toEqual([[items[0]!.out_biz_no], [items[3]!.out_biz_no], [items[4]!.out_biz_no]]);
    expect(
      within(listRows[0]!)
        .queryAllByRole('checkbox')
        .filter((node) => !disabled(node)),
    ).toEqual([]);
    assertNoOtherActions();
  },
);

it(
  '[AC-F1-08ai-RESULT#2] 全部 skipped 仍逐单显示原因、清空选择并刷新列表，不把 HTTP 成功误报为已通过',
  { timeout: 60_000 },
  async () => {
    const items = pendingRows().slice(0, 2);
    const server = serverFor(items);
    const results: ResultItem[] = [
      { withdrawal_id: items[0]!.withdrawal_id, result: 'skipped', reason: 'negative_balance' },
      { withdrawal_id: items[1]!.withdrawal_id, result: 'skipped', reason: 'blocked' },
    ];
    server.once('POST', APPROVE, () => ok({ items: results }));
    await mount(server);
    await select(items);
    const before = server.reads().length;
    await confirm(server, await open());
    await verify();
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(before));
    await settled(server);
    assertRequest(server, items);
    for (const [index, text] of [RESULT_TEXT.negative_balance, RESULT_TEXT.blocked].entries()) {
      await notice(text);
      const rows = rowsOf(document.body, items[index]!.out_biz_no).filter(
        (row) => within(row).queryAllByText(text, { exact: true }).length === 1,
      );
      expect(rows).toHaveLength(1);
    }
    expect(within(document.body).queryAllByText('已通过', { exact: true })).toEqual([]);
    expect(buttons(main(), '批量通过')).toEqual([]);
    expect(
      Array.from(main().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).filter(
        (node) => node.checked,
      ),
    ).toEqual([]);
  },
);

it(
  '[AC-F1-08ai-CANCEL#1] 取消动态码不提交批量通过；关闭确认框后焦点回到批量入口，再操作仍须动态码',
  { timeout: 60_000 },
  async () => {
    const items = pendingRows().slice(0, 2);
    const server = serverFor(items);
    await mount(server);
    await select(items);
    const entry = button(main(), '批量通过');
    const modal = await open();
    await confirm(server, modal);
    await click(button(await step(), '取消'));
    await waitFor(() => expect(stepDialogs()).toEqual([]));
    expect(server.writes()).toEqual([]);
    for (const remaining of dialogs()) await click(button(remaining, '取消'));
    await waitFor(() => expect(dialogs()).toEqual([]));
    await waitFor(() => expect(document.activeElement).toBe(entry));
    const reopened = await open();
    await confirm(server, reopened);
    expect(server.requests('POST', VERIFY)).toEqual([]);
    expect(writes(server)).toEqual([]);
  },
);
