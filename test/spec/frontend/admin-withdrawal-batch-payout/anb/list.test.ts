// @vitest-environment jsdom
// F1-08anb LIST（BR-WDR-12 后台【批量自动打款】：逐单结果写入列表「执行结果」列；勾选中的待审核单结果列显示「未审核」）。
// 结果对话框关闭、列表重读完成之后，按单号定位每一行「原因 / 执行结果」单元格里的本次执行结果，三行各自对应、
// 不串行；没勾的行没有结果行。约定见 ../helpers.ts 与 ./helpers.ts 开头。
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  LEFT_TEXT,
  STATUS_SHOWN,
  SUPER,
  TEXT,
  assertBatch,
  confirm,
  dialogs,
  executedReply,
  isTableRead,
  listOf,
  main,
  mixedRows,
  mount,
  openBatch,
  rowOf,
  select,
  serverFor,
  settled,
  shows,
  verify,
  writes,
} from '../helpers.ts';
import { ONE_BATCH, closeResult, line, resultLines, writeLines } from './helpers.ts';

it(
  '[AC-F1-08anb-LIST#1] 超管混选一张待审核单与两张待执行单执行，服务端回 executed：一张进入打款、一张因打款通道未开通留下；关闭结果对话框、列表重读后，按单号定位「原因 / 执行结果」单元格：进入打款那行恰为「本次执行结果：已发起打款」，留下那行恰为该原因全文，待审核那行恰为「未审核」，没勾的行没有执行结果；只发一笔写',
  { timeout: 120_000 },
  async () => {
    const rows = mixedRows();
    const { a, b, p, k, y, d } = rows;
    const server = serverFor(listOf(rows));
    server.once('POST', '/admin/v1/payout-batches', () =>
      executedReply(
        server,
        [a.withdrawal_id],
        [{ withdrawal_id: b.withdrawal_id, reason: 'channel_disabled' }],
      ),
    );
    await mount(server, SUPER);
    await select([p, b, a]);
    const modal = await openBatch(server);
    await confirm(server, modal);
    const at = server.log.length;
    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(1));
    await settled(server);
    assertBatch(server, 0, [a.withdrawal_id, b.withdrawal_id]);

    await waitFor(() =>
      expect(server.log.slice(at).some(isTableRead), 'the list read again').toBe(true),
    );
    await settled(server);
    await closeResult();
    expect(dialogs(), 'asserted on the list, not in a dialog').toEqual([]);
    await waitFor(() => expect(shows(rowOf(main(), a.out_biz_no), STATUS_SHOWN.PAYING)).toBe(true));
    await settled(server);
    expect(dialogs()).toEqual([]);

    expect(resultLines(a.out_biz_no), `${a.out_biz_no}: paying`).toEqual(line(TEXT.paying));
    expect(resultLines(b.out_biz_no), `${b.out_biz_no}: its own reason`).toEqual(
      line(LEFT_TEXT.channel_disabled),
    );
    expect(resultLines(p.out_biz_no), `${p.out_biz_no}: not reviewed`).toEqual(
      line(TEXT.unreviewed),
    );
    for (const one of [k, y, d])
      expect(resultLines(one.out_biz_no), `${one.out_biz_no}: not ticked, no result`).toEqual([]);
    expect(shows(rowOf(main(), b.out_biz_no), STATUS_SHOWN.APPROVED)).toBe(true);
    expect(writeLines(server)).toEqual(ONE_BATCH);
  },
);
