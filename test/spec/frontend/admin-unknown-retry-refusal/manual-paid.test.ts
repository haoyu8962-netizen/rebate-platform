// @vitest-environment jsdom
// F1-08as（取代 F1-08ar；编排 D10-2060 / 2061 / 2062）：批量手动打款一旦进入「上次提交结果未知」，之后【重试】
// 收到契约里先于幂等回放判、又会随状态变化的拒绝——10403 admin_permission_denied（未知窗口内权限被撤）——
// 时第一次提交仍可能已生效：对话框仍提示「上次提交结果未知」并显示该拒绝的原文，输入仍锁定、对话框不能关、
// 仍只有【重试】【去列表核对】，再【重试】原 Idempotency-Key 与逐字节相同的请求体（BR-WDR-16、BR-ID-34
// 动态码档）。对照（照现状）：结果未知后重试收 20001 解锁、可改、下次换新键；10003（凭证未被接受）重新动态码
// 后原键原体；首次提交（未进入结果未知）即收 10403 照旧解锁、下次换新键。
import { cleanup, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  INVALID,
  MANUAL,
  approvedRows,
  assertReplay,
  assertRequest,
  button,
  buttons,
  click,
  confirm,
  dateInputValue,
  dialogs,
  disabled,
  failure,
  field,
  fill,
  fillRows,
  inputs,
  main,
  mount,
  notice,
  open,
  paid,
  reply,
  retry,
  rowOf,
  select,
  serverFor,
  settle,
  settled,
  stepDialogs,
  unknown,
  verify,
  writes,
  type Payload,
  type Server,
  type Withdrawal,
} from '../admin-withdrawal-manual-paid/helpers.ts';
import { controlsOf, operableOf } from '../admin-withdrawal-manual-paid-controls/controls.ts';

/** A settled refusal in the unified envelope and its whole notice (frozen F1-08al texts). */
interface Refusal {
  readonly code: number;
  readonly data: unknown;
  readonly text: string;
}
const FORBIDDEN: Refusal = {
  code: 10403,
  data: { reason: 'admin_permission_denied' },
  text: '无权限执行此操作（需要 payout.manual_entry 权限点）',
};
const ITEMS_INVALID: Refusal = {
  code: 20001,
  data: { fields: ['items'] },
  text: '提交内容有误，请检查后重试',
};
const UNKNOWN_NOTICE = '上次提交结果未知';

/** The first submission takes effect on the server, its reply is lost (no envelope). */
function loseAfterEffect(server: Server, rows: readonly Withdrawal[]): void {
  server.once('POST', MANUAL, () => {
    reply(server, paid(rows));
    throw new Error('response lost');
  });
}

/** The first submission never reaches the service, its reply is lost (no envelope). */
function loseBeforeEffect(server: Server): void {
  server.once('POST', MANUAL, () => {
    throw new Error('response lost');
  });
}

function refuse(server: Server, refusal: Refusal): void {
  server.once('POST', MANUAL, () => failure(refusal.code, refusal.data));
}

/** Rows of the list whose checkbox is ticked. */
function ticked(): HTMLElement[] {
  return within(main())
    .queryAllByRole('checkbox')
    .filter((node) => (node as HTMLInputElement).checked);
}

/**
 * After a retry was refused with `refusal`: the refusal's whole notice is shown, yet the dialog is
 * still in the result-unknown state (notice, every input locked with what was typed, no 确认录入,
 * only 【重试】【去列表核对】, Escape and the mask do not close it, no 取消 / 关闭 / corner close),
 * and every write so far is the first one again (same Idempotency-Key, same bytes).
 */
async function refusedYetUnknown(
  server: Server,
  modal: HTMLElement,
  refusal: Refusal,
  body: Payload,
  count: number,
  original: readonly string[],
): Promise<void> {
  await notice(refusal.text);
  await settled(server);
  await unknown(modal);
  assertReplay(server, body, count);
  expect(inputs(modal).map((input) => input.value)).toEqual(original);
  expect(inputs(modal).map((input) => disabled(input))).toEqual(original.map(() => true));
  expect(buttons(modal, '确认录入')).toEqual([]);
  for (const name of ['取消', '关闭', 'Close'])
    expect(buttons(modal, name).filter((node) => !disabled(node))).toEqual([]);
  expect(dialogs()).toEqual([modal]);
  expect(stepDialogs()).toEqual([]);
  expect(within(document.body).queryAllByText('已录入', { exact: true })).toEqual([]);
  expect(writes(server)).toHaveLength(count);
}

/**
 * After a settled refusal that unlocks: its notice shown, no result-unknown notice, no 【重试】
 * 【去列表核对】, every input of the `size` rows changeable again and 确认录入 usable.
 */
async function refusedAndUnlocked(
  server: Server,
  modal: HTMLElement,
  refusal: Refusal,
  size: number,
): Promise<void> {
  await notice(refusal.text);
  await settled(server);
  expect(within(modal).queryAllByText(UNKNOWN_NOTICE, { exact: true })).toEqual([]);
  expect(inputs(modal).map((input) => disabled(input))).toEqual(
    Array.from({ length: size * 3 }, () => false),
  );
  expect(buttons(modal, '重试')).toEqual([]);
  expect(buttons(modal, '去列表核对')).toEqual([]);
  expect(disabled(button(modal, '确认录入'))).toBe(false);
  expect(dialogs()).toEqual([modal]);
  expect(within(document.body).queryAllByText('已录入', { exact: true })).toEqual([]);
}

// ---- D10-2050: controls while a 实付时间 is wrong -------------------------------------------

const FIELDS = ['通道流水号', '实付时间', '实付金额（元）'];
/** One fillable row: exactly its three text inputs. */
const ROW_CONTROLS = FIELDS.map((label) => `textbox: ${label}`).sort();
/** Right after opening (two fillable rows): corner close, 取消, 确认录入, 2 × 3 text inputs. */
const OPENED = [
  'button: Close',
  'button: 取消',
  'button: 确认录入',
  'textbox: 通道流水号',
  'textbox: 实付时间',
  'textbox: 实付金额（元）',
  'textbox: 通道流水号',
  'textbox: 实付时间',
  'textbox: 实付金额（元）',
].sort();
/** Usable while a row is wrong: everything of OPENED except the disabled 确认录入. */
const OPENED_USABLE = OPENED.filter((entry) => entry !== 'button: 确认录入');
const SHORTCUT = /应付|填入|同上|一键|复制|此刻|现在|当前时间|今天|now|today/i;
/** One second after the injected clock's now (2026-11-18T04:00:00Z). */
const NOW_PLUS = '2026-11-18T04:00:01.000Z';

function invalidOf(row: HTMLElement): boolean[] {
  return FIELDS.map((label) => field(row, label).getAttribute('aria-invalid') === 'true');
}

/**
 * A fresh dialog of two filled rows; the first row's 实付时间 is then later than the injected
 * clock's now (2026-11-18T04:00:00Z), then not a time at all. Each time the dialog's whole list of
 * form and interactive controls equals the one right after opening — no 「用当前时间」 or the like.
 */
async function wrongTimeKeepsControls(): Promise<void> {
  const rows = approvedRows(2);
  const server = serverFor(rows);
  await mount(server);
  await select(rows);
  const modal = await open();
  const opened = controlsOf(modal);
  expect(opened).toEqual(OPENED);
  await fillRows(modal, rows);
  expect(controlsOf(modal)).toEqual(opened);
  const later = dateInputValue(field(rowOf(modal, rows[0]!.out_biz_no), '实付时间'), NOW_PLUS);
  for (const value of [later, 'not a time']) {
    await fill(field(rowOf(modal, rows[0]!.out_biz_no), '实付时间'), value);
    await settle();
    const row = rowOf(modal, rows[0]!.out_biz_no);
    if (value === later) await notice(INVALID.future, row);
    expect(field(row, '实付时间').value).toBe(value);
    expect(invalidOf(row)).toEqual([false, true, false]);
    expect(invalidOf(rowOf(modal, rows[1]!.out_biz_no))).toEqual([false, false, false]);
    expect(controlsOf(row)).toEqual(ROW_CONTROLS);
    expect(controlsOf(modal)).toEqual(opened);
    expect(controlsOf(modal)).toEqual(OPENED);
    expect(disabled(button(modal, '确认录入'))).toBe(true);
    expect(operableOf(modal)).toEqual(OPENED_USABLE);
    expect(controlsOf(modal).filter((entry) => SHORTCUT.test(entry))).toEqual([]);
    expect(dialogs()).toEqual([modal]);
    expect(server.writes()).toEqual([]);
  }
}

it(
  '[AC-F1-08as-MANUAL#1] 首次已生效但回答丢失 → 结果未知；【重试】动态码后原键原体收到带外壳的 10403 admin_permission_denied：仍提示「上次提交结果未知」并显示「无权限执行此操作（需要 payout.manual_entry 权限点）」、输入锁定、对话框不能关、只剩【重试】【去列表核对】；再【重试】仍是原键原体、再收 10403 仍未知；【去列表核对】关闭并重读列表、不再发写；另开对话框某行实付时间晚于现在或格式不合时控件清单仍等于刚打开时',
  { timeout: 180_000 },
  async () => {
    const rows = approvedRows(2);
    const server = serverFor(rows);
    loseAfterEffect(server, rows);
    refuse(server, FORBIDDEN);
    refuse(server, FORBIDDEN);
    await mount(server);
    await select(rows);
    const modal = await open();
    const body = await fillRows(modal, rows);
    const original = inputs(modal).map((input) => input.value);
    await confirm(server, modal);
    await verify();
    await settled(server);
    await unknown(modal);
    assertRequest(server, body);

    await retry(server, modal);
    await refusedYetUnknown(server, modal, FORBIDDEN, body, 2, original);

    await retry(server, modal);
    await refusedYetUnknown(server, modal, FORBIDDEN, body, 3, original);

    const reads = server.reads().length;
    await click(button(modal, '去列表核对'));
    await waitFor(() => expect(dialogs()).toEqual([]));
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(reads));
    await settled(server);
    assertReplay(server, body, 3);
    expect(ticked()).toEqual([]);
    cleanup();

    await wrongTimeKeepsControls();
  },
);

it(
  '[AC-F1-08as-MANUAL#2] 结果未知后【重试】先收带外壳的 10403：仍是结果未知、只剩【重试】【去列表核对】、键与请求体不变；对照（照现状）：再【重试】原键原体收到带外壳的 20001 data.fields=[items]：提示「提交内容有误，请检查后重试」并解锁（无结果未知提示、无【重试】【去列表核对】、输入可改、【确认录入】可用），改正后再提交换新键、显示「已录入 2 张，跳过 0 张」；对照：另开对话框首次提交即收 10403 照旧解锁，再提交换新键',
  { timeout: 240_000 },
  async () => {
    const rows = approvedRows(2);
    const server = serverFor(rows);
    loseBeforeEffect(server);
    refuse(server, FORBIDDEN);
    refuse(server, ITEMS_INVALID);
    server.once('POST', MANUAL, () => reply(server, paid(rows)));
    await mount(server);
    await select(rows);
    const modal = await open();
    const body = await fillRows(modal, rows);
    const original = inputs(modal).map((input) => input.value);
    await confirm(server, modal);
    await verify();
    await settled(server);
    await unknown(modal);
    assertRequest(server, body);

    await retry(server, modal);
    await refusedYetUnknown(server, modal, FORBIDDEN, body, 2, original);

    // Control (照现状, D10-2060 ②): 20001 after the unknown state unlocks; the next one is new.
    await retry(server, modal);
    assertReplay(server, body, 3);
    await refusedAndUnlocked(server, modal, ITEMS_INVALID, 2);
    expect(writes(server)).toHaveLength(3);
    await fill(field(rowOf(modal, rows[0]!.out_biz_no), '通道流水号'), 'Corrected-Serial');
    const corrected: Payload = {
      items: body.items.map((item, index) =>
        index === 0 ? { ...item, channel_order_id: 'Corrected-Serial' } : item,
      ),
    };
    await confirm(server, modal);
    await verify();
    await notice('已录入 2 张，跳过 0 张', modal);
    await settled(server);
    assertRequest(server, corrected, 4);
    expect(writes(server).at(-1)!.headers.get('Idempotency-Key')).not.toBe(
      writes(server)[0]!.headers.get('Idempotency-Key'),
    );
    expect(writes(server)).toHaveLength(4);
    cleanup();

    // Control: a 10403 of a first submission (never unknown) unlocks as before.
    const fresh = approvedRows(1);
    const other = serverFor(fresh);
    refuse(other, FORBIDDEN);
    other.once('POST', MANUAL, () => reply(other, paid(fresh)));
    await mount(other);
    await select(fresh);
    const dialog = await open();
    const sent = await fillRows(dialog, fresh);
    await confirm(other, dialog);
    await verify();
    await settled(other);
    assertRequest(other, sent);
    await refusedAndUnlocked(other, dialog, FORBIDDEN, 1);
    await confirm(other, dialog);
    await verify();
    await notice('已录入 1 张，跳过 0 张', dialog);
    await settled(other);
    assertRequest(other, sent, 2);
    expect(writes(other).at(-1)!.headers.get('Idempotency-Key')).not.toBe(
      writes(other)[0]!.headers.get('Idempotency-Key'),
    );
  },
);

it(
  '[AC-F1-08as-MANUAL#3] 结果未知后【重试】收到 10003（凭证未被接受，照旧）：重新动态码、验证前不重发，验证后原键原体再发；这次收到带外壳的 10403 仍是结果未知、只剩【重试】【去列表核对】；再【重试】原键原体拿到同键回放的逐单成功才解除：显示「已录入 2 张，跳过 0 张」、可关闭',
  { timeout: 180_000 },
  async () => {
    const rows = approvedRows(2);
    const server = serverFor(rows);
    loseAfterEffect(server, rows);
    server.once('POST', MANUAL, () => failure(10003, { tier: 'totp' }));
    refuse(server, FORBIDDEN);
    server.once('POST', MANUAL, () => reply(server, paid(rows)));
    await mount(server);
    await select(rows);
    const modal = await open();
    const body = await fillRows(modal, rows);
    const original = inputs(modal).map((input) => input.value);
    await confirm(server, modal);
    await verify();
    await settled(server);
    await unknown(modal);

    await retry(server, modal);
    await waitFor(() => expect(stepDialogs()).toHaveLength(1));
    await notice('动态码凭证已失效，请重新输入动态码');
    assertReplay(server, body, 2);
    expect(inputs(modal).map((input) => disabled(input))).toEqual(original.map(() => true));
    await settle();
    expect(writes(server)).toHaveLength(2);

    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(3));
    await settled(server);
    await refusedYetUnknown(server, modal, FORBIDDEN, body, 3, original);

    await retry(server, modal);
    assertReplay(server, body, 4);
    await notice('已录入 2 张，跳过 0 张', modal);
    for (const row of rows) await notice('已录入', rowOf(modal, row.out_biz_no));
    expect(within(modal).queryAllByText(UNKNOWN_NOTICE, { exact: true })).toEqual([]);
    await settled(server);
    expect(disabled(button(modal, '关闭'))).toBe(false);
    expect(writes(server)).toHaveLength(4);
  },
);
