// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { PayoutServer } from '../admin-payouts-readonly/fixtures.ts';
import {
  CID,
  CNO,
  ENTRY,
  EXECUTOR,
  LEFT_TEXT,
  NEW_BATCH,
  PAYING_TEXT,
  QID,
  QNO,
  allRows,
  executeSamples,
  executed,
  fillerId,
  fillerNo,
  type LeftReason,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  answerWith,
  assertPost,
  assertResults,
  at,
  batchShown,
  buttons,
  choicesOf,
  confirm,
  liveTexts,
  open,
  openQueue,
  posts,
  queueRow,
  select,
  serverFor,
  settled,
  squash,
  ticked,
  verify,
} from './helpers.ts';

// F1-08bb ④ executed: the answer's new batch (batch_id) is shown, each ticked withdrawal gets one
// row with its result — paying → 已发起打款, left → the text of its reason — in list order. Then the
// ticks are cleared and the queue and the overview are read again (after the POST). With `paying`
// empty (every channel refused by its watermark) the outcome is still executed: no 已发起打款.

/** Waits until both the queue and the overview were read again after the batch POST. */
async function refreshedAfterPost(
  server: PayoutServer,
  queue: number,
  view: number,
): Promise<void> {
  await waitFor(() => expect(server.overviewReads().length).toBeGreaterThan(view));
  await waitFor(() => expect(server.queueReads().length).toBeGreaterThan(queue));
  await settled(server);
  const post = at(server, posts(server).at(-1)!);
  const overviewRead = at(server, server.overviewReads().at(-1)!);
  const queueRead = at(server, server.queueReads().at(-1)!);
  expect(overviewRead, 'overview read after the POST').toBeGreaterThan(post);
  expect(queueRead, 'queue read after the POST').toBeGreaterThan(post);
}

it(
  '[AC-F1-08bb-RESULT#1] executed 混合：显示新批次号；A 已发起打款，C 已不是待执行、B 通道未开通、F1 会员阻断、F2 已有转账记录各显示对应提示，按列表顺序一单一行；完成后清空已选、批量栏消失，并在 POST 之后重新读队列与概览（A 变打款中、不可再勾）',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor({ withdrawals: executeSamples(2) });
    answerWith(
      server,
      executed(
        [QID.approvedA],
        [
          { withdrawal_id: CID, reason: 'not_approved' },
          { withdrawal_id: QID.approvedB, reason: 'channel_disabled' },
          { withdrawal_id: fillerId(1), reason: 'member_blocked' },
          { withdrawal_id: fillerId(2), reason: 'has_transfer_attempt' },
        ],
      ),
    );
    const panel = await openQueue(server, EXECUTOR, allRows(2));
    const order = [QNO.approvedA, CNO, QNO.approvedB, fillerNo(1), fillerNo(2)];
    await select(panel, [...order].reverse());
    const queue = server.queueReads().length;
    const view = server.overviewReads().length;
    await confirm(server, await open(server, panel));
    await verify();
    await waitFor(() => expect(posts(server)).toHaveLength(1));
    await refreshedAfterPost(server, queue, view);
    assertPost(server, [QID.approvedA, CID, QID.approvedB, fillerId(1), fillerId(2)], 1, 1);
    expect(batchShown().map(squash), 'the new batch').toEqual([NEW_BATCH]);
    await assertResults(order, [
      PAYING_TEXT,
      LEFT_TEXT.not_approved,
      LEFT_TEXT.channel_disabled,
      LEFT_TEXT.member_blocked,
      LEFT_TEXT.has_transfer_attempt,
    ]);
    expect(ticked(panel), 'ticks cleared').toEqual([]);
    expect(liveTexts(panel), 'no selection bar').toEqual([]);
    expect(buttons(panel, ENTRY), 'no 执行所选 without ticks').toEqual([]);
    await waitFor(() => expect(choicesOf(queueRow(panel, QNO.approvedA))).toEqual([]));
  },
);

it(
  '[AC-F1-08bb-RESULT#2] executed 但 paying 为空（多通道各因水位留下）：仍显示新批次号，A 与 B 逐单显示各自的水位原因（低于 P / 超可用额度、W 过期），不出现「已发起打款」；清空已选并重新读队列与概览',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const scenarios: readonly { a: LeftReason; b: LeftReason }[] = [
      { a: 'watermark_below_forecast', b: 'watermark_stale' },
      { a: 'watermark_usable_exceeded', b: 'watermark_stale' },
    ];
    for (const scenario of scenarios) {
      const server = serverFor();
      answerWith(
        server,
        executed(
          [],
          [
            { withdrawal_id: QID.approvedA, reason: scenario.a },
            { withdrawal_id: QID.approvedB, reason: scenario.b },
          ],
        ),
      );
      const panel = await openQueue(server);
      await select(panel, [QNO.approvedB, QNO.approvedA]);
      const queue = server.queueReads().length;
      const view = server.overviewReads().length;
      await confirm(server, await open(server, panel));
      await verify();
      await waitFor(() => expect(posts(server)).toHaveLength(1));
      await refreshedAfterPost(server, queue, view);
      assertPost(server, [QID.approvedA, QID.approvedB], 1, 1);
      expect(batchShown().map(squash)).toEqual([NEW_BATCH]);
      await assertResults(
        [QNO.approvedA, QNO.approvedB],
        [LEFT_TEXT[scenario.a], LEFT_TEXT[scenario.b]],
      );
      expect(within(document.body).queryAllByText(PAYING_TEXT, { exact: true })).toEqual([]);
      expect(ticked(panel)).toEqual([]);
      expect(buttons(panel, ENTRY)).toEqual([]);
      cleanup();
    }
  },
);
