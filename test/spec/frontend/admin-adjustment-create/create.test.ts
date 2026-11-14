// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJUSTMENTS,
  ADJUSTMENT_ORDER,
  CHOOSABLE_REASONS,
  CHOOSABLE_SUBJECTS,
  COLUMN,
  DOC,
  LABEL,
  NOTE,
  PLATFORM_NAMES,
  REF_TYPE_NAME,
  TEXT,
  USER,
  createWriteServer,
  createdId,
  fenOf,
  passOf,
  reasonName,
  statusName,
  yuan,
  type CreateNew,
} from './fixtures.ts';
import {
  assertWrite,
  choose,
  dialogsTitled,
  fillForm,
  hasText,
  idemOf,
  mount,
  nonReadsSince,
  openCreate,
  panel,
  pick,
  refRows,
  rowWith,
  selectsLabelled,
  settled,
  stepUpDialogs,
  submitWithSms,
  textbox,
  usable,
  valueOf,
  waitColumn,
  type WriteServer,
} from './helpers.ts';

async function ready(server: WriteServer): Promise<void> {
  await mount(server);
  await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
  await settled(server);
}
const ROW_TITLES = [COLUMN.user, COLUMN.direction, COLUMN.amount, COLUMN.reason, COLUMN.status];

it(
  '[AC-F1-08cb-CREATE#1] 【新建调账】打开抽屉「新建调账」：一步提交并生效的说明、用户 ID / 调增调减 / 金额（元）/ 原因码 / 单据类型 + 单据号 / 原因说明各 1 个；原因码只给对账修正、打款追回、其他（不出现订单恢复、注销余额转平台收入）；对方科目只在对账修正与其他出现、四选一，联盟应收才出现平台（九个平台）；打款追回不出现对方科目与平台；打开与选择都不发请求',
  { timeout: 90_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const since = server.log.length;
    const root = await openCreate();
    expect(hasText(root, TEXT.oneStep)).toBe(true);
    for (const label of [LABEL.user, LABEL.amount, LABEL.refId, LABEL.note]) textbox(root, label);
    expect(within(root).queryAllByRole('radio')).toHaveLength(2);
    expect(within(root).queryAllByRole('radio', { name: '调增' })).toHaveLength(1);
    expect(within(root).queryAllByRole('radio', { name: '调减' })).toHaveLength(1);
    expect(within(root).queryAllByRole('radio', { checked: true })).toEqual([]);
    expect(refRows(root)).toEqual([]);
    expect(usable(root, TEXT.submit)).toHaveLength(1);
    expect(usable(root, TEXT.cancel)).toHaveLength(1);
    expect(usable(root, TEXT.addRef)).toHaveLength(1);
    expect(selectsLabelled(root, LABEL.subject)).toEqual([]);
    expect(selectsLabelled(root, LABEL.platform)).toEqual([]);

    const reasons = CHOOSABLE_REASONS.map(reasonName);
    expect(await choose(root, LABEL.reason, reasonName('RECON_FIX'))).toEqual(reasons);
    const refTypes = await choose(root, LABEL.refType, REF_TYPE_NAME.recon_diff);
    expect(refTypes).toEqual(Object.values(REF_TYPE_NAME));
    expect(await choose(root, LABEL.subject, '佣金收入')).toEqual(CHOOSABLE_SUBJECTS);
    expect(selectsLabelled(root, LABEL.platform)).toEqual([]);
    expect(await choose(root, LABEL.subject, '联盟应收')).toEqual(CHOOSABLE_SUBJECTS);
    expect(await choose(root, LABEL.platform, '淘宝')).toEqual(PLATFORM_NAMES);

    expect(await choose(root, LABEL.reason, reasonName('PAYOUT_RECOVERY'))).toEqual(reasons);
    expect(selectsLabelled(root, LABEL.subject)).toEqual([]);
    expect(selectsLabelled(root, LABEL.platform)).toEqual([]);

    expect(await choose(root, LABEL.reason, reasonName('OTHER'))).toEqual(reasons);
    expect(selectsLabelled(root, LABEL.subject)).toHaveLength(1);

    expect(nonReadsSince(server, since)).toEqual([]);
    expect(stepUpDialogs()).toEqual([]);
  },
);

it(
  '[AC-F1-08cb-CREATE#2] 对账修正调增 ¥1,234,567.89：预览一行；短信验证后只发一次 POST /admin/v1/adjustments，请求体恰为 user_id / direction / amount_fen=123456789 / reason_code / refs / 去空白的 note / contra_subject（先选联盟应收 + 淘宝再改回佣金收入，不带 contra_platform）；带 X-Step-Up-Token 与 Idempotency-Key；成功提示新单号、关抽屉、列表刷新新单在首行',
  { timeout: 90_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const reads = server.tableReads(ADJUSTMENTS).length;
    const root = await openCreate();
    await fillForm(root, {
      user: `  ${USER.recon}  `,
      direction: '调增',
      amount: '1234567.89',
      reason: reasonName('RECON_FIX'),
      refs: [['recon_diff', `  ${DOC.reconDiff} `]],
      note: `  ${NOTE.reconFix}  `,
      subject: '联盟应收',
      platform: '淘宝',
    });
    await choose(root, LABEL.subject, '佣金收入');
    expect(selectsLabelled(root, LABEL.platform)).toEqual([]);
    expect(refRows(root)).toEqual([[REF_TYPE_NAME.recon_diff, DOC.reconDiff]]);
    const amount = fenOf('1234567.89');
    expect(amount).toBe(123456789);
    const preview = TEXT.preview(USER.recon, '调增', yuan(amount), reasonName('RECON_FIX'));
    expect(hasText(root, preview)).toBe(true);

    const request = await submitWithSms(server, root);
    const body: CreateNew = {
      user_id: USER.recon,
      direction: 'increase',
      amount_fen: amount,
      reason_code: 'RECON_FIX',
      refs: [{ ref_type: 'recon_diff', ref_id: DOC.reconDiff }],
      note: NOTE.reconFix,
      contra_subject: 'COMMISSION_REVENUE',
    };
    assertWrite(server, request, body, passOf(1));
    expect(server.writes()).toHaveLength(1);
    expect(server.codeSends()).toHaveLength(1);
    expect(server.verifications()).toHaveLength(1);

    await waitFor(() => expect(hasText(document.body, TEXT.created(createdId(1)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.createTitle)).toEqual([]));
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
    expect(server.tableReads(ADJUSTMENTS).length).toBeGreaterThan(reads);
    expect(server.writes()).toHaveLength(1);
    expect(server.unexpected()).toEqual([]);
  },
);

it(
  '[AC-F1-08cb-CREATE#3] 打款追回调减 ¥19.99（先选对账修正 + 坏账再改原因码）：对方科目消失，请求体恰为 user_id / decrease / amount_fen=1999 / PAYOUT_RECOVERY / 两张单据（按添加顺序、去空白），不带 note、contra_subject、contra_platform；新单按返回显示在列表首行',
  { timeout: 90_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await fillForm(root, {
      user: USER.payee,
      direction: '调减',
      amount: '19.99',
      reason: reasonName('RECON_FIX'),
      subject: '坏账',
    });
    await fillForm(root, {
      reason: reasonName('PAYOUT_RECOVERY'),
      refs: [
        ['withdrawal', ` ${DOC.withdrawal}`],
        ['recon_diff', `${DOC.payoutDiff}  `],
      ],
    });
    expect(selectsLabelled(root, LABEL.subject)).toEqual([]);
    expect(refRows(root)).toEqual([
      [REF_TYPE_NAME.withdrawal, DOC.withdrawal],
      [REF_TYPE_NAME.recon_diff, DOC.payoutDiff],
    ]);
    const amount = fenOf('19.99');
    expect(amount).toBe(1999);
    const preview = TEXT.preview(USER.payee, '调减', yuan(amount), reasonName('PAYOUT_RECOVERY'));
    expect(hasText(root, preview)).toBe(true);

    const request = await submitWithSms(server, root);
    const body: CreateNew = {
      user_id: USER.payee,
      direction: 'decrease',
      amount_fen: amount,
      reason_code: 'PAYOUT_RECOVERY',
      refs: [
        { ref_type: 'withdrawal', ref_id: DOC.withdrawal },
        { ref_type: 'recon_diff', ref_id: DOC.payoutDiff },
      ],
    };
    assertWrite(server, request, body, passOf(1));
    await waitFor(() => expect(hasText(document.body, TEXT.created(createdId(1)))).toBe(true));
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
    expect(pick(rowWith(panel(), COLUMN.id, createdId(1)), ROW_TITLES)).toEqual({
      [COLUMN.user]: USER.payee,
      [COLUMN.direction]: '调减',
      [COLUMN.amount]: yuan(1999),
      [COLUMN.reason]: reasonName('PAYOUT_RECOVERY'),
      [COLUMN.status]: statusName('APPROVED'),
    });
    expect(server.writes()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cb-CREATE#4] 其他（客服处理说明代替单据）调增 ¥0.05、对方科目联盟应收 + 拼多多：请求体 refs 为空数组、note 去空白、contra_platform=pdd；成功后再开抽屉是空表单，下一单换新 Idempotency-Key、用新的验证',
  { timeout: 120_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const first = await openCreate();
    await fillForm(first, {
      user: USER.service,
      direction: '调增',
      amount: '0.05',
      reason: reasonName('OTHER'),
      note: `\n${NOTE.service}  `,
      subject: '联盟应收',
      platform: '拼多多',
    });
    const once = await submitWithSms(server, first);
    const body: CreateNew = {
      user_id: USER.service,
      direction: 'increase',
      amount_fen: fenOf('0.05'),
      reason_code: 'OTHER',
      refs: [],
      note: NOTE.service,
      contra_subject: 'UNION_RECEIVABLE',
      contra_platform: 'pdd',
    };
    assertWrite(server, once, body, passOf(1));
    await waitFor(() => expect(hasText(document.body, TEXT.created(createdId(1)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.createTitle)).toEqual([]));
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);

    const again = await openCreate();
    expect(valueOf(again, LABEL.user)).toBe('');
    expect(valueOf(again, LABEL.amount)).toBe('');
    expect(valueOf(again, LABEL.note)).toBe('');
    expect(within(again).queryAllByRole('radio', { checked: true })).toEqual([]);
    expect(refRows(again)).toEqual([]);
    await fillForm(again, {
      user: USER.recon,
      direction: '调减',
      amount: '3',
      reason: reasonName('RECON_FIX'),
      refs: [['recon_diff', DOC.reconDiff]],
      subject: '营销费用',
    });
    const twice = await submitWithSms(server, again);
    const next: CreateNew = {
      user_id: USER.recon,
      direction: 'decrease',
      amount_fen: fenOf('3'),
      reason_code: 'RECON_FIX',
      refs: [{ ref_type: 'recon_diff', ref_id: DOC.reconDiff }],
      contra_subject: 'MKT_EXPENSE',
    };
    assertWrite(server, twice, next, passOf(2));
    expect(idemOf(twice)).not.toBe(idemOf(once));
    await waitFor(() => expect(hasText(document.body, TEXT.created(createdId(2)))).toBe(true));
    await waitColumn(COLUMN.id, [createdId(2), createdId(1), ...ADJUSTMENT_ORDER]);
    expect(server.writes()).toHaveLength(2);
    expect(server.unexpected()).toEqual([]);
  },
);
