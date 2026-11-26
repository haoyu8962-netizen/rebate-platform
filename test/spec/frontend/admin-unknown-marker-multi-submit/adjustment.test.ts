// @vitest-environment jsdom
import { act, cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJUSTER,
  ADJUSTMENTS,
  ADJUSTMENT_ORDER,
  COLUMN,
  DOC,
  NOTE,
  TEXT,
  USER,
  createWriteServer,
  createdId,
  networkDown,
  reasonName,
} from '../admin-adjustment-create/fixtures.ts';
import {
  fillForm,
  hasText,
  openCreate,
  pressSubmit,
  prompted,
  settled,
  submitWithSms,
  verifySms,
  waitColumn,
  type NewForm,
} from '../admin-adjustment-create/helpers.ts';
import { BASE_URL, MENU_ID } from '../admin-adjustments-readonly/fixtures.ts';
import {
  ADMIN_ID,
  AT,
  LATER,
  accountOf,
  createConsole,
  expectBanner,
  moveClock,
  startClock,
  takeBaseline,
} from '../admin-unknown-relogin-marker/helpers.ts';
import { AFTER_ANSWERS, UNKNOWN_AT, dismissBanner, expectStoredMarker } from './helpers.ts';

const ACCOUNT = accountOf('finance-jia', ADMIN_ID.first, ADJUSTER);
const FORM: NewForm = {
  user: USER.recon,
  direction: '调增',
  amount: '8.80',
  reason: reasonName('RECON_FIX'),
  refs: [['recon_diff', DOC.reconDiff]],
  note: NOTE.reconFix,
  subject: '佣金收入',
};

async function newAdjustment(): Promise<HTMLElement> {
  const drawer = await openCreate();
  await fillForm(drawer, FORM);
  return drawer;
}

// 主干上红在最后的三项存储断言，useAdjustmentWrite 卸载后直接忽略 A 的断网回答，旧提示清掉后没有新标记。
it('[AC-F1-08atb-ADJUST#1] 新建调账 A 提交在途时离页，返回关闭旧提示后 A 断网；新建调账 B 成功后仍保留 A 的结果未知标记', async () => {
  startClock();
  const server = createWriteServer();
  const app = createConsole({ baseUrl: BASE_URL, fetch: server.fetch, accounts: [ACCOUNT] });
  await app.signIn(ACCOUNT);
  await app.render(MENU_ID);
  await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
  takeBaseline();

  const earlier = await newAdjustment();
  server.once('POST', ADJUSTMENTS, networkDown);
  await submitWithSms(server, earlier);
  await waitFor(() => expect(hasText(earlier, TEXT.unknown)).toBe(true));
  expectStoredMarker(MENU_ID, AT);
  cleanup();
  await app.render(MENU_ID);
  await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);

  const pending = Promise.withResolvers<Response>();
  server.once('POST', ADJUSTMENTS, () => pending.promise);
  const first = await newAdjustment();
  await pressSubmit(first);
  await verifySms(server);
  await waitFor(() => expect(server.writes()).toHaveLength(2));
  cleanup();
  await app.render(MENU_ID);
  await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
  await expectBanner([]);

  moveClock(LATER);
  await dismissBanner();
  await waitFor(() => expect(server.pending).toBe(1));
  moveClock(UNKNOWN_AT);
  await act(async () => pending.reject(new Error('连接中断，未收到调账回答')));
  await settled(server);

  moveClock(AFTER_ANSWERS);
  const second = await newAdjustment();
  await submitWithSms(server, second);
  await waitFor(() =>
    expect(prompted(TEXT.createdPrompt(createdId(1), '¥500.00', '¥508.80'))).toBe(true),
  );
  expect(server.writes()).toHaveLength(3);
  expectStoredMarker(MENU_ID, UNKNOWN_AT);
}, 180_000);
