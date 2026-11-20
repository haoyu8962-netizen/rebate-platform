// @vitest-environment jsdom
// F1-08an：整批拒绝（BR-WDR-12 ① 批次级前置检查、③ 水位检查：不迁移任何单）与首次提交即被确定拒绝
// （10403、20001）。整批拒绝显示各自全文，不显示「已发起打款」；改好后再提交是新操作、换新的
// Idempotency-Key（契约 adminCreatePayoutBatch）；任何拒绝都不自动重发。约定见 ./helpers.ts 开头。
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  EXECUTOR,
  NAME,
  REFUSED_TEXT,
  TEXT,
  assertBatch,
  buttons,
  confirm,
  dialogs,
  executedReply,
  failure,
  keyOf,
  mount,
  notice,
  ok,
  refused,
  resultShown,
  row,
  runBatch,
  serverFor,
  settled,
  shows,
  submitAgainFrom,
  verify,
  writes,
  type RefusedReason,
  type Withdrawal,
} from './helpers.ts';

/** Two APPROVED alipay withdrawals. */
function alipayRows(): Withdrawal[] {
  return [row(1, 'APPROVED', 1234567), row(3, 'APPROVED', 50000)];
}

/** Submit again after a settled refusal: a new key, the same ids, a paying answer this time. */
async function submitAgain(
  server: ReturnType<typeof serverFor>,
  rows: readonly Withdrawal[],
): Promise<void> {
  const modal = await submitAgainFrom(server);
  await confirm(server, modal);
  await verify();
  await waitFor(() => expect(writes(server)).toHaveLength(2));
  await settled(server);
  assertBatch(
    server,
    1,
    rows.map((one) => one.withdrawal_id),
  );
  expect(keyOf(writes(server)[1]!), 'a new operation takes a new key').not.toBe(
    keyOf(writes(server)[0]!),
  );
  for (const one of rows) await resultShown(one.out_biz_no, TEXT.paying);
}

it(
  '[AC-F1-08an-REFUSED#1] 整批拒绝（打款开关已关闭、打款队列已暂停、企业支付宝余额 W 低于预计提现 P）：显示各自全文，任何单都不显示「已发起打款」，也不是结果未知；不自动重发；勾选保留，再提交换新的 Idempotency-Key，第二次进入打款如实显示',
  { timeout: 180_000 },
  async () => {
    const reasons: RefusedReason[] = [
      'payout_disabled',
      'queue_paused',
      'watermark_below_forecast',
    ];
    for (const reason of reasons) {
      const rows = alipayRows();
      const server = serverFor(rows);
      server.once('POST', '/admin/v1/payout-batches', () => ok(refused(reason)));
      server.once('POST', '/admin/v1/payout-batches', () =>
        executedReply(
          server,
          rows.map((one) => one.withdrawal_id),
        ),
      );
      await mount(server, EXECUTOR);
      await runBatch(server, rows);
      await notice(REFUSED_TEXT[reason]!);
      expect(shows(document.body, TEXT.paying), `${reason}: nothing reported as paying`).toBe(
        false,
      );
      expect(shows(document.body, TEXT.unknown), `${reason}: a settled answer`).toBe(false);
      await settled(server);
      expect(writes(server), `${reason}: not sent again by itself`).toHaveLength(1);
      await submitAgain(server, rows);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08an-REFUSED#2] 首次提交即被确定拒绝：带外壳的 10403 提示「无权限执行此操作（需要 payout.execute 权限点）」，20001 data.fields=[withdrawal_ids] 提示「提现单编号有误，请刷新页面后重试」；不进入结果未知（没有【重试】）、不报成功、不自动重发；再提交换新的 Idempotency-Key',
  { timeout: 180_000 },
  async () => {
    for (const { code, data, text } of [
      { code: 10403, data: { reason: 'admin_permission_denied' }, text: TEXT.forbidden },
      { code: 20001, data: { fields: ['withdrawal_ids'] }, text: TEXT.ids },
    ]) {
      const rows = alipayRows();
      const server = serverFor(rows);
      server.once('POST', '/admin/v1/payout-batches', () => failure(code, data));
      server.once('POST', '/admin/v1/payout-batches', () =>
        executedReply(
          server,
          rows.map((one) => one.withdrawal_id),
        ),
      );
      await mount(server, EXECUTOR);
      await runBatch(server, rows);
      await notice(text);
      await settled(server);
      expect(shows(document.body, TEXT.unknown), `${code}: not unknown`).toBe(false);
      for (const modal of dialogs())
        expect(buttons(modal, NAME.retry), `${code}: no 重试`).toEqual([]);
      expect(shows(document.body, TEXT.paying), `${code}: nothing reported as paying`).toBe(false);
      expect(writes(server), `${code}: not sent again by itself`).toHaveLength(1);
      await submitAgain(server, rows);
      cleanup();
    }
  },
);
