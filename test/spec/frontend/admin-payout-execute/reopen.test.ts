// @vitest-environment jsdom
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
  postOf,
  type LeftItem,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  answerWith,
  assertPost,
  assertResults,
  checkbox,
  confirm,
  dialogs,
  dismiss,
  notice,
  onceHeader,
  open,
  openQueue,
  select,
  serverFor,
  settled,
  submitAgain,
  ticked,
  verifications,
  verify,
} from './helpers.ts';

// F1-08bb ⑤ (adminCreatePayoutBatch: same key and body → the first result): a network error leaves
// the result unknown, so the same batch submitted again keeps its key even when the confirmation
// dialog was closed in between. Closing the dialog is not a new operation; only changed ticks
// (REPLAY#3), a rejected batch fixed (REJECT) or an executed one (REPLAY#4) take a new key.

const IDS = [QID.approvedA, CID];
const NUMBERS = [QNO.approvedA, CNO];
const BLOCKED: LeftItem = { withdrawal_id: CID, reason: 'member_blocked' };

it(
  '[AC-F1-08bb-REPLAY#5] 网络错误后关闭执行确认对话框、勾选不变，再点【执行所选】并确认（需要时再过动态码）：第二次 POST 的请求体与第一次相同、Idempotency-Key 沿用原键；返回 executed 后逐单显示结果并清空已选',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    server.onceWhere(postOf(BATCHES), () => {
      throw new Error('simulated network disconnect');
    });
    answerWith(server, executed([QID.approvedA], [BLOCKED]));
    const panel = await openQueue(server);
    await select(panel, NUMBERS);
    await confirm(server, await open(server, panel));
    await verify();
    await notice(NOTICE.network);
    await settled(server);
    const first = assertPost(server, IDS, 1, 1);
    await dismiss();
    expect(dialogs()).toEqual([]);
    expect(ticked(panel), 'ticks kept after closing').toHaveLength(2);
    expect(checkbox(panel, QNO.approvedA).checked).toBe(true);
    expect(checkbox(panel, CNO).checked).toBe(true);
    await submitAgain(server, await open(server, panel));
    const second = assertPost(server, IDS, 2, verifications(server).length);
    expect(second.body, 'the same body').toEqual(first.body);
    expect(onceHeader(second), 'the same key after closing and reopening').toBe(onceHeader(first));
    await assertResults(NUMBERS, [PAYING_TEXT, LEFT_TEXT.member_blocked]);
    expect(ticked(panel)).toEqual([]);
  },
);
