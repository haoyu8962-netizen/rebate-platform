// @vitest-environment jsdom
// F1-08an：【一键组批】（F-ADM-07「按受阻原因筛选后一键组批」，BR-WDR-12）是纯前端：按列表已有的数据选中可执行
// 的单——待执行（APPROVED）且没有提现阻断「暂停」标记（blocked_reason，BR-WDR-05）——不发任何写请求；之后照常经
// 【批量自动打款】确认、动态码、只发一次 POST。待审核、打款中、已成功的单不被选中，超管也不会因此勾到待审核单。
// 约定见 ./helpers.ts 开头。
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  EXECUTOR,
  NAME,
  SUPER,
  TEXT,
  assertBatch,
  button,
  buttons,
  click,
  confirm,
  disabled,
  executedReply,
  listOf,
  main,
  mixedRows,
  mount,
  numbersIn,
  openBatch,
  resultShown,
  serverFor,
  settled,
  verify,
  writes,
} from './helpers.ts';

it(
  '[AC-F1-08an-GROUP#1] 持 payout.execute 与超管：按【一键组批】不发写请求，选中的恰为两张没有「暂停」标记的待执行单（带「暂停」标记的待执行单、待审核、打款中、已成功的单都不在内，超管也不出现【批量通过】）；【批量自动打款】的确认对话框按列表顺序只列这两张，动态码后请求体恰为这两张',
  { timeout: 180_000 },
  async () => {
    for (const who of [EXECUTOR, SUPER]) {
      const label = who.isSuper ? 'super' : 'payout.execute';
      const rows = listOf(mixedRows());
      const [a, b, p, k, y, d] = rows;
      const server = serverFor(rows);
      server.once('POST', '/admin/v1/payout-batches', () =>
        executedReply(server, [a!.withdrawal_id, b!.withdrawal_id]),
      );
      await mount(server, who);
      const before = server.log.length;
      await click(button(main(), NAME.group));
      await settled(server);
      expect(server.writes(), `${label}: no write`).toEqual([]);
      expect(
        server.log.slice(before).filter((request) => request.method !== 'GET'),
        `${label}: 一键组批 sends no write`,
      ).toEqual([]);
      await waitFor(() =>
        expect(disabled(button(main(), NAME.entry)), `${label}: 批量自动打款 usable`).toBe(false),
      );
      expect(buttons(main(), NAME.approve), `${label}: no pending row picked`).toEqual([]);

      const modal = await openBatch(server);
      const numbers = [a!, b!, p!, k!, y!, d!].map((one) => one.out_biz_no);
      expect(numbersIn(modal, numbers), `${label}: the two executable rows`).toEqual([
        a!.out_biz_no,
        b!.out_biz_no,
      ]);
      await confirm(server, modal);
      await verify();
      await waitFor(() => expect(writes(server)).toHaveLength(1));
      await settled(server);
      assertBatch(server, 0, [a!.withdrawal_id, b!.withdrawal_id]);
      await resultShown(a!.out_biz_no, TEXT.paying);
      await resultShown(b!.out_biz_no, TEXT.paying);
      cleanup();
    }
  },
);
