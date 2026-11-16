// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BATCHES,
  CID,
  CNO,
  LEFT_TEXT,
  NOTICE,
  PAYING_TEXT,
  QID,
  QNO,
  executed,
  failed,
  postOf,
  type LeftItem,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  answerWith,
  assertPost,
  assertResults,
  checkbox,
  click,
  confirm,
  dialogs,
  dismiss,
  notice,
  onceHeader,
  open,
  openQueue,
  posts,
  select,
  serverFor,
  settled,
  submitAgain,
  ticked,
  verifications,
  verify,
} from './helpers.ts';

// F1-08bb ⑤ idempotency (contract adminCreatePayoutBatch: same key and body → the first result):
// after a failure whose result is unknown (network, 40901, 5xx) the unchanged batch resubmitted by
// hand keeps the key and the body; changing the ticks makes a new operation with a new key, and so
// does a new batch after an executed one.

const IDS = [QID.approvedA, CID];
const NUMBERS = [QNO.approvedA, CNO];
const BLOCKED: LeftItem = { withdrawal_id: CID, reason: 'member_blocked' };

interface Unknown {
  readonly reply: () => Response;
  readonly message: string;
}

/** A failure of unknown result, then 【确认执行】 again in the kept dialog: the same key and body. */
async function assertReplay(scenario: Unknown): Promise<void> {
  const server = serverFor();
  server.onceWhere(postOf(BATCHES), scenario.reply);
  answerWith(server, executed([QID.approvedA], [BLOCKED]));
  const panel = await openQueue(server);
  await select(panel, NUMBERS);
  await confirm(server, await open(server, panel));
  await verify();
  await notice(scenario.message);
  await settled(server);
  const first = assertPost(server, IDS, 1, 1);
  expect(dialogs(), 'the confirmation dialog stays').toHaveLength(1);
  expect(ticked(panel)).toHaveLength(2);
  await submitAgain(server, dialogs()[0]!);
  const second = assertPost(server, IDS, 2, verifications(server).length);
  expect(second.body).toEqual(first.body);
  expect(onceHeader(second), 'the same key for the unchanged batch').toBe(onceHeader(first));
  await assertResults(NUMBERS, [PAYING_TEXT, LEFT_TEXT.member_blocked]);
  expect(ticked(panel)).toEqual([]);
  cleanup();
}

it(
  '[AC-F1-08bb-REPLAY#1] 网络错误后保留对话框与勾选，手动再点【确认执行】重提同批：请求体相同、沿用原 Idempotency-Key，返回 executed 后逐单显示结果并清空已选',
  { timeout: FLOW_TIMEOUT },
  async () => {
    await assertReplay({
      reply: () => {
        throw new Error('simulated network disconnect');
      },
      message: NOTICE.network,
    });
  },
);

it(
  '[AC-F1-08bb-REPLAY#2] 40901（同键仍在处理）与 5xx 后手动重提同批：请求体相同、沿用原 Idempotency-Key',
  { timeout: MULTI_TIMEOUT },
  async () => {
    await assertReplay({ reply: () => failed(40901), message: NOTICE.failed });
    await assertReplay({ reply: () => failed(50001), message: NOTICE.failed });
  },
);

it(
  '[AC-F1-08bb-REPLAY#3] 网络错误后改了勾选（取消 C）再提交是新操作：请求体只有 A、Idempotency-Key 换新',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    server.onceWhere(postOf(BATCHES), () => {
      throw new Error('simulated network disconnect');
    });
    answerWith(server, executed([QID.approvedA], []));
    const panel = await openQueue(server);
    await select(panel, NUMBERS);
    await confirm(server, await open(server, panel));
    await verify();
    await notice(NOTICE.network);
    await settled(server);
    const first = assertPost(server, IDS, 1, 1);
    await dismiss();
    await click(checkbox(panel, CNO));
    expect(checkbox(panel, CNO).checked).toBe(false);
    await submitAgain(server, await open(server, panel));
    const second = assertPost(server, [QID.approvedA], 2, verifications(server).length);
    expect(onceHeader(second), 'a new key for changed ticks').not.toBe(onceHeader(first));
    await assertResults([QNO.approvedA], [PAYING_TEXT]);
  },
);

it(
  '[AC-F1-08bb-REPLAY#4] 同页 executed 一批 A 之后再勾 C 执行是新一批：两次 Idempotency-Key 均非空且不同，请求体各自只含本批',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    answerWith(server, executed([QID.approvedA], []));
    answerWith(server, executed([CID], []));
    const panel = await openQueue(server);
    await select(panel, [QNO.approvedA]);
    await confirm(server, await open(server, panel));
    await verify();
    await waitFor(() => expect(posts(server)).toHaveLength(1));
    await settled(server);
    const first = assertPost(server, [QID.approvedA], 1, 1);
    await assertResults([QNO.approvedA], [PAYING_TEXT]);
    await waitFor(() => expect(ticked(panel)).toEqual([]));
    await dismiss();
    await select(panel, [CNO]);
    await submitAgain(server, await open(server, panel));
    const second = assertPost(server, [CID], 2, verifications(server).length);
    expect(onceHeader(second), 'a new key for a new batch').not.toBe(onceHeader(first));
  },
);
