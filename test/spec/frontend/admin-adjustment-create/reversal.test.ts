// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJ,
  ADJUSTMENTS,
  ADJUSTMENT_ORDER,
  COLUMN,
  DIRECTION_NAME,
  ERROR,
  FIELD,
  LABEL,
  NOTE,
  READ_TEXT,
  SUMMARY,
  SUMMARY_LABELS,
  TEXT,
  USER,
  alreadyReversed,
  createWriteServer,
  createdId,
  passOf,
  reasonName,
  rejected,
  statusName,
  yuan,
  type CreateReversal,
} from './fixtures.ts';
import {
  assertWrite,
  button,
  buttons,
  click,
  dialogsTitled,
  drawer,
  fieldValue,
  fields,
  hasText,
  mount,
  nonReadsSince,
  openDetail,
  openReverse,
  panel,
  pick,
  pressSubmit,
  reverseDialog,
  rowReverse,
  rowWith,
  settled,
  stepUpDialogs,
  submitWithSms,
  textbox,
  typeInto,
  valueOf,
  waitColumn,
  type WriteServer,
} from './helpers.ts';

async function ready(server: WriteServer): Promise<void> {
  await mount(server);
  await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
  await settled(server);
}
function rowOf(adjustId: string): HTMLElement {
  return rowWith(panel(), COLUMN.id, adjustId).element;
}
const ROW_TITLES = [COLUMN.direction, COLUMN.amount, COLUMN.reason, COLUMN.status, COLUMN.reversal];
const notAllowed = (): Response => rejected(['reverses_adjust_id'], 'reverse_not_allowed');
const userDeleted = (): Response => rejected(['reverses_adjust_id'], 'adjust_user_deleted');

it(
  '[AC-F1-08cb-REVERSE#1] 行上【红冲】打开「红冲调账单」：原单摘要与新单预览（方向相反、金额等于原单，只读）；对话框里只有「红冲原因」一个输入，没有方向、金额、原因码、单据、科目可改；红冲原因只有空白时本地提示「请填写红冲原因」、不发请求',
  { timeout: 60_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const since = server.log.length;
    const dialog = await openReverse(rowOf(ADJ.reconFix));
    expect(fields(dialog, SUMMARY_LABELS)).toEqual({
      [SUMMARY.id]: ADJ.reconFix,
      [SUMMARY.user]: USER.recon,
      [SUMMARY.direction]: DIRECTION_NAME.increase,
      [SUMMARY.amount]: yuan(123456789),
      [SUMMARY.reason]: reasonName('RECON_FIX'),
      [SUMMARY.newDirection]: DIRECTION_NAME.decrease,
      [SUMMARY.newAmount]: yuan(123456789),
    });
    expect(within(dialog).queryAllByRole('textbox')).toEqual([textbox(dialog, LABEL.reverseNote)]);
    expect(within(dialog).queryAllByRole('spinbutton')).toEqual([]);
    expect(within(dialog).queryAllByRole('combobox')).toEqual([]);
    expect(within(dialog).queryAllByRole('radio')).toEqual([]);
    expect(within(dialog).queryAllByRole('checkbox')).toEqual([]);

    await typeInto(dialog, LABEL.reverseNote, '   ');
    await pressSubmit(dialog);
    await waitFor(() => expect(hasText(dialog, ERROR.reverseNoteRequired)).toBe(true));
    await settled(server);
    expect(reverseDialog()).toBe(dialog);
    expect(stepUpDialogs()).toEqual([]);
    expect(nonReadsSince(server, since)).toEqual([]);
  },
);

it(
  '[AC-F1-08cb-REVERSE#2] 行上红冲提交：短信验证后只发一次 POST，请求体恰为 reverses_adjust_id + 去空白的 note（不带方向、金额、原因码、单据、科目），带 X-Step-Up-Token 与 Idempotency-Key；成功提示红冲单号、关对话框、列表刷新：红冲单在首行（调减、原金额、同原因、已生效），原单显示已红冲且不再有【红冲】',
  { timeout: 90_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const reads = server.tableReads(ADJUSTMENTS).length;
    const dialog = await openReverse(rowOf(ADJ.reconFix));
    await typeInto(dialog, LABEL.reverseNote, `  ${NOTE.reversal}  `);
    const request = await submitWithSms(server, dialog);
    const body: CreateReversal = { reverses_adjust_id: ADJ.reconFix, note: NOTE.reversal };
    assertWrite(server, request, body, passOf(1));
    expect(server.writes()).toHaveLength(1);

    await waitFor(() => expect(hasText(document.body, TEXT.reversed(createdId(1)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.reverseTitle)).toEqual([]));
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
    expect(server.tableReads(ADJUSTMENTS).length).toBeGreaterThan(reads);
    expect(pick(rowWith(panel(), COLUMN.id, createdId(1)), ROW_TITLES)).toEqual({
      [COLUMN.direction]: DIRECTION_NAME.decrease,
      [COLUMN.amount]: yuan(123456789),
      [COLUMN.reason]: reasonName('RECON_FIX'),
      [COLUMN.status]: statusName('APPROVED'),
      [COLUMN.reversal]: READ_TEXT.dash,
    });
    const original = rowWith(panel(), COLUMN.id, ADJ.reconFix);
    expect(original.cells[COLUMN.reversal]).toBe(READ_TEXT.reversed);
    expect(rowReverse(ADJ.reconFix)).toEqual([]);
    expect(rowReverse(createdId(1))).toEqual([]);
    expect(server.writes()).toHaveLength(1);
    expect(server.unexpected()).toEqual([]);
  },
);

it(
  '[AC-F1-08cb-REVERSE#3] 详情上【红冲】（其他、¥0.05）：摘要按该单；成功后详情重新读取，显示「已红冲」与红冲单号、不再有【红冲】，列表同时刷新',
  { timeout: 90_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    await openDetail(server, ADJ.otherNote);
    const reads = server.detailReads(ADJ.otherNote).length;
    const listReads = server.tableReads(ADJUSTMENTS).length;
    const dialog = await openReverse(drawer());
    expect(fields(dialog, SUMMARY_LABELS)).toEqual({
      [SUMMARY.id]: ADJ.otherNote,
      [SUMMARY.user]: USER.service,
      [SUMMARY.direction]: DIRECTION_NAME.increase,
      [SUMMARY.amount]: yuan(5),
      [SUMMARY.reason]: reasonName('OTHER'),
      [SUMMARY.newDirection]: DIRECTION_NAME.decrease,
      [SUMMARY.newAmount]: yuan(5),
    });
    await typeInto(dialog, LABEL.reverseNote, NOTE.reversal);
    const request = await submitWithSms(server, dialog);
    const body: CreateReversal = { reverses_adjust_id: ADJ.otherNote, note: NOTE.reversal };
    assertWrite(server, request, body, passOf(1));

    await waitFor(() => expect(hasText(document.body, TEXT.reversed(createdId(1)))).toBe(true));
    await waitFor(() => expect(server.detailReads(ADJ.otherNote).length).toBeGreaterThan(reads));
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS).length).toBeGreaterThan(listReads));
    await settled(server);
    await waitFor(() => expect(fieldValue(drawer(), FIELD.reversedBy)).toBe(createdId(1)));
    expect(hasText(drawer(), READ_TEXT.reversed)).toBe(true);
    expect(buttons(drawer(), TEXT.reverseEntry)).toEqual([]);
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
    expect(rowReverse(ADJ.otherNote)).toEqual([]);
    expect(server.writes()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cb-REVERSE#4] 同一原单已被别人红冲：POST 返回 20902（data.resource=admin_adjustment）→ 提示「该调账单已被红冲，已刷新」，详情与列表重新读取后显示已红冲、不再有【红冲】；不自动重发',
  { timeout: 90_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    await openDetail(server, ADJ.reconFix);
    const reads = server.detailReads(ADJ.reconFix).length;
    const listReads = server.tableReads(ADJUSTMENTS).length;
    const dialog = await openReverse(drawer());
    await typeInto(dialog, LABEL.reverseNote, NOTE.reversal);
    server.once('POST', ADJUSTMENTS, () => {
      server.reverseElsewhere(ADJ.reconFix);
      return alreadyReversed();
    });
    const request = await submitWithSms(server, dialog);
    expect(request.body).toEqual({ reverses_adjust_id: ADJ.reconFix, note: NOTE.reversal });

    await waitFor(() => expect(hasText(document.body, ERROR.alreadyReversed)).toBe(true));
    await waitFor(() => expect(server.detailReads(ADJ.reconFix).length).toBeGreaterThan(reads));
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS).length).toBeGreaterThan(listReads));
    await settled(server);
    await waitFor(() => expect(hasText(drawer(), READ_TEXT.reversed)).toBe(true));
    expect(buttons(drawer(), TEXT.reverseEntry)).toEqual([]);
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
    expect(rowReverse(ADJ.reconFix)).toEqual([]);
    expect(server.writes()).toHaveLength(1);
    expect(server.codeSends()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cb-REVERSE#5] 20001 按 data.reason 提示且对话框保留、红冲原因不丢：reverse_not_allowed → 「该调账单不能红冲：未生效或本身是红冲单」；adjust_user_deleted → 「该用户已注销或正在注销，不能调账」；每次都只发一次、不自动重发',
  { timeout: 90_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const dialog = await openReverse(rowOf(ADJ.restore));
    await typeInto(dialog, LABEL.reverseNote, NOTE.reversal);
    const body: CreateReversal = { reverses_adjust_id: ADJ.restore, note: NOTE.reversal };

    server.once('POST', ADJUSTMENTS, notAllowed);
    const first = await submitWithSms(server, dialog);
    expect(first.body).toEqual(body);
    await waitFor(() => expect(hasText(reverseDialog(), ERROR.reverseNotAllowed)).toBe(true));
    expect(reverseDialog()).toBe(dialog);
    expect(valueOf(dialog, LABEL.reverseNote)).toBe(NOTE.reversal);
    expect(server.writes()).toHaveLength(1);

    server.once('POST', ADJUSTMENTS, userDeleted);
    const second = await submitWithSms(server, dialog);
    expect(second.body).toEqual(body);
    await waitFor(() => expect(hasText(reverseDialog(), ERROR.userDeleted)).toBe(true));
    expect(reverseDialog()).toBe(dialog);
    expect(valueOf(dialog, LABEL.reverseNote)).toBe(NOTE.reversal);
    await settled(server);
    expect(server.writes()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08cb-REVERSE#6] 红冲对话框【取消】：对话框关闭、焦点回到触发的【红冲】，不发任何请求',
  { timeout: 60_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const since = server.log.length;
    const entry = button(rowOf(ADJ.reconFix), TEXT.reverseEntry);
    const dialog = await openReverse(rowOf(ADJ.reconFix));
    await click(button(dialog, TEXT.cancel));
    await waitFor(() => expect(dialogsTitled(TEXT.reverseTitle)).toEqual([]));
    await waitFor(() => expect(document.activeElement).toBe(entry));
    await settled(server);
    expect(nonReadsSince(server, since)).toEqual([]);
  },
);
