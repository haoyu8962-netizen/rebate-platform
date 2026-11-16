// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
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
  UNKNOWN_USER,
  USER,
  createWriteServer,
  createdId,
  fenOf,
  passOf,
  reasonName,
  unparsable,
  yuan,
  type CreateNew,
  type CreateReversal,
  type RequestLog,
} from './fixtures.ts';
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
  drawer,
  fillForm,
  hasText,
  idemOf,
  main,
  mount,
  nonReadsSince,
  openCreate,
  openDetail,
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
} from './helpers.ts';

// 编排 D10-1731: a submission that got no reply in the unified envelope (contracts/openapi.yaml
// ErrorEnvelope / the success envelopes) — a network error, or a reply that cannot be parsed —
// enters the result-unknown state: TEXT.unknown shown, every input locked, only 【重试】 (the same
// Idempotency-Key and the same body, byte for byte; sms verification again when needed) and
// 【去列表核对】 (close and refresh the list). A determined reply to the retry ends the state.

async function ready(server: WriteServer): Promise<void> {
  await mount(server);
  await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
  await settled(server);
}
function rowOf(adjustId: string): HTMLElement {
  return rowWith(panel(), COLUMN.id, adjustId).element;
}
/** The write that carries the step-up pass `pass`. */
function carrying(pass: string) {
  return (request: RequestLog): boolean => request.headers.get('X-Step-Up-Token') === pass;
}

/** A RECON_FIX decrease of ¥1,000.00 for USER.recon (available ¥500.00 → -¥500.00). */
const DECREASE: NewForm = {
  user: USER.recon,
  direction: '调减',
  amount: '1000.00',
  reason: reasonName('RECON_FIX'),
  refs: [['recon_diff', DOC.reconDiff]],
  note: NOTE.reconFix,
  subject: '佣金收入',
};
const DECREASE_BODY: CreateNew = {
  user_id: USER.recon,
  direction: 'decrease',
  amount_fen: 100000,
  reason_code: 'RECON_FIX',
  refs: [{ ref_type: 'recon_diff', ref_id: DOC.reconDiff }],
  note: NOTE.reconFix,
  contra_subject: 'COMMISSION_REVENUE',
};
/** A RECON_FIX increase of ¥8.80 for `user`. */
function reconFix(user: string): NewForm {
  return {
    user,
    direction: '调增',
    amount: '8.8',
    reason: reasonName('RECON_FIX'),
    refs: [['recon_diff', DOC.reconDiff]],
    subject: '佣金收入',
  };
}
function reconFixBody(user: string): CreateNew {
  return {
    user_id: user,
    direction: 'increase',
    amount_fen: fenOf('8.8'),
    reason_code: 'RECON_FIX',
    refs: [{ ref_type: 'recon_diff', ref_id: DOC.reconDiff }],
    contra_subject: 'COMMISSION_REVENUE',
  };
}

it(
  '[AC-F1-08cb-ERROR#10] 新建提交后回答丢失（服务端已生效、网络错误）：抽屉进入结果未知——提示「上次提交结果未知……」、所有输入锁定、提交按钮消失、只剩【重试】【去列表核对】，按 Esc 不关闭、不自动重发；【重试】重新短信验证后用原 Idempotency-Key 与逐字节相同的请求体重发，回答再丢仍是结果未知，再【重试】得到幂等重放的成功：提示新单号与调账前 ¥500.00 / 调账后 -¥500.00、关抽屉、列表刷新，服务端只生效一张',
  { timeout: 180_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await fillForm(root, DECREASE);
    expect(fenOf('1000.00')).toBe(100000);
    server.lose('POST', ADJUSTMENTS);
    const first = await submitWithSms(server, root);
    assertWrite(server, first, DECREASE_BODY, passOf(1));
    expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);

    await waitFor(() => expect(hasText(createDrawer(), TEXT.unknown)).toBe(true));
    expect(createDrawer()).toBe(root);
    assertUnknown(root);
    expect(valueOf(root, LABEL.user)).toBe(USER.recon);
    expect(valueOf(root, LABEL.amount)).toBe('1000.00');
    expect(valueOf(root, LABEL.note)).toBe(NOTE.reconFix);
    expect(refRows(root)).toEqual([[REF_TYPE_NAME.recon_diff, DOC.reconDiff]]);
    expect(shows(ERROR.failed)).toBe(false);
    await pressEscape(root);
    await settled(server);
    expect(createDrawer()).toBe(root);
    assertUnknown(root);
    expect(server.writes()).toHaveLength(1);
    expect(stepUpDialogs()).toEqual([]);

    server.lose('POST', ADJUSTMENTS, carrying(passOf(2)));
    const second = await retryWithSms(server, root);
    expect(second.headers.get('X-Step-Up-Token')).toBe(passOf(2));
    assertWrite(server, second, DECREASE_BODY, passOf(2));
    await waitFor(() => expect(hasText(createDrawer(), TEXT.unknown)).toBe(true));
    expect(createDrawer()).toBe(root);
    assertUnknown(root);
    assertSameWrites(server, DECREASE_BODY);

    const third = await retryWithSms(server, root);
    assertWrite(server, third, DECREASE_BODY, passOf(3));
    assertSameWrites(server, DECREASE_BODY);
    expect(yuan(50000 - 100000)).toBe('-¥500.00');
    const prompt = TEXT.createdPrompt(createdId(1), '¥500.00', '-¥500.00');
    await waitFor(() => expect(prompted(prompt)).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.createTitle)).toEqual([]));
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
    expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);
    expect(server.verifications()).toHaveLength(3);
    expect(server.unexpected()).toEqual([]);
  },
);

it(
  '[AC-F1-08cb-ERROR#11] 新建提交得到无法解析的回答（502 网关页、没有统一外壳）：进入结果未知、不提示「提交失败」；【重试】原键原请求体重发，得到确定的拒绝 20001 data.fields=[user_id] 后按原有处理提示「用户不存在，请核对用户 ID」并解锁（结果未知提示与两个按钮消失、输入可改、提交按钮回来）；改正 UID 再提交换新键，成功提示新单号与余额前后',
  { timeout: 180_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await fillForm(root, reconFix(UNKNOWN_USER));
    server.once('POST', ADJUSTMENTS, unparsable);
    const first = await submitWithSms(server, root);
    assertWrite(server, first, reconFixBody(UNKNOWN_USER), passOf(1));
    await waitFor(() => expect(hasText(createDrawer(), TEXT.unknown)).toBe(true));
    assertUnknown(root);
    expect(shows(ERROR.failed)).toBe(false);
    await settled(server);
    expect(server.writes()).toHaveLength(1);

    const second = await retryWithSms(server, root);
    assertWrite(server, second, reconFixBody(UNKNOWN_USER), passOf(server.verifications().length));
    assertSameWrites(server, reconFixBody(UNKNOWN_USER));
    await waitFor(() => expect(hasText(createDrawer(), ERROR.userUnknown)).toBe(true));
    expect(createDrawer()).toBe(root);
    expect(hasText(root, TEXT.unknown)).toBe(false);
    expect(buttons(root, TEXT.retry)).toEqual([]);
    expect(buttons(root, TEXT.check)).toEqual([]);
    expect(usable(root, TEXT.submit)).toHaveLength(1);
    expect(textbox(root, LABEL.user).disabled).toBe(false);
    expect(textbox(root, LABEL.user).readOnly).toBe(false);
    expect(valueOf(root, LABEL.user)).toBe(UNKNOWN_USER);
    const refused = server.writes().length;

    await typeInto(root, LABEL.user, USER.recon);
    const fixed = await submitWithSms(server, root);
    assertWrite(server, fixed, reconFixBody(USER.recon), passOf(server.verifications().length));
    expect(idemOf(fixed)).not.toBe(idemOf(first));
    expect(server.writes()).toHaveLength(refused + 1);
    const prompt = TEXT.createdPrompt(createdId(1), '¥500.00', '¥508.80');
    await waitFor(() => expect(prompted(prompt)).toBe(true));
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
    expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);
  },
);

it(
  '[AC-F1-08cb-ERROR#12] 结果未知时【去列表核对】：关抽屉、焦点回【新建调账】、列表刷新显示已生效的新单，不再发写请求；再按【新建调账】先发列表读、读完前不显示表单，读完才显示空白表单（无结果未知提示，提交按钮可用）',
  { timeout: 120_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const entry = button(main(), TEXT.createEntry);
    const root = await openCreate();
    await fillForm(root, {
      user: USER.service,
      direction: '调增',
      amount: '0.05',
      reason: reasonName('OTHER'),
      note: NOTE.service,
      subject: '联盟应收',
      platform: '拼多多',
    });
    server.lose('POST', ADJUSTMENTS);
    await submitWithSms(server, root);
    await waitFor(() => expect(hasText(createDrawer(), TEXT.unknown)).toBe(true));
    assertUnknown(root);
    await settled(server);
    const reads = server.tableReads(ADJUSTMENTS).length;
    const since = server.log.length;

    await click(button(root, TEXT.check));
    await waitFor(() => expect(dialogsTitled(TEXT.createTitle)).toEqual([]));
    await waitFor(() => expect(document.activeElement).toBe(entry));
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS).length).toBeGreaterThan(reads));
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
    await settled(server);
    expect(nonReadsSince(server, since)).toEqual([]);
    expect(server.writes()).toHaveLength(1);

    const before = server.tableReads(ADJUSTMENTS).length;
    const release = server.hold('GET', ADJUSTMENTS, (r) => r.query['page_size'] !== '1');
    await click(button(main(), TEXT.createEntry));
    await settle();
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS).length).toBeGreaterThan(before));
    const formsShown = dialogsTitled(TEXT.createTitle).filter(
      (node) => within(node).queryAllByLabelText(LABEL.user).length > 0,
    );
    expect(formsShown, 'no form before the list read answers').toEqual([]);
    release();
    await settled(server);
    await waitFor(() => expect(dialogsTitled(TEXT.createTitle)).toHaveLength(1));
    const again = createDrawer();
    await waitFor(() => expect(valueOf(again, LABEL.user)).toBe(''));
    expect(valueOf(again, LABEL.amount)).toBe('');
    expect(valueOf(again, LABEL.note)).toBe('');
    expect(within(again).queryAllByRole('radio', { checked: true })).toEqual([]);
    expect(refRows(again)).toEqual([]);
    expect(hasText(again, TEXT.unknown)).toBe(false);
    expect(buttons(again, TEXT.retry)).toEqual([]);
    expect(usable(again, TEXT.submit)).toHaveLength(1);
    expect(nonReadsSince(server, since)).toEqual([]);
    expect(server.writes()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cb-ERROR#13] 结果未知时【重试】提交中：【重试】不可用、再点不发第二次写；回答前后所有写都是原键原请求体，成功后只生效一张',
  { timeout: 120_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await fillForm(root, reconFix(USER.recon));
    server.lose('POST', ADJUSTMENTS);
    await submitWithSms(server, root);
    await waitFor(() => expect(hasText(createDrawer(), TEXT.unknown)).toBe(true));
    assertUnknown(root);

    const release = server.hold('POST', ADJUSTMENTS, carrying(passOf(2)));
    await click(button(root, TEXT.retry));
    await settle();
    await verifyUntil(server, () => server.writes().some(carrying(passOf(2))));
    await waitFor(() => expect(stepUpDialogs()).toEqual([]));
    const inFlight = server.writes().length;
    expect(server.verifications()).toHaveLength(2);
    await waitFor(() => expect(usable(root, TEXT.retry)).toEqual([]));
    for (const node of buttons(root, TEXT.retry)) await click(node);
    for (const node of buttons(root, TEXT.submit)) await click(node);
    await settle();
    expect(server.writes()).toHaveLength(inFlight);
    expect(server.codeSends()).toHaveLength(2);
    expect(stepUpDialogs()).toEqual([]);
    expect(changeableControls(root)).toEqual([]);

    release();
    await settled(server);
    await waitFor(() => expect(stepUpDialogs()).toEqual([]));
    const prompt = TEXT.createdPrompt(createdId(1), '¥500.00', '¥508.80');
    await waitFor(() => expect(prompted(prompt)).toBe(true));
    expect(server.writes()).toHaveLength(inFlight);
    assertSameWrites(server, reconFixBody(USER.recon));
    expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);
  },
);

it(
  '[AC-F1-08cb-ERROR#14] 红冲提交后回答丢失（行上红冲对账修正，服务端已生效）：对话框进入结果未知——提示、红冲原因锁定、只剩【重试】【去列表核对】、按 Esc 不关闭、不自动重发；【重试】重新短信验证后原键、逐字节相同的请求体（只有 reverses_adjust_id 与 note）重发，幂等重放成功：提示红冲单号与红冲前 ¥500.00 / 红冲后 -¥1,234,067.89、关对话框、列表刷新、原单已红冲，只生效一张红冲单',
  { timeout: 180_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const dialog = await openReverse(rowOf(ADJ.reconFix));
    await typeInto(dialog, LABEL.reverseNote, ` ${NOTE.reversal} `);
    const body: CreateReversal = { reverses_adjust_id: ADJ.reconFix, note: NOTE.reversal };
    server.lose('POST', ADJUSTMENTS);
    const first = await submitWithSms(server, dialog);
    assertWrite(server, first, body, passOf(1));

    await waitFor(() => expect(hasText(reverseDialog(), TEXT.unknown)).toBe(true));
    expect(reverseDialog()).toBe(dialog);
    assertUnknown(dialog);
    expect(valueOf(dialog, LABEL.reverseNote).trim()).toBe(NOTE.reversal);
    expect(shows(ERROR.failed)).toBe(false);
    await pressEscape(dialog);
    await settled(server);
    expect(reverseDialog()).toBe(dialog);
    assertUnknown(dialog);
    expect(server.writes()).toHaveLength(1);

    const second = await retryWithSms(server, dialog);
    assertWrite(server, second, body, passOf(2));
    assertSameWrites(server, body);
    const prompt = TEXT.reversedPrompt(createdId(1), '¥500.00', '-¥1,234,067.89');
    await waitFor(() => expect(prompted(prompt)).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.reverseTitle)).toEqual([]));
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
    expect(rowWith(panel(), COLUMN.id, ADJ.reconFix).cells[COLUMN.reversal]).toBe(
      READ_TEXT.reversed,
    );
    expect(rowReverse(ADJ.reconFix)).toEqual([]);
    expect(shows(ERROR.alreadyReversed)).toBe(false);
    expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);
    expect(server.unexpected()).toEqual([]);
  },
);

it(
  '[AC-F1-08cb-ERROR#15] 详情上红冲得到无法解析的回答：结果未知；其间原单被别人红冲，【重试】原键原请求体重发得到确定的 20902（data.resource=admin_adjustment）→ 按原有处理提示「该调账单已被红冲，已刷新」、结果未知提示与【重试】消失，详情与列表重新读取后显示已红冲、不再有【红冲】',
  { timeout: 180_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    await openDetail(server, ADJ.otherNote);
    const dialog = await openReverse(drawer());
    await typeInto(dialog, LABEL.reverseNote, NOTE.reversal);
    const body: CreateReversal = { reverses_adjust_id: ADJ.otherNote, note: NOTE.reversal };
    server.once('POST', ADJUSTMENTS, unparsable);
    const first = await submitWithSms(server, dialog);
    assertWrite(server, first, body, passOf(1));
    await waitFor(() => expect(hasText(reverseDialog(), TEXT.unknown)).toBe(true));
    assertUnknown(dialog);
    expect(shows(ERROR.failed)).toBe(false);
    await settled(server);
    const reads = server.detailReads(ADJ.otherNote).length;
    const listReads = server.tableReads(ADJUSTMENTS).length;

    // The gateway page reached no service: the key holds no result, so the retry is checked anew
    // and meets the reversal written meanwhile (20902).
    server.reverseElsewhere(ADJ.otherNote);
    const second = await retryWithSms(server, dialog);
    assertWrite(server, second, body, passOf(server.verifications().length));
    assertSameWrites(server, body);
    await waitFor(() => expect(shows(ERROR.alreadyReversed)).toBe(true));
    expect(shows(TEXT.unknown)).toBe(false);
    expect(buttons(document.body, TEXT.retry)).toEqual([]);
    await waitFor(() => expect(server.detailReads(ADJ.otherNote).length).toBeGreaterThan(reads));
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS).length).toBeGreaterThan(listReads));
    await settled(server);
    await waitFor(() => expect(hasText(drawer(), READ_TEXT.reversed)).toBe(true));
    expect(buttons(drawer(), TEXT.reverseEntry)).toEqual([]);
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
    expect(rowReverse(ADJ.otherNote)).toEqual([]);
    expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);
  },
);

it(
  '[AC-F1-08cb-ERROR#16] 红冲结果未知时【去列表核对】：关对话框、列表刷新，红冲单在首行、原单显示已红冲且不再有【红冲】，不再发写请求',
  { timeout: 120_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const dialog = await openReverse(rowOf(ADJ.otherNote));
    await typeInto(dialog, LABEL.reverseNote, NOTE.reversal);
    server.lose('POST', ADJUSTMENTS);
    const first = await submitWithSms(server, dialog);
    expect(first.body).toEqual({ reverses_adjust_id: ADJ.otherNote, note: NOTE.reversal });
    await waitFor(() => expect(hasText(reverseDialog(), TEXT.unknown)).toBe(true));
    assertUnknown(dialog);
    await settled(server);
    const reads = server.tableReads(ADJUSTMENTS).length;
    const since = server.log.length;

    await click(button(dialog, TEXT.check));
    await waitFor(() => expect(dialogsTitled(TEXT.reverseTitle)).toEqual([]));
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS).length).toBeGreaterThan(reads));
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
    await settled(server);
    expect(rowWith(panel(), COLUMN.id, ADJ.otherNote).cells[COLUMN.reversal]).toBe(
      READ_TEXT.reversed,
    );
    expect(rowReverse(ADJ.otherNote)).toEqual([]);
    expect(nonReadsSince(server, since)).toEqual([]);
    expect(server.writes()).toHaveLength(1);
    expect(server.forms).toHaveLength(ADJUSTMENT_ORDER.length + 1);
  },
);
