// @vitest-environment jsdom
// F1-08am 两个写操作的结果未知（照 F1-08ce，编排 D10-1731 / D10-1739）：首次提交网络错误、无法解析的响应、带统一
// 外壳的 5xx 都算结果未知——提示「上次提交结果未知」，输入锁定、对话框关不掉，只剩【重试】（重新动态码后原
// Idempotency-Key、逐字节相同的请求体）与「去核对」，不自动重发。结果未知后重试收到 10403，或 10003 且
// data.reason=verify_phone_missing，仍是结果未知、仍锁定、键与请求体不变；收到 20001 解锁、下次换新键；普通 10003
// 照旧重新验证后原键原体（D10-2060 / D10-2061）。
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ok } from '../admin-withdrawals/fixtures.ts';
import {
  BATCHES,
  EXECUTE,
  FIELD,
  FORBIDDEN,
  MANUAL,
  MANUAL_BODY,
  MANUAL_ENTRY,
  NAME,
  PHONE_MISSING,
  SERIAL,
  STATUS_SHOWN,
  STEP_AGAIN,
  TEXT,
  WID,
  assertExecute,
  assertManual,
  assertSameWrites,
  assertUnknown,
  buttons,
  checkAction,
  click,
  dialogs,
  disabled,
  executeOnServer,
  executedPaying,
  executes,
  failure,
  field,
  fill,
  fillEntry,
  garbled,
  inDialog,
  keyOf,
  manuals,
  mount,
  networkDown,
  notice,
  openExecute,
  openManual,
  paidReply,
  payDialog,
  payOnServer,
  payingReply,
  retry,
  serverError,
  serverFor,
  settle,
  settled,
  shows,
  statusShown,
  step,
  stepDialogs,
  submit,
  submitAgainFrom,
  values,
  verify,
  writes,
  type ManualPayload,
  type Server,
} from './helpers.ts';

/** Every page dialog is gone and the page read the withdrawal (or the list) again. */
async function checkedElsewhere(server: Server, modal: HTMLElement): Promise<void> {
  const reads = server.detailReads(WID).length + server.reads().length;
  const sent = writes(server).length;
  await click(checkAction(modal));
  await waitFor(() => expect(dialogs()).toEqual([]));
  await waitFor(() =>
    expect(server.detailReads(WID).length + server.reads().length).toBeGreaterThan(reads),
  );
  await settled(server);
  expect(writes(server), 'the check action sends nothing').toHaveLength(sent);
}

it(
  '[AC-F1-08am-UNKNOWN#1] 【执行打款】首次提交已生效但连接断开：进入结果未知（提示「上次提交结果未知」、只剩【重试】与去核对、Esc 与遮罩关不掉、不自动重发、不报成功）；【重试】重新动态码后原 Idempotency-Key、逐字节相同的请求体只再发一次，拿到同键回放的 executed 后显示「已发起打款」',
  { timeout: 120_000 },
  async () => {
    const server = serverFor();
    server.once('POST', BATCHES, () => {
      executeOnServer(server);
      return networkDown();
    });
    server.once('POST', BATCHES, () => ok(executedPaying()));
    await mount(server, EXECUTE);
    const modal = await openExecute(server);
    await submit(server, modal, NAME.executeSubmit);
    await verify();
    await waitFor(() => expect(executes(server)).toHaveLength(1));
    await settled(server);
    assertExecute(server, 0);
    await assertUnknown(server, payDialog());
    expect(shows(payDialog(), TEXT.paying)).toBe(false);
    expect(buttons(payDialog(), NAME.executeSubmit).filter((node) => !disabled(node))).toEqual([]);

    await retry(server, payDialog());
    assertExecute(server, 1);
    assertSameWrites(server, BATCHES, 2);
    await inDialog(TEXT.paying);
    expect(shows(payDialog(), TEXT.unknown)).toBe(false);
    await settled(server);
    expect(executes(server)).toHaveLength(2);
  },
);

it(
  '[AC-F1-08am-UNKNOWN#2] 【执行打款】首次提交收到无法解析的响应或带统一外壳的 5xx：同样是结果未知、不自动重发；去核对关闭对话框并重新读取、不再发写请求',
  { timeout: 120_000 },
  async () => {
    for (const answer of [garbled, serverError]) {
      const server = serverFor();
      server.once('POST', BATCHES, answer);
      await mount(server, EXECUTE);
      const modal = await openExecute(server);
      await submit(server, modal, NAME.executeSubmit);
      await verify();
      await waitFor(() => expect(executes(server)).toHaveLength(1));
      await settled(server);
      assertExecute(server, 0);
      await assertUnknown(server, payDialog());
      await checkedElsewhere(server, payDialog());
      expect(executes(server)).toHaveLength(1);
      expect(statusShown(STATUS_SHOWN.APPROVED)).toBe(true);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08am-UNKNOWN#3] 【执行打款】结果未知后【重试】收到 10403：显示其原文但仍是结果未知、键与请求体不变；再【重试】收到 10003 verify_phone_missing：仍是结果未知、不弹验证；再【重试】收到 20001：解锁（无结果未知提示、无【重试】），再执行换新键并显示「已发起打款」',
  { timeout: 180_000 },
  async () => {
    const server = serverFor();
    server.once('POST', BATCHES, networkDown);
    server.once('POST', BATCHES, FORBIDDEN);
    server.once('POST', BATCHES, PHONE_MISSING);
    server.once('POST', BATCHES, () => failure(20001, { fields: ['withdrawal_ids'] }));
    server.once('POST', BATCHES, () => payingReply(server));
    await mount(server, EXECUTE);
    const modal = await openExecute(server);
    await submit(server, modal, NAME.executeSubmit);
    await verify();
    await waitFor(() => expect(executes(server)).toHaveLength(1));
    await settled(server);
    await assertUnknown(server, payDialog());

    await retry(server, payDialog());
    await notice(TEXT.executeForbidden);
    await assertUnknown(server, payDialog());
    assertSameWrites(server, BATCHES, 2);

    await retry(server, payDialog());
    await assertUnknown(server, payDialog());
    expect(stepDialogs()).toEqual([]);
    assertSameWrites(server, BATCHES, 3);

    await retry(server, payDialog());
    assertSameWrites(server, BATCHES, 4);
    await waitFor(() => expect(shows(document.body, TEXT.unknown)).toBe(false));
    expect(buttons(document.body, NAME.retry)).toEqual([]);
    await settle();
    expect(executes(server)).toHaveLength(4);

    const again = await submitAgainFrom(server, NAME.executeSubmit, NAME.execute);
    await submit(server, again, NAME.executeSubmit);
    await verify();
    await waitFor(() => expect(executes(server)).toHaveLength(5));
    await settled(server);
    assertExecute(server, 4);
    expect(keyOf(executes(server)[4]!)).not.toBe(keyOf(executes(server)[0]!));
    await inDialog(TEXT.paying);
  },
);

it(
  '[AC-F1-08am-UNKNOWN#4] 【手动成功】首次提交已生效但连接断开：结果未知、三项锁定保留原文、只剩【重试】与去核对、不自动重发；【重试】原键原体只再发一次，拿到同键回放的逐单成功后显示「已录入」',
  { timeout: 120_000 },
  async () => {
    const server = serverFor();
    server.once('POST', MANUAL, (request) => {
      payOnServer(server, request);
      return networkDown();
    });
    server.once('POST', MANUAL, (request) => paidReply(server, request));
    await mount(server, MANUAL_ENTRY);
    const modal = await openManual(server);
    const typed = await fillEntry(modal);
    await submit(server, modal, NAME.manualSubmit);
    await verify();
    await waitFor(() => expect(manuals(server)).toHaveLength(1));
    await settled(server);
    assertManual(server, 0);
    await assertUnknown(server, payDialog());
    expect(values(payDialog())).toEqual(typed);
    expect(buttons(payDialog(), NAME.manualSubmit).filter((node) => !disabled(node))).toEqual([]);

    await retry(server, payDialog());
    assertManual(server, 1);
    assertSameWrites(server, MANUAL, 2);
    await inDialog(TEXT.paid);
    expect(shows(payDialog(), TEXT.unknown)).toBe(false);
    await settled(server);
    expect(manuals(server)).toHaveLength(2);
  },
);

it(
  '[AC-F1-08am-UNKNOWN#5] 【手动成功】首次提交收到无法解析的响应或带统一外壳的 5xx：结果未知、三项锁定、不自动重发；去核对关闭对话框并重新读取、不再发写请求',
  { timeout: 150_000 },
  async () => {
    for (const answer of [garbled, serverError]) {
      const server = serverFor();
      server.once('POST', MANUAL, answer);
      await mount(server, MANUAL_ENTRY);
      const modal = await openManual(server);
      const typed = await fillEntry(modal);
      await submit(server, modal, NAME.manualSubmit);
      await verify();
      await waitFor(() => expect(manuals(server)).toHaveLength(1));
      await settled(server);
      assertManual(server, 0);
      await assertUnknown(server, payDialog());
      expect(values(payDialog())).toEqual(typed);
      await checkedElsewhere(server, payDialog());
      expect(manuals(server)).toHaveLength(1);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08am-UNKNOWN#6] 【手动成功】结果未知后：【重试】收到普通 10003 照旧重新动态码、验证前不重发、验证后原键原体；收到 10403 显示其原文仍是结果未知；收到 10003 verify_phone_missing 仍是结果未知、不弹验证；收到 20001 解锁、输入可改，改流水号后再提交换新键并显示「已录入」',
  { timeout: 240_000 },
  async () => {
    const server = serverFor();
    server.once('POST', MANUAL, networkDown);
    server.once('POST', MANUAL, STEP_AGAIN);
    server.once('POST', MANUAL, FORBIDDEN);
    server.once('POST', MANUAL, PHONE_MISSING);
    server.once('POST', MANUAL, () => failure(20001, { fields: ['items'] }));
    server.once('POST', MANUAL, (request) => paidReply(server, request));
    await mount(server, MANUAL_ENTRY);
    const modal = await openManual(server);
    const typed = await fillEntry(modal);
    await submit(server, modal, NAME.manualSubmit);
    await verify();
    await waitFor(() => expect(manuals(server)).toHaveLength(1));
    await settled(server);
    await assertUnknown(server, payDialog());

    // Plain 10003: verify again, the same key and bytes after it.
    await retry(server, payDialog());
    await step();
    await notice(TEXT.again);
    await settle();
    expect(manuals(server), 'nothing resent before the new verification').toHaveLength(2);
    await verify();
    await waitFor(() => expect(manuals(server)).toHaveLength(3));
    await settled(server);
    // That one got 10403: still unknown.
    await notice(TEXT.manualForbidden);
    await assertUnknown(server, payDialog());
    expect(values(payDialog())).toEqual(typed);
    assertSameWrites(server, MANUAL, 3);

    await retry(server, payDialog());
    await assertUnknown(server, payDialog());
    expect(stepDialogs()).toEqual([]);
    expect(values(payDialog())).toEqual(typed);
    assertSameWrites(server, MANUAL, 4);

    await retry(server, payDialog());
    assertSameWrites(server, MANUAL, 5);
    await waitFor(() => expect(shows(document.body, TEXT.unknown)).toBe(false));
    expect(buttons(document.body, NAME.retry)).toEqual([]);
    await settle();
    expect(manuals(server)).toHaveLength(5);

    const again = await submitAgainFrom(server, NAME.manualSubmit, NAME.manual);
    for (const label of [FIELD.serial, FIELD.paidAt, FIELD.amount])
      expect(disabled(field(again, label)), `${label} unlocked`).toBe(false);
    if (values(again)[1] === '') await fillEntry(again);
    const changed = `${SERIAL}-2`;
    await fill(field(again, FIELD.serial), changed);
    await settle();
    await submit(server, again, NAME.manualSubmit);
    await verify();
    await waitFor(() => expect(manuals(server)).toHaveLength(6));
    await settled(server);
    const corrected: ManualPayload = {
      items: [{ ...MANUAL_BODY.items[0]!, channel_order_id: changed }],
    };
    assertManual(server, 5, corrected);
    expect(keyOf(manuals(server)[5]!)).not.toBe(keyOf(manuals(server)[0]!));
    await inDialog(TEXT.paid);
  },
);
