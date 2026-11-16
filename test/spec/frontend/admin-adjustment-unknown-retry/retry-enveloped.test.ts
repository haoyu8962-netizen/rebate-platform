// @vitest-environment jsdom
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
  fenOf,
  passOf,
  reasonName,
  stillRunning,
  unavailable,
  type CreateNew,
  type CreateReversal,
  type RequestLog,
} from '../admin-adjustment-create/fixtures.ts';
import {
  assertSameWrites,
  assertUnknown,
  assertWrite,
  button,
  click,
  createDrawer,
  dialogsTitled,
  fillForm,
  hasText,
  mount,
  openCreate,
  openReverse,
  panel,
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
  typeInto,
  valueOf,
  verifyUntil,
  waitColumn,
  type NewForm,
  type WriteServer,
} from '../admin-adjustment-create/helpers.ts';

// FU-F108CE-RETRY-ENVELOPED-UNKNOWN (编排 D10-1840 / D10-1859): the result-unknown state of
// 编排 D10-1731 ends only on a determined reply. A retry answered *in the unified envelope* with
// 40901 (still processing) or 50001 (service unavailable) is not determined: the submission may
// still take effect. The drawer / dialog must stay in the result-unknown state — notice shown,
// every input locked, no submit button, only 【重试】 and 【去列表核对】 — and the next 【重试】
// must send the original Idempotency-Key and the original body byte for byte. Unlocking there
// would let the operator change the amount and submit under a new key: a second adjustment.
//
// Every case: the first submission takes effect on the server and its reply is lost (fetch throws
// TypeError('Failed to fetch')); 【重试】 (verified again) gets the enveloped 40901 / 50001; the
// next 【重试】 gets the idempotent replay of the first result: one form written, success prompt.

/** An enveloped reply whose outcome is still open (fixtures: stillRunning / unavailable). */
type OpenReply = () => Response;

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
 * `pass` was sent (that write is answered by an override, so it never counts as admitted);
 * returns it once everything has settled.
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

async function createCase(reply: OpenReply): Promise<void> {
  const server = createWriteServer();
  await ready(server);
  const root = await openCreate();
  await fillForm(root, INCREASE);
  expect(fenOf('8.80')).toBe(880);

  // 1. The first submission takes effect, its reply is lost: result unknown.
  server.lose('POST', ADJUSTMENTS);
  const first = await submitWithSms(server, root);
  assertWrite(server, first, INCREASE_BODY, passOf(1));
  await waitFor(() => expect(hasText(createDrawer(), TEXT.unknown)).toBe(true));
  expect(createDrawer()).toBe(root);
  assertUnknown(root);
  assertSameForm(root);
  expect(shows(ERROR.failed)).toBe(false);
  expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);

  // 2. 【重试】 (verified again) is answered in the envelope with 40901 / 50001.
  server.once('POST', ADJUSTMENTS, reply, carrying(passOf(2)));
  const second = await retryAnsweredBy(server, root, passOf(2));
  assertWrite(server, second, INCREASE_BODY, passOf(2));
  assertSameWrites(server, INCREASE_BODY);

  // 3. Still result unknown: nothing changeable, only 【重试】 and 【去列表核对】, nothing resent.
  await settled(server);
  expect(dialogsTitled(TEXT.createTitle)).toHaveLength(1);
  expect(createDrawer()).toBe(root);
  assertUnknown(root);
  assertSameForm(root);
  expect(server.writes()).toHaveLength(2);
  expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);

  // 4. 【重试】 again: the original key and body, byte for byte; the replay of the one form.
  const third = await retryWithSms(server, root);
  assertWrite(server, third, INCREASE_BODY, passOf(server.verifications().length));
  assertSameWrites(server, INCREASE_BODY);
  expect(server.writes()).toHaveLength(3);
  const prompt = TEXT.createdPrompt(createdId(1), '¥500.00', '¥508.80');
  await waitFor(() => expect(prompted(prompt)).toBe(true));
  await waitFor(() => expect(dialogsTitled(TEXT.createTitle)).toEqual([]));
  await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
  expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);
  expect(server.unexpected()).toEqual([]);
}

const REVERSAL_BODY: CreateReversal = { reverses_adjust_id: ADJ.reconFix, note: NOTE.reversal };

async function reversalCase(reply: OpenReply): Promise<void> {
  const server = createWriteServer();
  await ready(server);
  const dialog = await openReverse(rowWith(panel(), COLUMN.id, ADJ.reconFix).element);
  await typeInto(dialog, LABEL.reverseNote, NOTE.reversal);

  // 1. The first submission takes effect, its reply is lost: result unknown.
  server.lose('POST', ADJUSTMENTS);
  const first = await submitWithSms(server, dialog);
  assertWrite(server, first, REVERSAL_BODY, passOf(1));
  await waitFor(() => expect(hasText(reverseDialog(), TEXT.unknown)).toBe(true));
  expect(reverseDialog()).toBe(dialog);
  assertUnknown(dialog);
  expect(valueOf(dialog, LABEL.reverseNote).trim()).toBe(NOTE.reversal);
  expect(shows(ERROR.failed)).toBe(false);
  expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);

  // 2. 【重试】 (verified again) is answered in the envelope with 40901 / 50001.
  server.once('POST', ADJUSTMENTS, reply, carrying(passOf(2)));
  const second = await retryAnsweredBy(server, dialog, passOf(2));
  assertWrite(server, second, REVERSAL_BODY, passOf(2));
  assertSameWrites(server, REVERSAL_BODY);

  // 3. Still result unknown: the reason locked, only 【重试】 and 【去列表核对】, nothing resent.
  await settled(server);
  expect(dialogsTitled(TEXT.reverseTitle)).toHaveLength(1);
  expect(reverseDialog()).toBe(dialog);
  assertUnknown(dialog);
  expect(valueOf(dialog, LABEL.reverseNote).trim()).toBe(NOTE.reversal);
  expect(server.writes()).toHaveLength(2);
  expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);

  // 4. 【重试】 again: the original key and body, byte for byte; the replay of the one reversal.
  const third = await retryWithSms(server, dialog);
  assertWrite(server, third, REVERSAL_BODY, passOf(server.verifications().length));
  assertSameWrites(server, REVERSAL_BODY);
  expect(server.writes()).toHaveLength(3);
  const prompt = TEXT.reversedPrompt(createdId(1), '¥500.00', '-¥1,234,067.89');
  await waitFor(() => expect(prompted(prompt)).toBe(true));
  await waitFor(() => expect(dialogsTitled(TEXT.reverseTitle)).toEqual([]));
  await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
  expect(rowWith(panel(), COLUMN.id, ADJ.reconFix).cells[COLUMN.reversal]).toBe(READ_TEXT.reversed);
  expect(rowReverse(ADJ.reconFix)).toEqual([]);
  expect(shows(ERROR.alreadyReversed)).toBe(false);
  expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);
  expect(server.unexpected()).toEqual([]);
}

it(
  '[AC-F1-08cf-RETRY#1] 新建调账结果未知后【重试】收到带统一外壳的 40901：仍是结果未知——提示仍在、全部输入锁定、无提交按钮、只剩【重试】【去列表核对】、金额 / 原因 / 单据不可改、不自动重发；再【重试】原 Idempotency-Key 与逐字节相同的请求体，幂等重放成功：提示新单号与调账前 ¥500.00 / 调账后 ¥508.80，服务端只生效一张',
  { timeout: 180_000 },
  async () => {
    await createCase(stillRunning);
  },
);

it(
  '[AC-F1-08cf-RETRY#2] 新建调账结果未知后【重试】收到带统一外壳的 50001：仍是结果未知——提示仍在、全部输入锁定、无提交按钮、只剩【重试】【去列表核对】、金额 / 原因 / 单据不可改、不自动重发；再【重试】原 Idempotency-Key 与逐字节相同的请求体，幂等重放成功：提示新单号与调账前 ¥500.00 / 调账后 ¥508.80，服务端只生效一张',
  { timeout: 180_000 },
  async () => {
    await createCase(unavailable);
  },
);

it(
  '[AC-F1-08cf-RETRY#3] 红冲结果未知后【重试】收到带统一外壳的 40901：仍是结果未知——提示仍在、红冲原因锁定、无提交按钮、只剩【重试】【去列表核对】、不自动重发；再【重试】原 Idempotency-Key 与逐字节相同的请求体（只有 reverses_adjust_id 与 note），幂等重放成功：提示红冲单号与红冲前 ¥500.00 / 红冲后 -¥1,234,067.89、原单已红冲，服务端只生效一张红冲单',
  { timeout: 180_000 },
  async () => {
    await reversalCase(stillRunning);
  },
);

it(
  '[AC-F1-08cf-RETRY#4] 红冲结果未知后【重试】收到带统一外壳的 50001：仍是结果未知——提示仍在、红冲原因锁定、无提交按钮、只剩【重试】【去列表核对】、不自动重发；再【重试】原 Idempotency-Key 与逐字节相同的请求体（只有 reverses_adjust_id 与 note），幂等重放成功：提示红冲单号与红冲前 ¥500.00 / 红冲后 -¥1,234,067.89、原单已红冲，服务端只生效一张红冲单',
  { timeout: 180_000 },
  async () => {
    await reversalCase(unavailable);
  },
);
