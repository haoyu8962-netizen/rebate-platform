// @vitest-environment jsdom
// F1-08ar（FU-F108AL-UNKNOWN-RETRY-10403，编排 D10-2035 甲）：调账页（useAdjustmentWrite，新建调账与红冲）
// 一旦进入「上次提交结果未知」（编排 D10-1731），之后的【重试】只有拿到同键回放的成功才解除。【重试】收到
// 带统一外壳的确定拒绝（10403、20001）时第一次提交仍可能已生效：仍提示结果未知并显示该拒绝的全文，输入仍
// 锁定、没有提交按钮、只剩【重试】【去列表核对】，按 Esc 不关，再【重试】原 Idempotency-Key 与逐字节相同的
// 请求体（BR-FUND-24 ①、BR-ID-34 短信档）。首次提交的确定拒绝照旧解锁、下次换新键；10003 照旧重新短信验证
// 后原键原体再发。
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJ,
  ADJUSTMENTS,
  ADJUSTMENT_ORDER,
  COLUMN,
  DOC,
  ERROR,
  LABEL,
  NOTE,
  READ_TEXT,
  REF_TYPE_NAME,
  TEXT,
  USER,
  createWriteServer,
  createdId,
  denied,
  fenOf,
  passOf,
  reasonName,
  rejected,
  stepUpRequired,
  type CreateNew,
  type CreateReversal,
  type RequestLog,
} from '../admin-adjustment-create/fixtures.ts';
import {
  assertSameWrites,
  assertUnknown,
  assertWrite,
  button,
  buttons,
  changeableControls,
  click,
  createDrawer,
  dialogsTitled,
  fillForm,
  hasText,
  idemOf,
  main,
  mount,
  nonReadsSince,
  openCreate,
  openReverse,
  panel,
  pressEscape,
  prompted,
  refRows,
  retryWithSms,
  reverseDialog,
  rowReverse,
  rowWith,
  settle,
  settled,
  shows,
  stepUpDialogs,
  submitWithSms,
  textbox,
  typeInto,
  usable,
  valueOf,
  verifyUntil,
  waitColumn,
  type NewForm,
  type WriteServer,
} from '../admin-adjustment-create/helpers.ts';

async function ready(server: WriteServer): Promise<void> {
  await mount(server);
  await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
  await settled(server);
}

/** The write that carries the step-up pass `pass`. */
function carrying(pass: string) {
  return (request: RequestLog): boolean => request.headers.get('X-Step-Up-Token') === pass;
}

/**
 * Presses 【重试】 of `root` and passes each sms verification asked for until a write carrying
 * `pass` was sent (answered by an override, so never admitted); returns it once all settled.
 */
async function retryAnsweredBy(
  server: WriteServer,
  root: HTMLElement,
  pass: string,
): Promise<RequestLog> {
  const since = server.writes().length;
  await click(button(root, TEXT.retry));
  await settle();
  const sent = (): RequestLog | undefined => server.writes().slice(since).find(carrying(pass));
  await verifyUntil(server, () => sent() !== undefined);
  await settled(server);
  await waitFor(() => expect(stepUpDialogs()).toEqual([]));
  const found = sent();
  expect(found, `the retried write carrying ${pass}`).toBeDefined();
  return found!;
}

/** A RECON_FIX increase of ¥8.80 for USER.recon (available ¥500.00 → ¥508.80). */
const INCREASE: NewForm = {
  user: USER.recon,
  direction: '调增',
  amount: '8.80',
  reason: reasonName('RECON_FIX'),
  refs: [['recon_diff', DOC.reconDiff]],
  note: NOTE.reconFix,
  subject: '佣金收入',
};
const INCREASE_BODY: CreateNew = {
  user_id: USER.recon,
  direction: 'increase',
  amount_fen: fenOf('8.80'),
  reason_code: 'RECON_FIX',
  refs: [{ ref_type: 'recon_diff', ref_id: DOC.reconDiff }],
  note: NOTE.reconFix,
  contra_subject: 'COMMISSION_REVENUE',
};

/** The whole new form is still there, unchanged. */
function assertSameForm(root: HTMLElement): void {
  expect(valueOf(root, LABEL.user)).toBe(USER.recon);
  expect(valueOf(root, LABEL.amount)).toBe('8.80');
  expect(valueOf(root, LABEL.note)).toBe(NOTE.reconFix);
  expect(refRows(root)).toEqual([[REF_TYPE_NAME.recon_diff, DOC.reconDiff]]);
}

/**
 * After a retry was refused with the notice `refusal`: the refusal is shown, yet `root` is still
 * the one open `title` dialog in the result-unknown state (notice, nothing changeable, no submit
 * button, only 【重试】【去列表核对】), Escape does not close it, nothing was resent and every write
 * is the first one again (same Idempotency-Key, same bytes).
 */
async function refusedYetUnknown(
  server: WriteServer,
  root: HTMLElement,
  title: string,
  refusal: string,
  body: unknown,
  count: number,
): Promise<void> {
  await waitFor(() => expect(shows(refusal)).toBe(true));
  await settled(server);
  expect(dialogsTitled(title)).toEqual([root]);
  assertUnknown(root);
  await pressEscape(root);
  await settled(server);
  expect(dialogsTitled(title)).toEqual([root]);
  assertUnknown(root);
  expect(changeableControls(root)).toEqual([]);
  expect(buttons(root, TEXT.submit)).toEqual([]);
  expect(usable(root, TEXT.cancel)).toEqual([]);
  expect(stepUpDialogs()).toEqual([]);
  expect(server.writes()).toHaveLength(count);
  assertSameWrites(server, body);
}

it(
  '[AC-F1-08ar-ADJUST#1] 新建调账首次已生效但回答丢失 → 结果未知；【重试】短信验证后原键原体收到带外壳的 10403：仍提示「上次提交结果未知……」并显示「无权限执行调账」、全部输入锁定、无提交按钮、只剩【重试】【去列表核对】、Esc 不关、不清键；再【重试】原 Idempotency-Key 与逐字节相同的请求体拿到幂等回放的成功才解除：提示新单号与调账前 ¥500.00 / 调账后 ¥508.80、关抽屉、服务端只生效一张',
  { timeout: 180_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await fillForm(root, INCREASE);

    server.lose('POST', ADJUSTMENTS);
    const first = await submitWithSms(server, root);
    assertWrite(server, first, INCREASE_BODY, passOf(1));
    await waitFor(() => expect(hasText(createDrawer(), TEXT.unknown)).toBe(true));
    assertUnknown(root);
    expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);

    server.once('POST', ADJUSTMENTS, denied, carrying(passOf(2)));
    const second = await retryAnsweredBy(server, root, passOf(2));
    assertWrite(server, second, INCREASE_BODY, passOf(2));
    await refusedYetUnknown(server, root, TEXT.createTitle, ERROR.forbidden, INCREASE_BODY, 2);
    assertSameForm(root);
    expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);

    const third = await retryWithSms(server, root);
    assertWrite(server, third, INCREASE_BODY, passOf(3));
    assertSameWrites(server, INCREASE_BODY);
    expect(server.writes()).toHaveLength(3);
    const prompt = TEXT.createdPrompt(createdId(1), '¥500.00', '¥508.80');
    await waitFor(() => expect(prompted(prompt)).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.createTitle)).toEqual([]));
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
    expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);
    expect(server.unexpected()).toEqual([]);
  },
);

it(
  '[AC-F1-08ar-ADJUST#2] 新建调账结果未知后【重试】两次都收到带外壳的 20001 data.fields=[user_id]：每次仍是结果未知并显示「用户不存在，请核对用户 ID」、不解锁、键与请求体不变；【去列表核对】关抽屉、列表刷新显示已生效的单、不再发写；对照：再开新建、首次提交即收 10403 照旧解锁（无结果未知提示与【重试】、可改、提交可用），再提交换新键',
  { timeout: 240_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await fillForm(root, INCREASE);

    server.lose('POST', ADJUSTMENTS);
    const first = await submitWithSms(server, root);
    assertWrite(server, first, INCREASE_BODY, passOf(1));
    await waitFor(() => expect(hasText(createDrawer(), TEXT.unknown)).toBe(true));
    assertUnknown(root);

    for (const count of [2, 3]) {
      server.once('POST', ADJUSTMENTS, () => rejected(['user_id']), carrying(passOf(count)));
      const sent = await retryAnsweredBy(server, root, passOf(count));
      assertWrite(server, sent, INCREASE_BODY, passOf(count));
      await refusedYetUnknown(
        server,
        root,
        TEXT.createTitle,
        ERROR.userUnknown,
        INCREASE_BODY,
        count,
      );
      assertSameForm(root);
    }

    const reads = server.tableReads(ADJUSTMENTS).length;
    const since = server.log.length;
    await click(button(root, TEXT.check));
    await waitFor(() => expect(dialogsTitled(TEXT.createTitle)).toEqual([]));
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS).length).toBeGreaterThan(reads));
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
    await settled(server);
    expect(nonReadsSince(server, since)).toEqual([]);
    expect(server.writes()).toHaveLength(3);
    expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);

    // Control: a settled refusal of a first submission (never unknown) unlocks as before.
    await click(button(main(), TEXT.createEntry));
    await settle();
    await waitFor(() => expect(dialogsTitled(TEXT.createTitle)).toHaveLength(1));
    const again = createDrawer();
    await waitFor(() => expect(valueOf(again, LABEL.user)).toBe(''));
    await fillForm(again, INCREASE);
    server.once('POST', ADJUSTMENTS, denied, carrying(passOf(4)));
    const refused = await submitWithSms(server, again);
    assertWrite(server, refused, INCREASE_BODY, passOf(4));
    expect(idemOf(refused)).not.toBe(idemOf(first));
    await waitFor(() => expect(shows(ERROR.forbidden)).toBe(true));
    await settled(server);
    expect(createDrawer()).toBe(again);
    expect(hasText(again, TEXT.unknown)).toBe(false);
    expect(buttons(again, TEXT.retry)).toEqual([]);
    expect(buttons(again, TEXT.check)).toEqual([]);
    expect(usable(again, TEXT.submit)).toHaveLength(1);
    expect(textbox(again, LABEL.user).disabled).toBe(false);
    expect(textbox(again, LABEL.user).readOnly).toBe(false);
    assertSameForm(again);

    const fixed = await submitWithSms(server, again);
    assertWrite(server, fixed, INCREASE_BODY, passOf(5));
    expect(idemOf(fixed)).not.toBe(idemOf(refused));
    expect(idemOf(fixed)).not.toBe(idemOf(first));
    expect(server.writes()).toHaveLength(5);
    const prompt = TEXT.createdPrompt(createdId(2), '¥500.00', '¥508.80');
    await waitFor(() => expect(prompted(prompt)).toBe(true));
    expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 2);
    expect(server.unexpected()).toEqual([]);
  },
);

const REVERSAL_BODY: CreateReversal = { reverses_adjust_id: ADJ.reconFix, note: NOTE.reversal };

it(
  '[AC-F1-08ar-ADJUST#3] 红冲首次已生效但回答丢失 → 结果未知；【重试】先收 10003（重新短信验证后原键原体再发，不算解除）、再收带外壳的 10403：仍是结果未知并显示「无权限执行调账」、红冲原因锁定、无提交按钮、只剩【重试】【去列表核对】、Esc 不关；再【重试】原键原体拿到幂等回放的成功才解除：提示红冲单号与红冲前 ¥500.00 / 红冲后 -¥1,234,067.89、原单已红冲，只生效一张红冲单',
  { timeout: 180_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const dialog = await openReverse(rowWith(panel(), COLUMN.id, ADJ.reconFix).element);
    await typeInto(dialog, LABEL.reverseNote, NOTE.reversal);

    server.lose('POST', ADJUSTMENTS);
    const first = await submitWithSms(server, dialog);
    assertWrite(server, first, REVERSAL_BODY, passOf(1));
    await waitFor(() => expect(hasText(reverseDialog(), TEXT.unknown)).toBe(true));
    assertUnknown(dialog);
    expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);

    server.once('POST', ADJUSTMENTS, stepUpRequired, carrying(passOf(2)));
    server.once('POST', ADJUSTMENTS, denied, carrying(passOf(3)));
    const third = await retryAnsweredBy(server, dialog, passOf(3));
    expect(server.verifications()).toHaveLength(3);
    assertWrite(server, server.writes()[1]!, REVERSAL_BODY, passOf(2));
    assertWrite(server, third, REVERSAL_BODY, passOf(3));
    await refusedYetUnknown(server, dialog, TEXT.reverseTitle, ERROR.forbidden, REVERSAL_BODY, 3);
    expect(valueOf(dialog, LABEL.reverseNote).trim()).toBe(NOTE.reversal);
    expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);

    const fourth = await retryWithSms(server, dialog);
    assertWrite(server, fourth, REVERSAL_BODY, passOf(4));
    assertSameWrites(server, REVERSAL_BODY);
    expect(server.writes()).toHaveLength(4);
    const prompt = TEXT.reversedPrompt(createdId(1), '¥500.00', '-¥1,234,067.89');
    await waitFor(() => expect(prompted(prompt)).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.reverseTitle)).toEqual([]));
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
    expect(rowWith(panel(), COLUMN.id, ADJ.reconFix).cells[COLUMN.reversal]).toBe(
      READ_TEXT.reversed,
    );
    expect(rowReverse(ADJ.reconFix)).toEqual([]);
    expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);
    expect(server.unexpected()).toEqual([]);
  },
);
