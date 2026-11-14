// @vitest-environment jsdom
import { addFen, formatYuanAdmin, parseFen } from '@couli/money';
import { cleanup, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  APPROVE,
  REVIEW,
  assertNoOtherActions,
  assertRequest,
  button,
  buttons,
  checkbox,
  click,
  confirm,
  disabled,
  fill,
  main,
  mount,
  open,
  pendingRows,
  rowOf,
  samples,
  select,
  serverFor,
  settled,
  succeed,
  verify,
} from './helpers.ts';

it(
  '[AC-F1-08ai-ACCESS#1] 只读和其他资金权限没有勾选或批量通过；审核权限与超管可勾选，未勾选不出现批量栏',
  { timeout: 90_000 },
  async () => {
    for (const permissions of [
      { isSuper: false, permissions: ['fund.view'] },
      {
        isSuper: false,
        permissions: [
          'fund.view',
          'payout.execute',
          'payout.manual_entry',
          'export',
          'config.business',
        ],
      },
    ]) {
      const server = serverFor();
      await mount(server, permissions);
      expect(within(main()).queryAllByRole('checkbox')).toEqual([]);
      expect(buttons(main(), '批量通过')).toEqual([]);
      expect(server.writes()).toEqual([]);
      cleanup();
    }
    for (const permissions of [REVIEW, { isSuper: true, permissions: [] }]) {
      const server = serverFor();
      await mount(server, permissions);
      expect(buttons(main(), '批量通过')).toEqual([]);
      for (const item of server.state) expect(checkbox(item).checked).toBe(false);
      await select([server.state[0]!]);
      expect(disabled(button(main(), '批量通过'))).toBe(false);
      assertNoOtherActions();
      expect(server.writes()).toEqual([]);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08ai-SELECT#1] 按真实 PENDING_REVIEW 限制勾选，APPROVED 即使展示状态同为 pending_review 也不可勾；其余状态没有可用勾选框',
  { timeout: 60_000 },
  async () => {
    const items = samples();
    items[0]!.blocked_reason = null;
    const approved = items.find((item) => item.status === 'APPROVED')!;
    approved.display_status = 'pending_review';
    const server = serverFor(items);
    await mount(server);
    expect(checkbox(items[0]!).checked).toBe(false);
    for (const item of items.filter((row) => row.status !== 'PENDING_REVIEW')) {
      const choices = within(rowOf(main(), item.out_biz_no)).queryAllByRole('checkbox');
      expect(
        choices.filter((node) => !disabled(node)),
        item.status,
      ).toEqual([]);
    }
    await select([items[0]!]);
    expect(disabled(button(main(), '批量通过'))).toBe(false);
    expect(server.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08ai-SELECT#2] 批量栏随勾选出现，aria-live 精确播报张数及合计实付；取消全部后入口与统计消失',
  { timeout: 60_000 },
  async () => {
    const items = pendingRows().slice(0, 2);
    const server = serverFor(items);
    await mount(server);
    expect(buttons(main(), '批量通过')).toEqual([]);
    const statistics = () =>
      Array.from(main().querySelectorAll<HTMLElement>('[aria-live]'))
        .filter((node) => ['polite', 'assertive'].includes(node.getAttribute('aria-live') ?? ''))
        .map((node) => node.textContent);
    // The wording is a full independent expectation. §2 specifies net_fen, not amount_fen.
    const first = `已选 1 张，合计实付 ${formatYuanAdmin(parseFen(items[0]!.net_fen))}`;
    const both = `已选 2 张，合计实付 ${formatYuanAdmin(
      addFen(parseFen(items[0]!.net_fen), parseFen(items[1]!.net_fen)),
    )}`;
    await select([items[0]!]);
    expect(statistics()).toEqual([first]);
    expect(disabled(button(main(), '批量通过'))).toBe(false);
    await select([items[1]!]);
    expect(statistics()).toEqual([both]);
    await click(checkbox(items[1]!));
    expect(checkbox(items[1]!).checked).toBe(false);
    expect(statistics()).toEqual([first]);
    await click(checkbox(items[0]!));
    expect(checkbox(items[0]!).checked).toBe(false);
    expect(buttons(main(), '批量通过')).toEqual([]);
    expect(statistics()).toEqual([]);
    expect(server.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08ai-FILTER#1] 改筛选未查询仍保留原选择；查询应用新条件后清空全部已选，再勾选只统计新选择',
  { timeout: 60_000 },
  async () => {
    const items = pendingRows();
    const server = serverFor(items);
    await mount(server);
    await select(items.slice(0, 2));
    const reads = server.reads().length;
    const fields = within(main()).queryAllByLabelText('提现单号', { exact: true });
    expect(fields).toHaveLength(1);
    await fill(fields[0]!, items[0]!.out_biz_no);
    await settled(server);
    expect(server.reads()).toHaveLength(reads);
    expect(checkbox(items[0]!).checked).toBe(true);
    expect(checkbox(items[1]!).checked).toBe(true);
    await click(button(main(), '查询'));
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(reads));
    await settled(server);
    expect(server.reads().at(-1)!.query['out_biz_no']).toBe(items[0]!.out_biz_no);
    expect(checkbox(items[0]!).checked).toBe(false);
    expect(buttons(main(), '批量通过')).toEqual([]);
    await select([items[0]!]);
    const live = Array.from(main().querySelectorAll<HTMLElement>('[aria-live]'));
    expect(live.map((node) => node.textContent)).toEqual([
      `已选 1 张，合计实付 ${formatYuanAdmin(parseFen(items[0]!.net_fen))}`,
    ]);
    expect(server.writes()).toEqual([]);
    server.once('POST', APPROVE, () => succeed(server, [items[0]!]));
    await confirm(server, await open());
    await verify();
    await settled(server);
    assertRequest(server, [items[0]!]);
  },
);
