// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ENTRY,
  FIELD_TEXT,
  NOTICE,
  WATERMARKS,
  failed,
  postOf,
  type WatermarkRequest,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  answerWith,
  assertPost,
  closed,
  enter,
  entryDialogs,
  fillIn,
  latestPass,
  message,
  messages,
  notice,
  onceHeader,
  openEntry,
  openPanel,
  posts,
  serverFor,
  settled,
  step,
  stepDialogs,
  submitAgain,
  typed,
  verifications,
  verify,
  type Form,
} from './helpers.ts';

// F1-08bc ④ errors of adminCreatePayoutWatermark. 20001 is placed by data.fields at its field
// (measured_at: more than 5 minutes ahead, more than 2 hours old or before the channel's latest —
// judged by the server, the page only shows its answer; available_fen; note), any other 20001 is a
// dialog notice; the dialog and what was typed stay. 10003 asks for the dynamic code again and the
// replay keeps the Idempotency-Key and the body (the contract: "the step-up token is a header and
// not part of the body hash, so a replay after a 10003 keeps its key"). 10403 names the missing
// point. 20901, 40901, 5xx and a network error say the submit failed; nothing is resent on its own.
//
// The Idempotency-Key after a failure. A failure whose outcome is not known (40901 still running,
// 5xx, network) is resubmitted with the same key and body (the contract: "a retry after a timeout
// reuses the key and gets the first result"). After a 20001 the corrected form is another body,
// and the contract keeps a key's first result and answers "same key with another body → 20901"
// without saying that a 20001 is not kept; so the corrected request carries a new key.

const FORM: Form = {
  available: '34567.89',
  measuredAt: '2026-11-14 07:30:00',
  note: '网银余额截图 07:30',
};
const BODY: WatermarkRequest = {
  channel: 'alipay',
  available_fen: 3456789,
  measured_at: '2026-11-14T07:30:00+08:00',
  note: '网银余额截图 07:30',
};

const NONE = { available: [], measuredAt: [], note: [] };

/** Nothing reads as entered; the dialog, without a StepUpModal, stays with what was typed. */
function assertKept(modal: HTMLElement, form: Form): void {
  expect(within(document.body).queryAllByText(NOTICE.done, { exact: true })).toEqual([]);
  expect(stepDialogs(), 'no StepUpModal left open').toEqual([]);
  expect(entryDialogs(), 'the dialog stays').toEqual([modal]);
  expect(typed(modal), 'what was typed stays').toEqual(form);
}

it(
  '[AC-F1-08bc-ERROR#1] 20001 data.fields=[measured_at]（服务端判取数时间晚于现在 5 分钟以上、早于 2 小时以上或早于该通道最近一次）：提示落在取数时间字段，对话框保留、已填不丢、不自动重发；改正取数时间后重提，请求体按新内容、换新的 Idempotency-Key，成功后关闭',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    server.onceWhere(postOf(WATERMARKS), () => failed(20001, { fields: ['measured_at'] }));
    answerWith(server);
    await openPanel(server);
    const modal = await openEntry(server, ENTRY.alipay);
    await enter(server, modal, FORM);
    const first = assertPost(server, BODY, 1, 1);
    const placed = { ...NONE, measuredAt: message(FIELD_TEXT.serverTime) };
    await waitFor(() => expect(messages(modal)).toEqual(placed));
    assertKept(modal, FORM);
    expect(posts(server), 'no automatic resubmit').toHaveLength(1);

    const corrected: Form = { ...FORM, measuredAt: '2026-11-14 09:50:00' };
    await fillIn(modal, corrected);
    await submitAgain(server, modal);
    const body: WatermarkRequest = { ...BODY, measured_at: '2026-11-14T09:50:00+08:00' };
    const second = assertPost(server, body, 2, latestPass(server));
    expect(onceHeader(second), 'a corrected body is a new request').not.toBe(onceHeader(first));
    await closed();
    await notice(NOTICE.done);
  },
);

interface Placement {
  readonly fields: readonly string[];
  readonly placed: Readonly<Record<keyof typeof NONE, readonly string[]>>;
  /** A dialog notice instead of a field message. */
  readonly notice: string | null;
}

it(
  '[AC-F1-08bc-ERROR#2] 20001 data.fields=[available_fen] 提示落在可用余额、[note] 提示落在备注；data.fields 为空或只有 channel 时在对话框提示「提交内容有误，请检查后重试」、不落字段；都不报成功、不重发，对话框与已填保留',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const placements: readonly Placement[] = [
      {
        fields: ['available_fen'],
        placed: { ...NONE, available: message(FIELD_TEXT.serverAmount) },
        notice: null,
      },
      {
        fields: ['note'],
        placed: { ...NONE, note: message(FIELD_TEXT.serverNote) },
        notice: null,
      },
      { fields: [], placed: NONE, notice: NOTICE.invalid },
      { fields: ['channel'], placed: NONE, notice: NOTICE.invalid },
    ];
    for (const placement of placements) {
      const server = serverFor();
      const data = { fields: [...placement.fields] };
      server.onceWhere(postOf(WATERMARKS), () => failed(20001, data));
      await openPanel(server);
      const modal = await openEntry(server, ENTRY.alipay);
      await enter(server, modal, FORM);
      assertPost(server, BODY, 1, 1);
      if (placement.notice !== null) await notice(placement.notice);
      await waitFor(() => expect(messages(modal), data.fields.join()).toEqual(placement.placed));
      await settled(server);
      assertKept(modal, FORM);
      expect(posts(server), 'no automatic resubmit').toHaveLength(1);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08bc-ERROR#3] 10003：重新弹出动态码并提示凭证失效，验证前不重发；验证后以新凭证重发，沿用原 Idempotency-Key 与整个请求体，成功后关闭',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    server.onceWhere(postOf(WATERMARKS), () => failed(10003, { tier: 'totp' }));
    answerWith(server);
    await openPanel(server);
    const modal = await openEntry(server, ENTRY.alipay);
    await enter(server, modal, FORM);
    await step();
    await notice(NOTICE.again);
    await settled(server);
    const first = assertPost(server, BODY, 1, 1);
    expect(posts(server), 'not resent before the new code').toHaveLength(1);
    expect(entryDialogs(), 'the dialog stays').toEqual([modal]);
    await verify();
    await waitFor(() => expect(posts(server)).toHaveLength(2));
    await settled(server);
    const second = assertPost(server, BODY, 2, 2);
    expect(onceHeader(second), 'the same key after 10003').toBe(onceHeader(first));
    expect(verifications(server)).toHaveLength(2);
    await closed();
    await notice(NOTICE.done);
  },
);

interface Failure {
  readonly reply: () => Response;
  readonly notice: string;
  /** The outcome is not known: a resubmit keeps the key and the body. */
  readonly unknown: boolean;
}

/** One failed submit: the notice, one POST, the dialog stays; an unknown one is resubmitted. */
async function assertFailure(scenario: Failure): Promise<void> {
  const server = serverFor();
  server.onceWhere(postOf(WATERMARKS), scenario.reply);
  answerWith(server);
  await openPanel(server);
  const modal = await openEntry(server, ENTRY.alipay);
  await enter(server, modal, FORM);
  await notice(scenario.notice);
  await settled(server);
  const first = assertPost(server, BODY, 1, 1);
  expect(verifications(server), 'no new verification').toHaveLength(1);
  expect(posts(server), 'no automatic resubmit').toHaveLength(1);
  assertKept(modal, FORM);
  if (scenario.unknown) {
    await submitAgain(server, modal);
    const second = assertPost(server, BODY, 2, latestPass(server));
    expect(onceHeader(second), 'the same key for an unknown outcome').toBe(onceHeader(first));
    await closed();
    await notice(NOTICE.done);
  }
  cleanup();
}

it(
  '[AC-F1-08bc-ERROR#4] 10403 提示「无权限执行此操作（需要 fund.cash_entry 权限点）」，20901 提示「提交失败，请稍后重试」；不报成功、不自动重新验证或重发，对话框与已填保留',
  { timeout: MULTI_TIMEOUT },
  async () => {
    await assertFailure({
      reply: () => failed(10403, { reason: 'admin_permission_denied' }),
      notice: NOTICE.forbidden,
      unknown: false,
    });
    await assertFailure({ reply: () => failed(20901), notice: NOTICE.failed, unknown: false });
  },
);

it(
  '[AC-F1-08bc-ERROR#5] 40901、5xx 提示「提交失败，请稍后重试」，网络错误提示「网络错误，请检查网络后重试；未确认前不会重复提交」；不报成功、不自动重发，对话框与已填保留；再点【确认录入】沿用原 Idempotency-Key 与整个请求体',
  { timeout: MULTI_TIMEOUT },
  async () => {
    await assertFailure({ reply: () => failed(40901), notice: NOTICE.failed, unknown: true });
    await assertFailure({ reply: () => failed(50001), notice: NOTICE.failed, unknown: true });
    await assertFailure({
      reply: () => {
        throw new Error('simulated network disconnect');
      },
      notice: NOTICE.network,
      unknown: true,
    });
  },
);
