// @vitest-environment jsdom
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  MANUAL,
  REASONS,
  approvedRows,
  assertRequest,
  button,
  buttons,
  checkbox,
  click,
  confirm,
  dialogs,
  disabled,
  fillRows,
  inputs,
  main,
  mount,
  notice,
  open,
  paid,
  reply,
  rowOf,
  select,
  serverFor,
  settled,
  verify,
  writes,
  type ResultItem,
} from './helpers.ts';

it(
  '[AC-F1-08al-SUBMIT#1] 一次动态码覆盖整批且连点只发一次；在途保持对话框、输入按钮锁定，成功清空勾选重读列表',
  { timeout: 60_000 },
  async () => {
    const rows = approvedRows(2);
    const server = serverFor(rows);
    const release = server.hold('POST', MANUAL, () => reply(server, paid(rows)));
    await mount(server);
    await select([...rows].reverse());
    const modal = await open();
    const body = await fillRows(modal, rows);
    const reads = server.reads().length;
    try {
      await confirm(server, modal, true);
      await verify(true);
      await waitFor(() => expect(writes(server)).toHaveLength(1));
      assertRequest(server, body);
      await waitFor(() => expect(dialogs()).toEqual([modal]));
      expect(inputs(modal)).toHaveLength(6);
      expect(inputs(modal).map((input) => disabled(input))).toEqual([
        true,
        true,
        true,
        true,
        true,
        true,
      ]);
      expect(
        within(modal)
          .queryAllByRole('button')
          .filter((node) => !disabled(node)),
      ).toEqual([]);
      await click(button(modal, '确认录入'), true);
      await act(async () => {
        fireEvent['keyDown'](modal, { ['key']: 'Escape', code: 'Escape' });
      });
      expect(dialogs()).toEqual([modal]);
      expect(writes(server)).toHaveLength(1);
      expect(server.reads()).toHaveLength(reads);
    } finally {
      await act(async () => {
        release();
      });
    }
    await notice('已录入 2 张，跳过 0 张', modal);
    for (const item of rows) await notice('已录入', rowOf(modal, item.out_biz_no));
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(reads));
    await settled(server);
    expect(buttons(main(), '批量手动打款')).toEqual([]);
    expect(
      within(main())
        .queryAllByRole('checkbox')
        .filter((node) => (node as HTMLInputElement).checked),
    ).toEqual([]);
    expect(dialogs()).toEqual([modal]);
    assertRequest(server, body);
  },
);

it(
  '[AC-F1-08al-RESULT#1] 部分成功逐行展示 paid 和十一种 skipped 全文，阻断等由服务端判定且不冒称全成',
  { timeout: 90_000 },
  async () => {
    const rows = approvedRows(12);
    const server = serverFor(rows);
    // Local risk data must not remove a non-WeChat item from the request.
    rows[9]!.blocked_reason = 'NEGATIVE_BALANCE';
    server.state[9]!.blocked_reason = 'NEGATIVE_BALANCE';
    const outcomes: ResultItem[] = [
      paid([rows[0]!])[0]!,
      ...Object.entries(REASONS).map(([reason], index) => ({
        withdrawal_id: rows[index + 1]!.withdrawal_id,
        result: 'skipped' as const,
        reason: reason as Exclude<ResultItem['reason'], null>,
      })),
    ];
    server.once('POST', MANUAL, () => reply(server, outcomes));
    await mount(server);
    await select(rows);
    const modal = await open();
    const body = await fillRows(modal, rows);
    const reads = server.reads().length;
    await confirm(server, modal);
    await verify();
    await notice('已录入 1 张，跳过 11 张', modal);
    await settled(server);
    assertRequest(server, body);
    for (const [index, result] of outcomes.entries()) {
      const row = rowOf(modal, rows[index]!.out_biz_no);
      await notice(result.result === 'paid' ? '已录入' : REASONS[result.reason!], row);
      if (result.result === 'skipped')
        expect(within(row).queryAllByText('已录入', { exact: true })).toEqual([]);
    }
    expect(
      within(document.body).queryAllByText('已录入 12 张，跳过 0 张', { exact: true }),
    ).toEqual([]);
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(reads));
    await settled(server);
    expect(buttons(main(), '批量手动打款')).toEqual([]);
    expect(
      within(main())
        .queryAllByRole('checkbox')
        .filter((node) => (node as HTMLInputElement).checked),
    ).toEqual([]);
  },
);

it(
  '[AC-F1-08al-RESULT#2] 全部 skipped 不出成功提示；完成后重选同一批使用新幂等标识',
  { timeout: 60_000 },
  async () => {
    const rows = approvedRows(2);
    const server = serverFor(rows);
    const results: ResultItem[] = rows.map((row) => ({
      withdrawal_id: row.withdrawal_id,
      result: 'skipped',
      reason: 'member_blocked',
    }));
    server.once('POST', MANUAL, () => reply(server, results));
    await mount(server);
    await select(rows);
    const modal = await open();
    const body = await fillRows(modal, rows);
    await confirm(server, modal);
    await verify();
    await notice('已录入 0 张，跳过 2 张', modal);
    await settled(server);
    assertRequest(server, body);
    expect(within(document.body).queryAllByText('已录入', { exact: true })).toEqual([]);
    expect(document.querySelectorAll('.ant-message-success')).toHaveLength(0);
    for (const item of rows) {
      await notice(REASONS.member_blocked, rowOf(modal, item.out_biz_no));
      expect(checkbox(item).checked).toBe(false);
    }
    await click(button(modal, '关闭'));
    await select(rows);
    const next = await open();
    const nextBody = await fillRows(next, rows);
    server.once('POST', MANUAL, () => reply(server, paid(rows)));
    await confirm(server, next);
    await verify();
    await notice('已录入 2 张，跳过 0 张', next);
    await settled(server);
    assertRequest(server, nextBody, 2);
    expect(writes(server)[1]!.headers.get('Idempotency-Key')).not.toBe(
      writes(server)[0]!.headers.get('Idempotency-Key'),
    );
  },
);
