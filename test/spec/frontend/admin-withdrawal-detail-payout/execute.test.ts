// @vitest-environment jsdom
// F1-08am【执行打款】：一张单即一张单的批次（adminCreatePayoutBatch，body 只有 withdrawal_ids=[这一张]；
// BR-WDR-12 EXECUTE ①–③，BR-ID-34 动态码档）。确认对话框列单号、实付金额与「执行前检查」→ 动态码 → 只发一次
// POST；executed 的逐单结果（已发起打款 / 留在待执行及原因）与 rejected 的整批原因如实显示；executed 后重读详情。
// 幂等键：10003 重新动态码后原键原体；整批拒绝与首次提交即被拒（10403）之后再提交换新键。
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ok } from '../admin-withdrawals/fixtures.ts';
import {
  BATCHES,
  EXECUTE,
  FORBIDDEN,
  NAME,
  NET_SHOWN,
  NUMBER,
  STATUS_SHOWN,
  STEP_AGAIN,
  SUPER,
  TEXT,
  VERIFY,
  WID,
  assertExecute,
  assertSameWrites,
  button,
  buttons,
  click,
  dialogs,
  entries,
  executedLeft,
  executes,
  inDialog,
  keyOf,
  manuals,
  mount,
  notice,
  openExecute,
  payDialog,
  payingReply,
  refreshed,
  refusedBatch,
  serverFor,
  settle,
  settled,
  shows,
  statusShown,
  step,
  submit,
  submitAgainFrom,
  verify,
  writes,
} from './helpers.ts';

it(
  '[AC-F1-08am-EXEC#1] 持 payout.execute：【执行打款】先出确认对话框（单号、实付金额、执行前检查），【取消】不发任何请求；【确认执行】→ 动态码（双击也只验一次、只发一次）→ 只发一次 POST /admin/v1/payout-batches，body 恰为 withdrawal_ids=[这一张]，带 X-Step-Up-Token 与 Idempotency-Key；逐单结果显示「已发起打款」，详情重读为打款中、两个入口消失',
  { timeout: 120_000 },
  async () => {
    const server = serverFor();
    server.once('POST', BATCHES, () => payingReply(server));
    await mount(server, EXECUTE);

    const first = await openExecute(server);
    expect(shows(first, NUMBER), 'the withdrawal number').toBe(true);
    expect(shows(first, NET_SHOWN), 'the amount paid').toBe(true);
    expect(shows(first, TEXT.checkTitle), 'the pre-checks').toBe(true);
    await click(button(first, NAME.cancel));
    await waitFor(() => expect(dialogs()).toEqual([]));
    await settled(server);
    expect(writes(server)).toEqual([]);
    expect(server.requests('POST', VERIFY)).toEqual([]);

    const modal = await openExecute(server);
    const before = server.detailReads(WID).length;
    await submit(server, modal, NAME.executeSubmit, true);
    await verify(true);
    await waitFor(() => expect(executes(server)).toHaveLength(1));
    await settled(server);
    assertExecute(server, 0);
    await inDialog(TEXT.paying);
    await refreshed(server, before);
    await waitFor(() => expect(statusShown(STATUS_SHOWN.PAYING)).toBe(true));
    expect(statusShown(STATUS_SHOWN.APPROVED)).toBe(false);
    expect(entries()).toEqual({ execute: false, manual: false });
    expect(executes(server)).toHaveLength(1);
    expect(manuals(server)).toEqual([]);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
  },
);

it(
  '[AC-F1-08am-EXEC#2] executed 但该单留在待执行（会员有提现阻断 / 打款通道未开通）：如实显示原因，不显示「已发起打款」，详情仍是已通过待打款；只发一次',
  { timeout: 120_000 },
  async () => {
    for (const reason of ['member_blocked', 'channel_disabled'] as const) {
      const server = serverFor();
      server.once('POST', BATCHES, () => ok(executedLeft(reason)));
      await mount(server, SUPER);
      const modal = await openExecute(server);
      await submit(server, modal, NAME.executeSubmit);
      await verify();
      await waitFor(() => expect(executes(server)).toHaveLength(1));
      await settled(server);
      assertExecute(server, 0);
      await inDialog(TEXT.left[reason]!);
      expect(shows(payDialog(), TEXT.paying), reason).toBe(false);
      expect(statusShown(STATUS_SHOWN.APPROVED), reason).toBe(true);
      expect(statusShown(STATUS_SHOWN.PAYING), reason).toBe(false);
      expect(writes(server)).toHaveLength(1);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08am-EXEC#3] 整批拒绝（rejected，企业支付宝余额 W 低于预计提现 P）：显示「整批未执行：企业支付宝余额 W 低于预计提现 P」、不报成功、不进入结果未知、单据仍已通过待打款；再执行换新的 Idempotency-Key，第二次 executed 显示「已发起打款」',
  { timeout: 120_000 },
  async () => {
    const server = serverFor();
    server.once('POST', BATCHES, () => ok(refusedBatch('watermark_below_forecast')));
    server.once('POST', BATCHES, () => payingReply(server));
    await mount(server, EXECUTE);
    const modal = await openExecute(server);
    await submit(server, modal, NAME.executeSubmit);
    await verify();
    await waitFor(() => expect(executes(server)).toHaveLength(1));
    await settled(server);
    assertExecute(server, 0);
    await notice(TEXT.refusedBelow);
    expect(shows(document.body, TEXT.unknown)).toBe(false);
    expect(shows(document.body, TEXT.paying)).toBe(false);
    expect(statusShown(STATUS_SHOWN.APPROVED)).toBe(true);
    await settle();
    expect(executes(server)).toHaveLength(1);

    const again = await submitAgainFrom(server, NAME.executeSubmit, NAME.execute);
    await submit(server, again, NAME.executeSubmit);
    await verify();
    await waitFor(() => expect(executes(server)).toHaveLength(2));
    await settled(server);
    assertExecute(server, 1);
    expect(keyOf(executes(server)[1]!)).not.toBe(keyOf(executes(server)[0]!));
    await inDialog(TEXT.paying);
  },
);

it(
  '[AC-F1-08am-EXEC#4] 提交收到 10003（动态码凭证未被接受）：重新弹动态码并提示凭证已失效，验证前不重发；验证后以新凭证、原 Idempotency-Key 与逐字节相同的请求体再发一次，成功后显示「已发起打款」',
  { timeout: 120_000 },
  async () => {
    const server = serverFor();
    server.once('POST', BATCHES, STEP_AGAIN);
    server.once('POST', BATCHES, () => payingReply(server));
    await mount(server, EXECUTE);
    const modal = await openExecute(server);
    await submit(server, modal, NAME.executeSubmit);
    await verify();
    await waitFor(() => expect(executes(server)).toHaveLength(1));
    await settled(server);
    await step();
    await notice(TEXT.again);
    await settle();
    expect(executes(server), 'nothing resent before the new verification').toHaveLength(1);
    await verify();
    await waitFor(() => expect(executes(server)).toHaveLength(2));
    await settled(server);
    assertExecute(server, 1);
    assertSameWrites(server, BATCHES, 2);
    await inDialog(TEXT.paying);
    expect(shows(document.body, TEXT.unknown)).toBe(false);
  },
);

it(
  '[AC-F1-08am-EXEC#5] 首次提交即收到带外壳的 10403：提示「无权限执行此操作（需要 payout.execute 权限点）」，不进入结果未知（没有【重试】），不自动重发；再执行换新的 Idempotency-Key',
  { timeout: 120_000 },
  async () => {
    const server = serverFor();
    server.once('POST', BATCHES, FORBIDDEN);
    server.once('POST', BATCHES, () => payingReply(server));
    await mount(server, EXECUTE);
    const modal = await openExecute(server);
    await submit(server, modal, NAME.executeSubmit);
    await verify();
    await waitFor(() => expect(executes(server)).toHaveLength(1));
    await settled(server);
    assertExecute(server, 0);
    await notice(TEXT.executeForbidden);
    expect(shows(document.body, TEXT.unknown)).toBe(false);
    expect(buttons(document.body, NAME.retry)).toEqual([]);
    await settle();
    expect(executes(server)).toHaveLength(1);

    const again = await submitAgainFrom(server, NAME.executeSubmit, NAME.execute);
    await submit(server, again, NAME.executeSubmit);
    await verify();
    await waitFor(() => expect(executes(server)).toHaveLength(2));
    await settled(server);
    assertExecute(server, 1);
    expect(keyOf(executes(server)[1]!)).not.toBe(keyOf(executes(server)[0]!));
    await inDialog(TEXT.paying);
  },
);
