// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  FAILED_BODY,
  FAILED_PROOF,
  FIELD,
  NAME,
  NET_SHOWN,
  NUMBER,
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
  assertNoOtherActions,
  assertStillPaying,
  assertWrite,
  button,
  choose,
  click,
  confirm,
  dialogs,
  disabled,
  field,
  fill,
  fillFailed,
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
  refusedLocally,
  resolvedPaid,
  resolves,
  resubmit,
  serverFor,
  settled,
  shown,
  step,
  stepDialogs,
  verify,
  writes,
} from './helpers.ts';

it(
  '[AC-F1-08aj-RESOLVE#1] 人工处置判已到账：对话框列单号与实付金额、paid / failed 两个未选的结论、只收文字凭证；确认后动态码，只发一次 POST …/resolve，请求体按契约整份；成功后提示、刷新为接口打款成功、入口消失',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    server.once('POST', RESOLVE, (request) => resolvedPaid(server, request));
    await mount(server);
    const dialog = await openResolve();
    expect(shown(dialog, NUMBER)).toBeGreaterThan(0);
    expect(shown(dialog, NET_SHOWN)).toBeGreaterThan(0);
    const radios = within(dialog).queryAllByRole('radio');
    expect(radios.every((node) => node instanceof HTMLInputElement)).toBe(true);
    const values = radios.map((node) => (node as HTMLInputElement).value);
    expect([...values].sort()).toEqual(['failed', 'paid']);
    expect(radios.some((node) => (node as HTMLInputElement).checked)).toBe(false);
    expect(dialog.querySelectorAll('input[type="file"]')).toHaveLength(0);
    assertNoOtherActions();
    await fillPaid(dialog);
    const before = server.detailReads(WID).length;
    await confirm(server, dialog);
    await verify();
    await waitFor(() => expect(resolves(server)).toHaveLength(1));
    await notice(TEXT.resolved);
    await refreshed(server, before);
    await waitFor(() => expect(shown(main(), STATUS_SHOWN.PAID_API)).toBeGreaterThan(0));
    expect(shown(main(), STATUS_SHOWN.PAYING)).toBe(0);
    expect(shown(main(), ORDER_ID)).toBeGreaterThan(0);
    await waitFor(() => expect(dialogs()).toEqual([]));
    assertNoEntries('after W10');
    expect(writes(server)).toHaveLength(1);
    assertWrite(server, resolves(server)[0]!, RESOLVE, PAID_BODY);
    expect(server.log.indexOf(server.detailReads(WID).at(-1)!)).toBeGreaterThan(
      server.log.indexOf(resolves(server)[0]!),
    );
  },
);

it(
  '[AC-F1-08aj-RESOLVE#2] 判失败照常可选可提交（先填过的流水号与时间不随 failed 发出）；服务端今天一律拒绝，三个 reason 分别给出全文提示，对话框与已填内容保留，修正前后沿用原 Idempotency-Key，页面不自行判成失败或成功',
  { timeout: 90_000 },
  async () => {
    const reasons = [
      'resolve_too_early',
      'resolve_bill_unverifiable',
      'resolve_query_unverifiable',
    ] as const;
    const server = serverFor();
    for (const reason of reasons)
      server.once('POST', RESOLVE, () => refusal(['resolution'], reason));
    await mount(server);
    const dialog = await openResolve();
    await fillPaid(dialog);
    await fillFailed(dialog);
    await confirm(server, dialog);
    await verify();
    for (const [index, reason] of reasons.entries()) {
      // 2xxxx refusals are not stored (contract): the same request is sent again on its own key.
      if (index > 0) await resubmit(server, dialog, index + 1);
      await waitFor(() => expect(resolves(server)).toHaveLength(index + 1));
      await notice(TEXT.reason[reason]);
      await settled(server);
      expect(dialogs()).toContain(dialog);
      expect(radio(dialog, 'failed').checked).toBe(true);
      expect(field(dialog, FIELD.proof).value).toBe(FAILED_PROOF);
      const sent = resolves(server)[index]!;
      assertWrite(server, sent, RESOLVE, FAILED_BODY);
      expect(idemOf(sent)).toBe(idemOf(resolves(server)[0]!));
      assertStillPaying();
    }
    expect(writes(server)).toHaveLength(reasons.length);
  },
);

it(
  '[AC-F1-08aj-RESOLVE#3] 本地校验不过不验证不提交、对话框保留：未选结论、凭证纯空白、流水号为空 / 含空白 / 超 64、实付时间为空或不是有效的北京时间；64 位流水号与 YYYY-MM-DD HH:mm:ss 时间按契约整份送出',
  { timeout: 90_000 },
  async () => {
    const server = serverFor();
    server.once('POST', RESOLVE, (request) => resolvedPaid(server, request));
    await mount(server);
    const dialog = await openResolve();
    await refusedLocally(server, dialog);
    await waitFor(() => expect(shown(dialog, TEXT.resolutionEmpty)).toBeGreaterThan(0));
    await choose(dialog, 'paid');
    await fill(field(dialog, FIELD.orderId), ORDER_ID);
    await fill(field(dialog, FIELD.paidAt), PAID_AT_TYPED);
    for (const blank of ['', '  \n\t ']) {
      await fill(field(dialog, FIELD.proof), blank);
      await refusedLocally(server, dialog);
      await waitFor(() => expect(shown(dialog, TEXT.proofEmpty)).toBeGreaterThan(0));
    }
    await fill(field(dialog, FIELD.proof), PROOF);
    for (const bad of ['', 'ABC 123', 'ABC\t123', 'A'.repeat(65)]) {
      await fill(field(dialog, FIELD.orderId), bad);
      await refusedLocally(server, dialog);
      await waitFor(() => expect(shown(dialog, TEXT.orderIdInvalid)).toBeGreaterThan(0));
    }
    const longest = 'A'.repeat(64);
    await fill(field(dialog, FIELD.orderId), longest);
    for (const bad of ['', '昨天上午十点', '2026-02-30 10:00:00', '2026-11-13 25:00:00']) {
      await fill(field(dialog, FIELD.paidAt), bad);
      await refusedLocally(server, dialog);
      await waitFor(() => expect(shown(dialog, TEXT.paidAtInvalid)).toBeGreaterThan(0));
    }
    await fill(field(dialog, FIELD.paidAt), PAID_AT_TYPED);
    expect(server.requests('POST', VERIFY)).toEqual([]);
    await confirm(server, dialog);
    await verify();
    await waitFor(() => expect(resolves(server)).toHaveLength(1));
    await notice(TEXT.resolved);
    await settled(server);
    const body = { ...PAID_BODY, channel_order_id: longest };
    assertWrite(server, resolves(server)[0]!, RESOLVE, body);
  },
);

it(
  '[AC-F1-08aj-RESOLVE#4] 凭证按 Unicode 码点限 4000：4001 个非 BMP 字符不能提交并提示当前字数，4000 个完整送出、不按 UTF-16 截断',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    server.once('POST', RESOLVE, () => refusal(['resolution'], 'resolve_too_early'));
    await mount(server);
    const dialog = await openResolve();
    await choose(dialog, 'failed');
    await fill(field(dialog, FIELD.proof), '𠮷'.repeat(4001));
    await refusedLocally(server, dialog);
    await waitFor(() => expect(shown(dialog, TEXT.proofTooLong(4001))).toBeGreaterThan(0));
    const proof = '𠮷'.repeat(4000);
    await fill(field(dialog, FIELD.proof), proof);
    await confirm(server, dialog);
    await verify();
    await waitFor(() => expect(resolves(server)).toHaveLength(1));
    await notice(TEXT.reason.resolve_too_early);
    await settled(server);
    const body = { resolution: 'failed', proof_text: proof };
    assertWrite(server, resolves(server)[0]!, RESOLVE, body);
    expect(dialogs()).toContain(dialog);
    expect(field(dialog, FIELD.proof).value).toBe(proof);
  },
);

it(
  '[AC-F1-08aj-RESOLVE#5] 连点确认与验证只发一次处置；请求在途时对话框保留、【确认处置】禁用，再点不发',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    const release = server.hold('POST', RESOLVE, (request) => resolvedPaid(server, request));
    await mount(server);
    try {
      const dialog = await openResolve();
      await fillPaid(dialog);
      const submit = button(dialog, NAME.submit);
      await confirm(server, dialog, true);
      await verify(true);
      await waitFor(() => expect(resolves(server)).toHaveLength(1));
      await waitFor(() => expect(disabled(submit)).toBe(true));
      expect(dialogs()).toContain(dialog);
      await click(submit, true);
      expect(resolves(server)).toHaveLength(1);
      expect(stepDialogs()).toEqual([]);
      expect(server.requests('POST', VERIFY)).toHaveLength(1);
      expect(outsideDialogs(TEXT.resolved)).toEqual([]);
    } finally {
      release();
    }
    await settled(server);
    await notice(TEXT.resolved);
    assertWrite(server, resolves(server)[0]!, RESOLVE, PAID_BODY);
    expect(writes(server)).toHaveLength(1);
  },
);

it(
  '[AC-F1-08aj-RESOLVE#6] 取消处置对话框不发请求、焦点回【人工处置】；取消动态码不提交，关闭后焦点同样返回',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    await mount(server);
    const entry = button(main(), NAME.resolve);
    const dialog = await openResolve();
    await click(button(dialog, NAME.cancel));
    await waitFor(() => expect(dialogs()).toEqual([]));
    await waitFor(() => expect(document.activeElement).toBe(entry));
    expect(server.writes()).toEqual([]);
    const again = await openResolve();
    await fillPaid(again);
    await confirm(server, again);
    await click(button(await step(), NAME.cancel));
    await waitFor(() => expect(stepDialogs()).toEqual([]));
    expect(server.writes()).toEqual([]);
    // The disposal dialog may stay open after the step-up is cancelled; close it as well.
    for (const remaining of dialogs()) await click(button(remaining, NAME.cancel));
    await waitFor(() => expect(dialogs()).toEqual([]));
    await waitFor(() => expect(document.activeElement).toBe(entry));
    expect(server.writes()).toEqual([]);
    assertStillPaying();
  },
);
