// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  FIELD,
  ORDER_ID,
  PAID_AT_TYPED,
  PAID_BODY,
  PROOF,
  RESOLVE,
  STATUS_SHOWN,
  TEXT,
  VERIFY,
  WID,
  assertNoEntries,
  assertStillPaying,
  assertWrite,
  confirm,
  dialogs,
  endedElsewhere,
  failure,
  field,
  fill,
  fillPaid,
  idemOf,
  main,
  mount,
  notice,
  openResolve,
  outsideDialogs,
  radio,
  refreshed,
  refusal,
  resolvedPaid,
  resolves,
  resubmit,
  serverFor,
  settled,
  shown,
  step,
  stepDialogs,
  verify,
} from './helpers.ts';

const CORRECTED_ORDER_ID = '20261113220014999';

it(
  '[AC-F1-08aj-ERROR#1] 判已到账的七个 20001 reason 逐个给出 BR-TEXT-14 全文提示，不报成功；对话框与已填内容保留；改正流水号后的请求沿用原 Idempotency-Key（契约：2xxxx 拒绝不存），最终成功',
  { timeout: 120_000 },
  async () => {
    const cases = [
      { fields: ['resolution'], reason: 'resolve_query_failed' },
      { fields: ['paid_at'], reason: 'resolve_paid_at_invalid' },
      { fields: ['channel_order_id'], reason: 'resolve_order_id_taken' },
      { fields: ['channel_order_id'], reason: 'resolve_order_id_other_order' },
      { fields: ['channel_order_id'], reason: 'resolve_order_id_mismatch' },
      { fields: ['resolution'], reason: 'resolve_amount_mismatch' },
      { fields: ['withdrawal_id'], reason: 'resolve_identity_missing' },
    ] as const;
    const server = serverFor();
    for (const one of cases) server.once('POST', RESOLVE, () => refusal(one.fields, one.reason));
    server.once('POST', RESOLVE, (request) => resolvedPaid(server, request));
    await mount(server);
    const dialog = await openResolve();
    await fillPaid(dialog);
    await confirm(server, dialog);
    await verify();
    for (const [index, one] of cases.entries()) {
      if (index > 0) await resubmit(server, dialog, index + 1);
      await waitFor(() => expect(resolves(server)).toHaveLength(index + 1));
      await notice(TEXT.reason[one.reason]);
      await settled(server);
      expect(dialogs()).toContain(dialog);
      expect(radio(dialog, 'paid').checked).toBe(true);
      expect(field(dialog, FIELD.proof).value).toBe(PROOF);
      expect(field(dialog, FIELD.paidAt).value).toBe(PAID_AT_TYPED);
      // The person replaces the serial number after resolve_order_id_taken (index 2).
      const order = index <= 2 ? ORDER_ID : CORRECTED_ORDER_ID;
      expect(field(dialog, FIELD.orderId).value).toBe(order);
      const sent = resolves(server)[index]!;
      assertWrite(server, sent, RESOLVE, { ...PAID_BODY, channel_order_id: order });
      expect(idemOf(sent)).toBe(idemOf(resolves(server)[0]!));
      assertStillPaying();
      if (one.reason === 'resolve_order_id_taken')
        await fill(field(dialog, FIELD.orderId), CORRECTED_ORDER_ID);
    }
    const before = server.detailReads(WID).length;
    await resubmit(server, dialog, cases.length + 1);
    await notice(TEXT.resolved);
    const last = resolves(server).at(-1)!;
    assertWrite(server, last, RESOLVE, { ...PAID_BODY, channel_order_id: CORRECTED_ORDER_ID });
    expect(idemOf(last)).toBe(idemOf(resolves(server)[0]!));
    await refreshed(server, before);
    await waitFor(() => expect(shown(main(), STATUS_SHOWN.PAID_API)).toBeGreaterThan(0));
    assertNoEntries('after W10');
  },
);

it(
  '[AC-F1-08aj-ERROR#2] 只带 data.fields 的 20001 按字段提示：凭证、流水号、实付时间、结论（通用）、提现单不存在；对话框与已填内容保留、不报成功、不自动重发',
  { timeout: 90_000 },
  async () => {
    const cases = [
      { fields: ['proof_text'], text: TEXT.proofField },
      { fields: ['channel_order_id'], text: TEXT.orderIdField },
      { fields: ['paid_at'], text: TEXT.paidAtField },
      { fields: ['resolution'], text: TEXT.invalid },
      { fields: ['withdrawal_id'], text: TEXT.missing },
    ] as const;
    const server = serverFor();
    for (const one of cases) server.once('POST', RESOLVE, () => refusal(one.fields));
    await mount(server);
    const dialog = await openResolve();
    await fillPaid(dialog);
    await confirm(server, dialog);
    await verify();
    for (const [index, one] of cases.entries()) {
      if (index > 0) await resubmit(server, dialog, index + 1);
      await waitFor(() => expect(resolves(server)).toHaveLength(index + 1));
      await notice(one.text);
      await settled(server);
      expect(resolves(server)).toHaveLength(index + 1);
      expect(dialogs()).toContain(dialog);
      expect(radio(dialog, 'paid').checked).toBe(true);
      expect(field(dialog, FIELD.proof).value).toBe(PROOF);
      expect(field(dialog, FIELD.orderId).value).toBe(ORDER_ID);
      expect(field(dialog, FIELD.paidAt).value).toBe(PAID_AT_TYPED);
      const sent = resolves(server)[index]!;
      assertWrite(server, sent, RESOLVE, PAID_BODY);
      expect(idemOf(sent)).toBe(idemOf(resolves(server)[0]!));
      assertStillPaying();
    }
  },
);

it(
  '[AC-F1-08aj-ERROR#3] 处置返回 20902：提示状态已变化并重新读取详情，不重发；对话框关闭，刷新为接口打款成功后入口消失',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    server.once('POST', RESOLVE, () => {
      endedElsewhere(server);
      return failure(20902, { resource: 'withdrawal' });
    });
    await mount(server);
    const dialog = await openResolve();
    await fillPaid(dialog);
    const before = server.detailReads(WID).length;
    await confirm(server, dialog);
    await verify();
    await notice(TEXT.changed);
    await refreshed(server, before);
    await waitFor(() => expect(shown(main(), STATUS_SHOWN.PAID_API)).toBeGreaterThan(0));
    await waitFor(() => expect(dialogs()).toEqual([]));
    assertNoEntries('after 20902');
    expect(resolves(server)).toHaveLength(1);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    expect(outsideDialogs(TEXT.resolved)).toEqual([]);
  },
);

it(
  '[AC-F1-08aj-ERROR#4] 处置返回 10003：重新要动态码，验证前不重发；验证后新凭证、原 Idempotency-Key、原请求体再发，成功后刷新',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    server.once('POST', RESOLVE, () => failure(10003, { tier: 'totp' }));
    server.once('POST', RESOLVE, (request) => resolvedPaid(server, request));
    await mount(server);
    const dialog = await openResolve();
    await fillPaid(dialog);
    const before = server.detailReads(WID).length;
    await confirm(server, dialog);
    await verify();
    await waitFor(() => expect(resolves(server)).toHaveLength(1));
    await step();
    await notice(TEXT.stepAgain);
    await settled(server);
    expect(resolves(server)).toHaveLength(1);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    await verify();
    await waitFor(() => expect(resolves(server)).toHaveLength(2));
    await notice(TEXT.resolved);
    const [first, second] = resolves(server);
    assertWrite(server, first!, RESOLVE, PAID_BODY);
    assertWrite(server, second!, RESOLVE, PAID_BODY);
    expect(first!.headers.get('X-Step-Up-Token')).toBe('unknown-pass-1');
    expect(second!.headers.get('X-Step-Up-Token')).toBe('unknown-pass-2');
    expect(idemOf(second!)).toBe(idemOf(first!));
    await refreshed(server, before);
    await waitFor(() => expect(shown(main(), STATUS_SHOWN.PAID_API)).toBeGreaterThan(0));
  },
);

it(
  '[AC-F1-08aj-ERROR#5] 处置返回 10403 提示缺 payout.execute，20901 提示提交失败；对话框保留、只发一次、不自动重新验证或重发，仍是打款中',
  { timeout: 90_000 },
  async () => {
    const cases = [
      { code: 10403, data: { reason: 'admin_permission_denied' }, text: TEXT.forbidden },
      { code: 20901, data: {}, text: TEXT.failed },
    ];
    for (const one of cases) {
      const server = serverFor();
      server.once('POST', RESOLVE, () => failure(one.code, one.data));
      await mount(server);
      const dialog = await openResolve();
      await fillPaid(dialog);
      await confirm(server, dialog);
      await verify();
      await notice(one.text);
      await settled(server);
      expect(resolves(server)).toHaveLength(1);
      expect(server.requests('POST', VERIFY)).toHaveLength(1);
      expect(stepDialogs()).toEqual([]);
      expect(dialogs()).toContain(dialog);
      assertWrite(server, resolves(server)[0]!, RESOLVE, PAID_BODY);
      assertStillPaying();
      cleanup();
    }
  },
);

it(
  '[AC-F1-08aj-ERROR#6] 结果未定的失败（网络错误、40901）：提示后不自动重发，对话框与内容保留；手动再提交沿用原 Idempotency-Key 与整份请求体，成功后提示',
  { timeout: 90_000 },
  async () => {
    for (const code of [null, 40901] as const) {
      const server = serverFor();
      server.once('POST', RESOLVE, () => {
        if (code === null) throw new Error('simulated network disconnect');
        return failure(code, {});
      });
      server.once('POST', RESOLVE, (request) => resolvedPaid(server, request));
      await mount(server);
      const dialog = await openResolve();
      await fillPaid(dialog);
      await confirm(server, dialog);
      await verify();
      await notice(code === null ? TEXT.network : TEXT.failed);
      await settled(server);
      expect(resolves(server)).toHaveLength(1);
      expect(server.requests('POST', VERIFY)).toHaveLength(1);
      expect(stepDialogs()).toEqual([]);
      expect(dialogs()).toContain(dialog);
      expect(field(dialog, FIELD.orderId).value).toBe(ORDER_ID);
      assertStillPaying();
      await resubmit(server, dialog, 2);
      await notice(TEXT.resolved);
      const [first, second] = resolves(server);
      assertWrite(server, first!, RESOLVE, PAID_BODY);
      assertWrite(server, second!, RESOLVE, PAID_BODY);
      expect(idemOf(first!)).toEqual(expect.stringMatching(/^\S+$/));
      expect(idemOf(second!)).toBe(idemOf(first!));
      cleanup();
    }
  },
);
