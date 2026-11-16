// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJUSTMENT_ORDER,
  COLUMN,
  DOC,
  ERROR,
  LABEL,
  NOTE,
  REF_TYPE_NAME,
  USER,
  createWriteServer,
  extraDiff,
  fenOf,
  passOf,
  reasonName,
  type CreateNew,
} from './fixtures.ts';
import {
  addRef,
  assertWrite,
  choose,
  createDrawer,
  fillForm,
  hasText,
  mount,
  nonReadsSince,
  openCreate,
  pressSubmit,
  refRows,
  settled,
  stepUpDialogs,
  submitWithSms,
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

it(
  '[AC-F1-08cb-CHECK#1] 什么都不填就提交：抽屉保留并同时提示「请输入用户 ID」「请选择方向」「请输入大于 0、最多两位小数的金额」「请选择原因码」；不发短信、不弹验证、不发 POST',
  { timeout: 60_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await refusedLocally(server, root, ERROR.userRequired);
    for (const error of [ERROR.directionRequired, ERROR.amountInvalid, ERROR.reasonRequired])
      expect(hasText(root, error), error).toBe(true);
    expect(server.others()).toEqual([]);
  },
);

it(
  '[AC-F1-08cb-CHECK#2] 金额按元输入只收大于 0、最多两位小数：0、0.00、-1、1.234、abc、1e3、空都在本地拦下且已填的其他项不丢；0.01 通过后请求体 amount_fen 为 1（整数分）',
  { timeout: 120_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await fillForm(root, {
      user: USER.service,
      direction: '调增',
      reason: reasonName('OTHER'),
      note: NOTE.service,
      subject: '营销费用',
    });
    for (const amount of ['0', '0.00', '-1', '1.234', 'abc', '1e3', '']) {
      await typeInto(root, LABEL.amount, amount);
      await refusedLocally(server, root, ERROR.amountInvalid);
      expect(valueOf(root, LABEL.user), amount).toBe(USER.service);
      expect(valueOf(root, LABEL.note), amount).toBe(NOTE.service);
    }
    await typeInto(root, LABEL.amount, '0.01');
    const request = await submitWithSms(server, root);
    const body: CreateNew = {
      user_id: USER.service,
      direction: 'increase',
      amount_fen: fenOf('0.01'),
      reason_code: 'OTHER',
      refs: [],
      note: NOTE.service,
      contra_subject: 'MKT_EXPENSE',
    };
    expect(body.amount_fen).toBe(1);
    assertWrite(server, request, body, passOf(1));
    expect(server.writes()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cb-CHECK#3] 按原因码的关联单据与说明：对账修正只有子订单 → 「对账修正须关联至少 1 张差错单」；打款追回缺提现单或有两张提现单 → 「打款追回须关联恰好 1 张提现单和至少 1 张差错单」；其他的说明只有空白 → 「请填写原因说明」，超过 500 字 → 「原因说明最多 500 字」；都不发请求',
  { timeout: 120_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await fillForm(root, {
      user: USER.payee,
      direction: '调减',
      amount: '100',
      reason: reasonName('RECON_FIX'),
      refs: [['order', DOC.order]],
      subject: '佣金收入',
    });
    await refusedLocally(server, root, ERROR.reconFixRefs);

    await choose(root, LABEL.reason, reasonName('PAYOUT_RECOVERY'));
    await addRef(root, 'recon_diff', DOC.payoutDiff);
    await refusedLocally(server, root, ERROR.payoutRefs);
    await addRef(root, 'withdrawal', DOC.withdrawal);
    await addRef(root, 'withdrawal', 'b1000002-0000-4000-8000-000000000002');
    expect(refRows(root)).toHaveLength(4);
    await refusedLocally(server, root, ERROR.payoutRefs);

    await choose(root, LABEL.reason, reasonName('OTHER'));
    await choose(root, LABEL.subject, '营销费用');
    await typeInto(root, LABEL.note, '   ');
    await refusedLocally(server, root, ERROR.noteRequired);
    await typeInto(root, LABEL.note, '说'.repeat(501));
    await refusedLocally(server, root, ERROR.noteTooLong);
    expect(server.others()).toEqual([]);
  },
);

it(
  '[AC-F1-08cb-CHECK#4] 对方科目：对账修正不选科目 → 「请选择对方科目」；选联盟应收不选平台 → 「请选择平台」；都不发请求',
  { timeout: 90_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await fillForm(root, {
      user: USER.recon,
      direction: '调增',
      amount: '12.5',
      reason: reasonName('RECON_FIX'),
      refs: [['recon_diff', DOC.reconDiff]],
    });
    await refusedLocally(server, root, ERROR.subjectRequired);
    await choose(root, LABEL.subject, '联盟应收');
    await refusedLocally(server, root, ERROR.platformRequired);
    expect(server.others()).toEqual([]);
  },
);

it(
  '[AC-F1-08cb-CHECK#5] 关联单据不重复、最多 10 张：同类型同单号（去空白后相同）再添加提示「该单据已添加」且不新增；加满 10 张后再添加提示「关联单据最多 10 张」且仍是 10 张；表格按添加顺序列出',
  { timeout: 120_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await addRef(root, 'recon_diff', DOC.reconDiff);
    await addRef(root, 'recon_diff', `  ${DOC.reconDiff}  `);
    await waitFor(() => expect(hasText(root, ERROR.refDuplicate)).toBe(true));
    expect(refRows(root)).toEqual([[REF_TYPE_NAME.recon_diff, DOC.reconDiff]]);

    const extra = Array.from({ length: 9 }, (_, index) => extraDiff(index + 1));
    for (const refId of extra) await addRef(root, 'recon_diff', refId);
    const ten = [DOC.reconDiff, ...extra].map((refId) => [REF_TYPE_NAME.recon_diff, refId]);
    expect(refRows(root)).toEqual(ten);
    await addRef(root, 'recon_diff', extraDiff(10));
    await waitFor(() => expect(hasText(root, ERROR.refLimit)).toBe(true));
    expect(refRows(root)).toEqual(ten);
    expect(nonReadsSince(server)).toEqual([]);
  },
);
