// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJ,
  ADJUSTMENT_ORDER,
  AVAILABLE_BEFORE,
  BALANCE,
  COLUMN,
  DIRECTION_NAME,
  DOC,
  ERROR,
  LABEL,
  NOTE,
  OPEN_DECREASE,
  OPEN_DECREASE_FEN,
  PLATFORM_CHOICES,
  READ_TEXT,
  REF_TYPE_NAME,
  SUBJECT_CHOICES,
  SUMMARY,
  SUMMARY_LABELS,
  TEXT,
  USER,
  createWriteServer,
  createdId,
  fenOf,
  openDecrease,
  passOf,
  reasonName,
  statusName,
  yuan,
  type CreateNew,
  type CreateReversal,
} from './fixtures.ts';
import {
  assertWrite,
  button,
  choose,
  click,
  createDrawer,
  dialogsTitled,
  drawer,
  fields,
  fillForm,
  hasText,
  mount,
  nonReadsSince,
  openCreate,
  openDetail,
  openReverse,
  panel,
  pick,
  pressSubmit,
  prompted,
  refRows,
  rowReverse,
  rowWith,
  selectsLabelled,
  settled,
  stepUpDialogs,
  submitWithSms,
  typeInto,
  waitColumn,
  type WriteServer,
} from './helpers.ts';

async function ready(server: WriteServer, order: readonly string[]): Promise<void> {
  await mount(server);
  await waitColumn(COLUMN.id, order);
  await settled(server);
}
function rowOf(adjustId: string): HTMLElement {
  return rowWith(panel(), COLUMN.id, adjustId).element;
}
const BALANCE_LABELS: readonly string[] = [BALANCE.before, BALANCE.after];
const ROW_TITLES = [COLUMN.direction, COLUMN.amount, COLUMN.reason, COLUMN.status];
const WITH_DECREASE: readonly string[] = [...ADJUSTMENT_ORDER, OPEN_DECREASE];

/** Pressing submit shows `error` in the drawer and sends nothing (no code, no verification). */
async function refusedLocally(server: WriteServer, root: HTMLElement, error: string) {
  const since = server.log.length;
  await pressSubmit(root);
  await waitFor(() => expect(hasText(root, error), error).toBe(true));
  await settled(server);
  expect(nonReadsSince(server, since)).toEqual([]);
  expect(stepUpDialogs()).toEqual([]);
  expect(createDrawer()).toBe(root);
}
/** Waits for the success prompt of the `n`-th write and for the drawer to close. */
async function created(n: number): Promise<void> {
  await waitFor(() => expect(hasText(document.body, TEXT.created(createdId(n)))).toBe(true));
  await waitFor(() => expect(dialogsTitled(TEXT.createTitle)).toEqual([]));
}

it(
  '[AC-F1-08cb-REVERSE#7] 红冲对话框显示余额前后两行（adminGetAdjustment balance_preview，经 @couli/money）：行上红冲对账修正 ¥1,234,567.89 →「红冲前可用余额」¥500.00、「红冲后可用余额」-¥1,234,067.89（为负照实显示负数）；详情上红冲其他 ¥0.05 → ¥500.00、¥499.95；打开对话框不发写请求',
  { timeout: 90_000 },
  async () => {
    const server = createWriteServer();
    await ready(server, ADJUSTMENT_ORDER);
    const since = server.log.length;
    expect(yuan(AVAILABLE_BEFORE)).toBe('¥500.00');
    expect(yuan(-123406789)).toBe('-¥1,234,067.89');
    expect(yuan(49995)).toBe('¥499.95');

    const fromRow = await openReverse(rowOf(ADJ.reconFix));
    await waitFor(() =>
      expect(fields(fromRow, BALANCE_LABELS)).toEqual({
        [BALANCE.before]: '¥500.00',
        [BALANCE.after]: '-¥1,234,067.89',
      }),
    );
    expect(fields(fromRow, SUMMARY_LABELS)).toEqual({
      [SUMMARY.id]: ADJ.reconFix,
      [SUMMARY.user]: USER.recon,
      [SUMMARY.direction]: DIRECTION_NAME.increase,
      [SUMMARY.amount]: yuan(123456789),
      [SUMMARY.reason]: reasonName('RECON_FIX'),
      [SUMMARY.newDirection]: DIRECTION_NAME.decrease,
      [SUMMARY.newAmount]: yuan(123456789),
    });
    await click(button(fromRow, TEXT.cancel));
    await waitFor(() => expect(dialogsTitled(TEXT.reverseTitle)).toEqual([]));

    await openDetail(server, ADJ.otherNote);
    const fromDetail = await openReverse(drawer());
    await waitFor(() =>
      expect(fields(fromDetail, BALANCE_LABELS)).toEqual({
        [BALANCE.before]: '¥500.00',
        [BALANCE.after]: '¥499.95',
      }),
    );
    await settled(server);
    expect(nonReadsSince(server, since)).toEqual([]);
    expect(stepUpDialogs()).toEqual([]);
  },
);

it(
  '[AC-F1-08cb-REVERSE#8] 红冲调减原单（打款追回调减 ¥30.00，已生效、未红冲）：红冲方向显示「调增」、红冲金额 ¥30.00、余额 ¥500.00 → ¥530.00；提交后请求体仍只有 reverses_adjust_id 与 note；红冲单在首行为调增、原单显示已红冲且不再有【红冲】',
  { timeout: 90_000 },
  async () => {
    const server = createWriteServer({ extra: [openDecrease()] });
    await ready(server, WITH_DECREASE);
    expect(yuan(OPEN_DECREASE_FEN)).toBe('¥30.00');
    expect(yuan(53000)).toBe('¥530.00');

    const dialog = await openReverse(rowOf(OPEN_DECREASE));
    await waitFor(() =>
      expect(fields(dialog, [...SUMMARY_LABELS, ...BALANCE_LABELS])).toEqual({
        [SUMMARY.id]: OPEN_DECREASE,
        [SUMMARY.user]: USER.payee,
        [SUMMARY.direction]: '调减',
        [SUMMARY.amount]: '¥30.00',
        [SUMMARY.reason]: reasonName('PAYOUT_RECOVERY'),
        [SUMMARY.newDirection]: '调增',
        [SUMMARY.newAmount]: '¥30.00',
        [BALANCE.before]: '¥500.00',
        [BALANCE.after]: '¥530.00',
      }),
    );
    await typeInto(dialog, LABEL.reverseNote, ` ${NOTE.reversal} `);
    const request = await submitWithSms(server, dialog);
    const body: CreateReversal = { reverses_adjust_id: OPEN_DECREASE, note: NOTE.reversal };
    assertWrite(server, request, body, passOf(1));
    expect(server.writes()).toHaveLength(1);

    const prompt = TEXT.reversedPrompt(createdId(1), '¥500.00', '¥530.00');
    await waitFor(() => expect(prompted(prompt)).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.reverseTitle)).toEqual([]));
    await waitColumn(COLUMN.id, [createdId(1), ...WITH_DECREASE]);
    expect(pick(rowWith(panel(), COLUMN.id, createdId(1)), ROW_TITLES)).toEqual({
      [COLUMN.direction]: '调增',
      [COLUMN.amount]: '¥30.00',
      [COLUMN.reason]: reasonName('PAYOUT_RECOVERY'),
      [COLUMN.status]: statusName('APPROVED'),
    });
    const original = rowWith(panel(), COLUMN.id, OPEN_DECREASE);
    expect(original.cells[COLUMN.reversal]).toBe(READ_TEXT.reversed);
    expect(rowReverse(OPEN_DECREASE)).toEqual([]);
    expect(server.writes()).toHaveLength(1);
    expect(server.unexpected()).toEqual([]);
  },
);

it(
  '[AC-F1-08cb-CREATE#5] 对方科目四个选项各提交一次（对账修正调增 ¥8.80）：佣金收入 / 联盟应收（+ 京东）/ 坏账 / 营销费用 → 请求体 contra_subject 依次精确为 COMMISSION_REVENUE / UNION_RECEIVABLE / BAD_DEBT / MKT_EXPENSE，只有联盟应收带 contra_platform=jd',
  { timeout: 300_000 },
  async () => {
    const server = createWriteServer();
    await ready(server, ADJUSTMENT_ORDER);
    expect(SUBJECT_CHOICES.map(([, code]) => code)).toEqual([
      'COMMISSION_REVENUE',
      'UNION_RECEIVABLE',
      'BAD_DEBT',
      'MKT_EXPENSE',
    ]);
    for (const [index, [name, code]] of SUBJECT_CHOICES.entries()) {
      const n = index + 1;
      const root = await openCreate();
      await fillForm(root, {
        user: USER.recon,
        direction: '调增',
        amount: '8.80',
        reason: reasonName('RECON_FIX'),
        refs: [['recon_diff', DOC.reconDiff]],
        note: NOTE.reconFix,
        subject: name,
      });
      const union = code === 'UNION_RECEIVABLE';
      if (union) await choose(root, LABEL.platform, '京东');
      else expect(selectsLabelled(root, LABEL.platform), name).toEqual([]);
      const request = await submitWithSms(server, root);
      const base: CreateNew = {
        user_id: USER.recon,
        direction: 'increase',
        amount_fen: 880,
        reason_code: 'RECON_FIX',
        refs: [{ ref_type: 'recon_diff', ref_id: DOC.reconDiff }],
        note: NOTE.reconFix,
        contra_subject: code,
      };
      const body: CreateNew = union ? { ...base, contra_platform: 'jd' } : base;
      assertWrite(server, request, body, passOf(n));
      await created(n);
      expect(server.writes(), name).toHaveLength(n);
    }
    expect(fenOf('8.80')).toBe(880);
    const newest = [4, 3, 2, 1].map((n) => createdId(n));
    await waitColumn(COLUMN.id, [...newest, ...ADJUSTMENT_ORDER]);
    expect(server.unexpected()).toEqual([]);
  },
);

it(
  '[AC-F1-08cb-CREATE#6] 联盟应收的平台九个值各提交一次（其他调减 ¥1.50，说明代替单据）：淘宝 / 京东 / 拼多多 / 美团 / 唯品会 / 抖音 / 饿了么 / 快手 / 苏宁 → 请求体 contra_platform 依次精确为 taobao / jd / pdd / meituan / vip / douyin / eleme / kuaishou / suning，contra_subject 都是 UNION_RECEIVABLE',
  { timeout: 600_000 },
  async () => {
    const server = createWriteServer();
    await ready(server, ADJUSTMENT_ORDER);
    expect(PLATFORM_CHOICES.map(([, code]) => code)).toEqual([
      'taobao',
      'jd',
      'pdd',
      'meituan',
      'vip',
      'douyin',
      'eleme',
      'kuaishou',
      'suning',
    ]);
    for (const [index, [name, code]] of PLATFORM_CHOICES.entries()) {
      const n = index + 1;
      const root = await openCreate();
      await fillForm(root, {
        user: USER.service,
        direction: '调减',
        amount: '1.50',
        reason: reasonName('OTHER'),
        note: NOTE.service,
        subject: '联盟应收',
        platform: name,
      });
      const request = await submitWithSms(server, root);
      const body: CreateNew = {
        user_id: USER.service,
        direction: 'decrease',
        amount_fen: 150,
        reason_code: 'OTHER',
        refs: [],
        note: NOTE.service,
        contra_subject: 'UNION_RECEIVABLE',
        contra_platform: code,
      };
      assertWrite(server, request, body, passOf(n));
      await created(n);
      expect(server.writes(), name).toHaveLength(n);
    }
    expect(fenOf('1.50')).toBe(150);
    expect(server.unexpected()).toEqual([]);
  },
);

it(
  '[AC-F1-08cb-CREATE#7] 大金额 ¥30,000,000.00（3000000000 分，超过 2^31，契约不设上限）：预览整串为「¥30,000,000.00」，请求体 amount_fen 恰为 3000000000，新单在列表首行显示 ¥30,000,000.00',
  { timeout: 90_000 },
  async () => {
    const server = createWriteServer();
    await ready(server, ADJUSTMENT_ORDER);
    const amount = fenOf('30000000.00');
    expect(amount).toBe(3000000000);
    expect(amount).toBeGreaterThan(2 ** 31);
    expect(yuan(amount)).toBe('¥30,000,000.00');

    const root = await openCreate();
    await fillForm(root, {
      user: USER.recon,
      direction: '调增',
      amount: '30000000.00',
      reason: reasonName('RECON_FIX'),
      refs: [['recon_diff', DOC.reconDiff]],
      note: NOTE.reconFix,
      subject: '坏账',
    });
    const preview = TEXT.preview(USER.recon, '调增', '¥30,000,000.00', reasonName('RECON_FIX'));
    expect(hasText(root, preview)).toBe(true);

    const request = await submitWithSms(server, root);
    const body: CreateNew = {
      user_id: USER.recon,
      direction: 'increase',
      amount_fen: 3000000000,
      reason_code: 'RECON_FIX',
      refs: [{ ref_type: 'recon_diff', ref_id: DOC.reconDiff }],
      note: NOTE.reconFix,
      contra_subject: 'BAD_DEBT',
    };
    assertWrite(server, request, body, passOf(1));
    expect(yuan(AVAILABLE_BEFORE + 3000000000)).toBe('¥30,000,500.00');
    const prompt = TEXT.createdPrompt(createdId(1), '¥500.00', '¥30,000,500.00');
    await waitFor(() => expect(prompted(prompt)).toBe(true));
    await created(1);
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
    expect(pick(rowWith(panel(), COLUMN.id, createdId(1)), ROW_TITLES)).toEqual({
      [COLUMN.direction]: '调增',
      [COLUMN.amount]: '¥30,000,000.00',
      [COLUMN.reason]: reasonName('RECON_FIX'),
      [COLUMN.status]: statusName('APPROVED'),
    });
    expect(server.writes()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cb-CHECK#6] 打款追回恰好 1 张提现单、没有差错单：本地提示「打款追回须关联恰好 1 张提现单和至少 1 张差错单」、不发短信不发 POST、已填不丢；补 1 张差错单后提交，请求体按添加顺序带两张单据',
  { timeout: 90_000 },
  async () => {
    const server = createWriteServer();
    await ready(server, ADJUSTMENT_ORDER);
    const root = await openCreate();
    await fillForm(root, {
      user: USER.payee,
      direction: '调减',
      amount: '100',
      reason: reasonName('PAYOUT_RECOVERY'),
      refs: [['withdrawal', DOC.withdrawal]],
    });
    expect(refRows(root)).toEqual([[REF_TYPE_NAME.withdrawal, DOC.withdrawal]]);
    await refusedLocally(server, root, ERROR.payoutRefs);
    expect(refRows(root)).toEqual([[REF_TYPE_NAME.withdrawal, DOC.withdrawal]]);
    expect(server.others()).toEqual([]);

    await fillForm(root, { refs: [['recon_diff', DOC.payoutDiff]] });
    const request = await submitWithSms(server, root);
    const body: CreateNew = {
      user_id: USER.payee,
      direction: 'decrease',
      amount_fen: 10000,
      reason_code: 'PAYOUT_RECOVERY',
      refs: [
        { ref_type: 'withdrawal', ref_id: DOC.withdrawal },
        { ref_type: 'recon_diff', ref_id: DOC.payoutDiff },
      ],
    };
    assertWrite(server, request, body, passOf(1));
    await created(1);
    expect(server.writes()).toHaveLength(1);
  },
);
