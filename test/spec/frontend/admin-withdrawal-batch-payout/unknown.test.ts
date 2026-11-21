// @vitest-environment jsdom
// F1-08an：【批量自动打款】提交结果未知（D10-1731 / D10-1739，做法同 F1-08ce / F1-08am）：首次提交无回应、
// 无法解析的响应、带统一外壳的 5xx、40901 都算结果未知——提示「上次提交结果未知」、引导去列表核对，键与请求体
// 锁定，只放行「原键原体重试」与「去核对」，不自动重发。重试收到 10403、或 10003 且 data.reason 为验证手机号
// 缺失，仍保持结果未知（D10-2060 / D10-2061）；重试收到 20001 解锁、下次换新键；普通 10003 重新验证后原键原体
// 重发。约定见 ./helpers.ts 开头。
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  EXECUTOR,
  TEXT,
  approvedRows,
  assertBatch,
  assertSameWrites,
  assertUnknown,
  brokenJson,
  checkAction,
  click,
  confirm,
  executedReply,
  failure,
  garbled,
  isTableRead,
  keyOf,
  mount,
  networkDown,
  notice,
  resultShown,
  retry,
  runBatch,
  serverFor,
  settled,
  shows,
  stepDialogs,
  submitAgainFrom,
  ticked,
  verify,
  writes,
} from './helpers.ts';

const BATCHES = '/admin/v1/payout-batches';

it(
  '[AC-F1-08an-UNKNOWN#1] 首次提交无回应 / 无法解析的响应（HTML、残缺 JSON）/ 带外壳的 50001 / 40901：都进入「上次提交结果未知」，只有【重试】与「…核对」可用，Esc 与遮罩关不掉，不自动重发；【重试】先重新动态码，再以原 Idempotency-Key 与逐字节相同的请求体只发一次，拿到确定结果后如实显示',
  { timeout: 300_000 },
  async () => {
    for (const { label, answer } of [
      { label: 'network', answer: networkDown },
      { label: 'html', answer: garbled },
      { label: 'broken json', answer: brokenJson },
      { label: '50001', answer: () => failure(50001, null) },
      { label: '40901', answer: () => failure(40901, {}) },
    ]) {
      const rows = approvedRows();
      const ids = rows.map((one) => one.withdrawal_id);
      const server = serverFor(rows);
      server.once('POST', BATCHES, answer);
      server.once('POST', BATCHES, () => executedReply(server, ids));
      await mount(server, EXECUTOR);
      const modal = await runBatch(server, rows);
      await assertUnknown(server, modal);
      assertBatch(server, 0, ids);
      expect(server.requests('POST', '/admin/v1/auth/step-up'), label).toHaveLength(1);
      expect(shows(document.body, TEXT.paying), `${label}: nothing paying yet`).toBe(false);

      await retry(server, modal);
      assertSameWrites(server, 2);
      assertBatch(server, 1, ids);
      expect(server.requests('POST', '/admin/v1/auth/step-up'), label).toHaveLength(2);
      for (const one of rows) await resultShown(one.out_biz_no, TEXT.paying);
      expect(shows(modal, TEXT.unknown), `${label}: no longer unknown`).toBe(false);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08an-UNKNOWN#2] 结果未知时按「…核对」：不再发写请求，重新读列表；不会凭空报成功',
  { timeout: 90_000 },
  async () => {
    const rows = approvedRows();
    const server = serverFor(rows);
    server.once('POST', BATCHES, networkDown);
    await mount(server, EXECUTOR);
    const modal = await runBatch(server, rows);
    await assertUnknown(server, modal);
    const at = server.log.length;
    await click(checkAction(modal));
    await waitFor(() =>
      expect(server.log.slice(at).some(isTableRead), 'the list read again').toBe(true),
    );
    await settled(server);
    expect(writes(server), 'nothing sent again').toHaveLength(1);
    expect(shows(document.body, TEXT.paying)).toBe(false);
  },
);

it(
  '[AC-F1-08an-UNKNOWN#3] 结果未知后【重试】收到带外壳的 10403，或 10003 且 data.reason=verify_phone_missing：仍是「上次提交结果未知」、只有【重试】与「…核对」、键与请求体不变；再【重试】原键原体拿到确定结果',
  { timeout: 240_000 },
  async () => {
    for (const { label, answer } of [
      { label: '10403', answer: () => failure(10403, { reason: 'admin_permission_denied' }) },
      {
        label: '10003 verify_phone_missing',
        answer: () => failure(10003, { tier: 'sms', reason: 'verify_phone_missing' }),
      },
    ]) {
      const rows = approvedRows();
      const ids = rows.map((one) => one.withdrawal_id);
      const server = serverFor(rows);
      server.once('POST', BATCHES, networkDown);
      server.once('POST', BATCHES, answer);
      server.once('POST', BATCHES, () => executedReply(server, ids));
      await mount(server, EXECUTOR);
      const modal = await runBatch(server, rows);
      await assertUnknown(server, modal);
      await retry(server, modal);
      await assertUnknown(server, modal);
      assertSameWrites(server, 2);
      expect(ticked().length, `${label}: the ticks are kept`).toBe(rows.length);
      await retry(server, modal);
      assertSameWrites(server, 3);
      for (const one of rows) await resultShown(one.out_biz_no, TEXT.paying);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08an-UNKNOWN#4] 结果未知后【重试】收到 20001（data.fields=[withdrawal_ids]）：解除锁定、提示「提现单编号有误，请刷新页面后重试」、不再是结果未知；之后再提交换新的 Idempotency-Key',
  { timeout: 120_000 },
  async () => {
    const rows = approvedRows();
    const ids = rows.map((one) => one.withdrawal_id);
    const server = serverFor(rows);
    server.once('POST', BATCHES, networkDown);
    server.once('POST', BATCHES, () => failure(20001, { fields: ['withdrawal_ids'] }));
    server.once('POST', BATCHES, () => executedReply(server, ids));
    await mount(server, EXECUTOR);
    const modal = await runBatch(server, rows);
    await assertUnknown(server, modal);
    await retry(server, modal);
    await notice(TEXT.ids);
    await settled(server);
    expect(shows(document.body, TEXT.unknown), 'unlocked').toBe(false);
    assertSameWrites(server, 2);
    const again = await submitAgainFrom(server);
    await confirm(server, again);
    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(3));
    await settled(server);
    assertBatch(server, 2, ids);
    expect(keyOf(writes(server)[2]!), 'a new key after the settled refusal').not.toBe(
      keyOf(writes(server)[0]!),
    );
    for (const one of rows) await resultShown(one.out_biz_no, TEXT.paying);
  },
);

it(
  '[AC-F1-08an-UNKNOWN#5] 普通 10003（data.tier=totp，凭证未被接受）：重新弹出动态码并提示「动态码凭证已失效，请重新输入动态码」，验证前不重发；验证后以原 Idempotency-Key 与原请求体只再发一次——首次直接收到与结果未知后重试收到都如此',
  { timeout: 180_000 },
  async () => {
    for (const loseFirst of [false, true]) {
      const rows = approvedRows();
      const ids = rows.map((one) => one.withdrawal_id);
      const server = serverFor(rows);
      if (loseFirst) server.once('POST', BATCHES, networkDown);
      server.once('POST', BATCHES, () => failure(10003, { tier: 'totp' }));
      server.once('POST', BATCHES, () => executedReply(server, ids));
      await mount(server, EXECUTOR);
      const modal = await runBatch(server, rows);
      if (loseFirst) {
        await assertUnknown(server, modal);
        await retry(server, modal);
      }
      const before = loseFirst ? 2 : 1;
      await waitFor(() => expect(stepDialogs()).toHaveLength(1));
      await notice(TEXT.again);
      await settled(server);
      expect(writes(server), 'nothing sent before the new code').toHaveLength(before);
      await verify();
      await waitFor(() => expect(writes(server)).toHaveLength(before + 1));
      await settled(server);
      assertSameWrites(server, before + 1);
      assertBatch(server, before, ids);
      for (const one of rows) await resultShown(one.out_biz_no, TEXT.paying);
      cleanup();
    }
  },
);
