// @vitest-environment jsdom
// F1-08anb LEFT（BR-WDR-12 ②③：逐单受阻的单保持 APPROVED，并在结果中列出原因；全批受阻也不报成功）：
// 服务端回 executed、paying 为空，两张不同通道的单各带一条水位原因留在 left。结果对话框里每张单只显示自己那条
// 原因，汇总里进入打款为 0；没有「已发起打款」；关闭对话框、列表重读后两张仍是待执行，列表「执行结果」各是自己的
// 原因全文。约定见 ../helpers.ts 与 ./helpers.ts 开头。
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  EXECUTOR,
  LEFT_TEXT,
  STATUS_SHOWN,
  TEXT,
  assertBatch,
  confirm,
  dialogs,
  executedReply,
  isTableRead,
  main,
  mount,
  openBatch,
  row,
  rowOf,
  select,
  serverFor,
  settled,
  shows,
  verify,
  writes,
  type LeftReason,
} from '../helpers.ts';
import {
  ONE_BATCH,
  closeResult,
  leavesStarting,
  line,
  ownDialog,
  resultLines,
  writeLines,
} from './helpers.ts';

/** The summary of the result dialog: none paying, two left, none unreviewed (full text). */
const SUMMARY = '进入打款 0 张，留在待执行 2 张；列表与页签计数已刷新。';

it(
  '[AC-F1-08anb-LEFT#1] 全批逐单受阻：outcome=executed、paying=[]，支付宝单因余额 W 低于预计提现 P、银行卡单因余额 W 未录入或已过期留在 left；对话框里每张单只显示自己那条原因，汇总恰为「进入打款 0 张，留在待执行 2 张」；任何地方没有「已发起打款」；列表重读后两张仍为已通过待打款，「执行结果」各是自己的原因全文；只发一笔写',
  { timeout: 120_000 },
  async () => {
    const alipay = row(1, 'APPROVED', 1234567, 'alipay');
    const bank = row(2, 'APPROVED', 9801, 'bank_card');
    const rows = [alipay, bank];
    const reasons: readonly LeftReason[] = ['watermark_below_forecast', 'watermark_stale'];
    const server = serverFor(rows);
    server.once('POST', '/admin/v1/payout-batches', () =>
      executedReply(
        server,
        [],
        rows.map((one, index) => ({ withdrawal_id: one.withdrawal_id, reason: reasons[index]! })),
      ),
    );
    await mount(server, EXECUTOR);
    await select(rows);
    const modal = await openBatch(server);
    await confirm(server, modal);
    const at = server.log.length;
    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(1));
    await settled(server);
    assertBatch(
      server,
      0,
      rows.map((one) => one.withdrawal_id),
    );

    await waitFor(() => expect(leavesStarting(ownDialog(), '进入打款')).toHaveLength(1));
    const dialog = ownDialog();
    for (const [index, one] of rows.entries()) {
      const own = LEFT_TEXT[reasons[index]!];
      const other = LEFT_TEXT[reasons[1 - index]!];
      const shown = rowOf(dialog, one.out_biz_no);
      expect(shows(shown, own), `${one.out_biz_no}: its own reason`).toBe(true);
      expect(shows(shown, other), `${one.out_biz_no}: not the other reason`).toBe(false);
      expect(shows(shown, TEXT.paying), `${one.out_biz_no}: not paying`).toBe(false);
    }
    expect(leavesStarting(dialog, '进入打款'), 'none paying in the summary').toEqual([
      SUMMARY.replace(/\s+/g, ''),
    ]);
    expect(shows(document.body, TEXT.paying), 'nothing reported as paying').toBe(false);

    await waitFor(() =>
      expect(server.log.slice(at).some(isTableRead), 'the list read again').toBe(true),
    );
    await settled(server);
    await closeResult();
    await settled(server);
    expect(dialogs()).toEqual([]);
    for (const [index, one] of rows.entries()) {
      const shown = rowOf(main(), one.out_biz_no);
      expect(shows(shown, STATUS_SHOWN.APPROVED), `${one.out_biz_no}: still approved`).toBe(true);
      expect(shows(shown, STATUS_SHOWN.PAYING), `${one.out_biz_no}: not paying`).toBe(false);
      expect(resultLines(one.out_biz_no), `${one.out_biz_no}: its own reason`).toEqual(
        line(LEFT_TEXT[reasons[index]!]),
      );
    }
    expect(shows(document.body, TEXT.paying), 'nothing reported as paying').toBe(false);
    expect(server.state.map((one) => one.status)).toEqual(['APPROVED', 'APPROVED']);
    expect(writeLines(server)).toEqual(ONE_BATCH);
  },
);
