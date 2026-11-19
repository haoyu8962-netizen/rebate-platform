// @vitest-environment jsdom
// F1-08fe ② 调账页新建 / 红冲成功提示加【查看凭证】：跳余额流水页，预填该单的用户与能定位的业务单号（凭证
// biz_id = 新单 / 红冲单的 adjust_id，BR-FUND-16），余额流水按 user_id + ref 读第 1 页。只加导航：
// 写请求仍只有那一次 POST，跳转不再发写请求、不改金额显示。
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJ,
  ADJUSTMENT_ORDER,
  ALL_FUND,
  COLUMN,
  DOC,
  LABEL,
  NOTE,
  SUPER_ADMIN,
  TEXT,
  USER,
  createWriteServer,
  createdId,
  reasonName,
} from '../admin-adjustment-create/fixtures.ts';
import {
  button,
  click,
  fillForm,
  mount,
  openCreate,
  openReverse,
  panel,
  rowWith,
  settle,
  settled,
  shows,
  submitWithSms,
  typeInto,
  waitColumn,
  type WriteServer,
} from '../admin-adjustment-create/helpers.ts';
import { COPY, LEDGER, PAGE, PAGE_SIZE } from './fixtures.ts';
import { inputValue, noticeWith, readsOf, waitTitle, writesSince } from './page-helpers.ts';

const FLOW = { timeout: 120_000 };

async function ready(server: WriteServer): Promise<void> {
  await mount(server, SUPER_ADMIN);
  await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
  await settled(server);
}

/** Presses 【查看凭证】 of the notice holding `line` and waits for 余额流水 and its reads. */
async function viewVoucher(server: WriteServer, line: string): Promise<number> {
  const since = server.log.length;
  await click(button(noticeWith(line), COPY.viewVoucher));
  await settle();
  await waitTitle(PAGE.ledgerTitle);
  await waitFor(() => expect(readsOf(server, LEDGER, since).length).toBeGreaterThan(0));
  await settled(server);
  return since;
}

it(
  '[AC-F1-08fe-VOUCHER#1] 新建调账成功提示里有【查看凭证】：点开进余额流水，「用户 UID」为该单用户，流水按 user_id + ref=新单号读第 1 页；不再发写请求',
  FLOW,
  async () => {
    const server = createWriteServer({ permissions: ALL_FUND });
    await ready(server);
    const root = await openCreate();
    await fillForm(root, {
      user: USER.recon,
      direction: '调增',
      amount: '12.34',
      reason: reasonName('RECON_FIX'),
      refs: [['recon_diff', DOC.reconDiff]],
      note: NOTE.reconFix,
      subject: '佣金收入',
    });
    await submitWithSms(server, root);
    const line = TEXT.created(createdId(1));
    await waitFor(() => expect(shows(line)).toBe(true));
    const since = await viewVoucher(server, line);
    expect(readsOf(server, LEDGER, since)).toEqual([
      { user_id: USER.recon, ref: createdId(1), page: '1', page_size: PAGE_SIZE },
    ]);
    expect(inputValue(PAGE.uidLabel)).toBe(USER.recon);
    expect(inputValue(PAGE.refLabel)).toBe(createdId(1));
    expect(writesSince(server, since)).toEqual([]);
    expect(server.writes()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08fe-VOUCHER#2] 红冲成功提示里有【查看凭证】：点开进余额流水，「用户 UID」为原单用户，流水按 user_id + ref=红冲单号读第 1 页；不再发写请求',
  FLOW,
  async () => {
    const server = createWriteServer({ permissions: ALL_FUND });
    await ready(server);
    const dialog = await openReverse(rowWith(panel(), COLUMN.id, ADJ.reconFix).element);
    await typeInto(dialog, LABEL.reverseNote, NOTE.reversal);
    await submitWithSms(server, dialog);
    const line = TEXT.reversed(createdId(1));
    await waitFor(() => expect(shows(line)).toBe(true));
    const since = await viewVoucher(server, line);
    expect(readsOf(server, LEDGER, since)).toEqual([
      { user_id: USER.recon, ref: createdId(1), page: '1', page_size: PAGE_SIZE },
    ]);
    expect(inputValue(PAGE.uidLabel)).toBe(USER.recon);
    expect(inputValue(PAGE.refLabel)).toBe(createdId(1));
    expect(writesSince(server, since)).toEqual([]);
    expect(server.writes()).toHaveLength(1);
  },
);
