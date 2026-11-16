// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BATCHES,
  CID,
  CNO,
  NOTICE,
  PAYING_TEXT,
  QID,
  QNO,
  executed,
  failed,
  postOf,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  answerWith,
  assertPost,
  assertResults,
  batchLabels,
  confirm,
  dialogs,
  notice,
  onceHeader,
  open,
  openQueue,
  posts,
  select,
  serverFor,
  settled,
  step,
  stepDialogs,
  ticked,
  verifications,
  verify,
} from './helpers.ts';

// F1-08bb ⑤ errors: 10003 asks for the dynamic code again and the replay keeps the key and the
// body (the step-up pass is a header, not part of the body hash); 10403 names the missing point;
// 20001 tells an id error (data.fields=[withdrawal_ids]) from any other input error; 20901, 40901,
// 5xx and a network error say the submit failed. No error is resent on its own, nothing reads as
// paid, the confirmation dialog and the ticks stay.

const IDS = [QID.approvedA, CID];
const NUMBERS = [QNO.approvedA, CNO];

it(
  '[AC-F1-08bb-ERROR#1] 10003：重新弹出动态码并提示凭证失效，验证前不重发；验证后以新凭证重发，沿用原 Idempotency-Key 与整个请求体，executed 后逐单显示结果',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    server.onceWhere(postOf(BATCHES), () => failed(10003, { tier: 'totp' }));
    answerWith(server, executed(IDS, []));
    const panel = await openQueue(server);
    await select(panel, NUMBERS);
    await confirm(server, await open(server, panel));
    await verify();
    await waitFor(() => expect(posts(server)).toHaveLength(1));
    await step();
    await notice(NOTICE.again);
    await settled(server);
    const first = assertPost(server, IDS, 1, 1);
    expect(posts(server), 'not resent before the new code').toHaveLength(1);
    await verify();
    await waitFor(() => expect(posts(server)).toHaveLength(2));
    await settled(server);
    const second = assertPost(server, IDS, 2, 2);
    expect(onceHeader(second), 'the same key after 10003').toBe(onceHeader(first));
    expect(second.body).toEqual(first.body);
    await assertResults(NUMBERS, [PAYING_TEXT, PAYING_TEXT]);
  },
);

interface Failure {
  readonly reply: () => Response;
  readonly message: string;
}

/** One failed submit: the notice, one POST, one verification, the dialog and the ticks stay. */
async function assertFailure(scenario: Failure): Promise<void> {
  const server = serverFor();
  server.onceWhere(postOf(BATCHES), scenario.reply);
  const panel = await openQueue(server);
  await select(panel, NUMBERS);
  await confirm(server, await open(server, panel));
  await verify();
  await notice(scenario.message);
  await settled(server);
  assertPost(server, IDS, 1, 1);
  expect(verifications(server), 'no new verification').toHaveLength(1);
  expect(posts(server), 'no automatic resubmit').toHaveLength(1);
  expect(within(document.body).queryAllByText(PAYING_TEXT, { exact: true })).toEqual([]);
  expect(batchLabels()).toEqual([]);
  expect(stepDialogs()).toEqual([]);
  expect(dialogs(), 'the confirmation dialog stays').toHaveLength(1);
  expect(ticked(panel), 'the ticks stay').toHaveLength(2);
  cleanup();
}

it(
  '[AC-F1-08bb-ERROR#2] 10403 提示「无权限执行此操作（需要 payout.execute 权限点）」；20001 data.fields=[withdrawal_ids] 提示提现单编号有误，其他字段提示提交内容有误；不报成功、不重发，对话框与勾选保留',
  { timeout: MULTI_TIMEOUT },
  async () => {
    await assertFailure({
      reply: () => failed(10403, { reason: 'admin_permission_denied' }),
      message: NOTICE.forbidden,
    });
    await assertFailure({
      reply: () => failed(20001, { fields: ['withdrawal_ids'] }),
      message: NOTICE.ids,
    });
    await assertFailure({ reply: () => failed(20001, { fields: [] }), message: NOTICE.invalid });
  },
);

it(
  '[AC-F1-08bb-ERROR#3] 20901 与 40901 提示「提交失败，请稍后重试」；不报成功、不自动重新验证或重发，对话框与勾选保留',
  { timeout: MULTI_TIMEOUT },
  async () => {
    await assertFailure({ reply: () => failed(20901), message: NOTICE.failed });
    await assertFailure({ reply: () => failed(40901), message: NOTICE.failed });
  },
);

it(
  '[AC-F1-08bb-ERROR#4] 5xx 提示「提交失败，请稍后重试」，网络错误提示「网络错误，请检查网络后重试；未确认前不会重复提交」；不报成功、不自动重发，对话框与勾选保留',
  { timeout: MULTI_TIMEOUT },
  async () => {
    await assertFailure({ reply: () => failed(50001), message: NOTICE.failed });
    await assertFailure({
      reply: () => {
        throw new Error('simulated network disconnect');
      },
      message: NOTICE.network,
    });
  },
);
