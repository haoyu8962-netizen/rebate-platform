// @vitest-environment jsdom
// F1-08an：审核列表上【批量自动打款】与【一键组批】按权限点 payout.execute 出现（BR-WDR-11：服务端校验为准，
// 界面按权限点隐藏只是辅助；超管持有全部权限点）。【批量自动打款】只在勾到待执行（APPROVED）单后出现，
// 与【批量通过】【批量手动打款】同一批量栏、各管各的勾选子集。约定见 ./helpers.ts 开头。
import { cleanup } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  EXECUTOR,
  NAME,
  RECORDER,
  REVIEWER,
  SUPER,
  VIEWER,
  button,
  buttons,
  checkbox,
  click,
  disabled,
  listOf,
  main,
  mixedRows,
  mount,
  select,
  serverFor,
  usableBoxes,
  writes,
} from './helpers.ts';

it(
  '[AC-F1-08an-ENTRY#1] 持 fund.view + payout.execute：待执行（APPROVED）行各有一个可用勾选框（含带「暂停」标记的），待审核、打款中、已成功行没有；未勾选时没有【批量自动打款】、有一个可用的【一键组批】；勾一张待执行单后恰有一个可用的【批量自动打款】，没有【批量通过】【批量手动打款】；取消勾选后【批量自动打款】消失；全程不发写请求',
  { timeout: 90_000 },
  async () => {
    const rows = mixedRows();
    const server = serverFor(listOf(rows));
    await mount(server, EXECUTOR);
    for (const item of listOf(rows))
      expect(usableBoxes(item), `${item.out_biz_no} (${item.status})`).toHaveLength(
        item.status === 'APPROVED' ? 1 : 0,
      );
    expect(buttons(main(), NAME.entry), 'no 批量自动打款 before a tick').toEqual([]);
    expect(disabled(button(main(), NAME.group)), '一键组批 usable').toBe(false);

    await select([rows.a]);
    expect(disabled(button(main(), NAME.entry)), '批量自动打款 usable').toBe(false);
    expect(buttons(main(), NAME.approve)).toEqual([]);
    expect(buttons(main(), NAME.manual)).toEqual([]);

    await click(checkbox(rows.a));
    expect(checkbox(rows.a).checked).toBe(false);
    expect(buttons(main(), NAME.entry), 'gone once nothing is ticked').toEqual([]);
    expect(server.writes()).toEqual([]);
    expect(writes(server)).toEqual([]);
  },
);

it(
  '[AC-F1-08an-ENTRY#2] 超管：只勾待审核单时只有【批量通过】、没有【批量自动打款】，再勾一张待执行单后【批量自动打款】【批量手动打款】都可用，【一键组批】在；只持 fund.view、只持 withdraw.review、持 fund.view + payout.manual_entry 时都没有【批量自动打款】【一键组批】（隐藏，不是置灰；勾了各自可勾的单也没有）；全程不发写请求',
  { timeout: 120_000 },
  async () => {
    {
      const rows = mixedRows();
      const server = serverFor(listOf(rows));
      await mount(server, SUPER);
      expect(disabled(button(main(), NAME.group)), 'super: 一键组批 usable').toBe(false);
      await select([rows.p]);
      expect(disabled(button(main(), NAME.approve))).toBe(false);
      expect(buttons(main(), NAME.entry), 'a pending row only: no 批量自动打款').toEqual([]);
      await select([rows.a]);
      expect(disabled(button(main(), NAME.entry)), 'super: 批量自动打款 usable').toBe(false);
      expect(disabled(button(main(), NAME.manual)), 'super: 批量手动打款 usable').toBe(false);
      expect(server.writes()).toEqual([]);
      cleanup();
    }
    for (const { label, who, tick } of [
      { label: 'fund.view', who: VIEWER, tick: null },
      { label: 'withdraw.review', who: REVIEWER, tick: 'p' as const },
      { label: 'fund.view + payout.manual_entry', who: RECORDER, tick: 'a' as const },
    ]) {
      const rows = mixedRows();
      const server = serverFor(listOf(rows));
      await mount(server, who);
      expect(buttons(main(), NAME.group), `${label}: no 一键组批`).toEqual([]);
      expect(buttons(main(), NAME.entry), `${label}: no 批量自动打款`).toEqual([]);
      if (tick !== null) {
        await select([rows[tick]]);
        expect(buttons(main(), NAME.entry), `${label}: no 批量自动打款 after a tick`).toEqual([]);
        expect(buttons(main(), NAME.group), `${label}: no 一键组批 after a tick`).toEqual([]);
      } else {
        for (const item of listOf(rows))
          expect(usableBoxes(item), `${label}: ${item.out_biz_no}`).toEqual([]);
      }
      expect(server.writes(), `${label}: no write`).toEqual([]);
      cleanup();
    }
  },
);
