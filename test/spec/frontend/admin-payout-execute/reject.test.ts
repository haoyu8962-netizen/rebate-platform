// @vitest-environment jsdom
import { cleanup, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  CID,
  CNO,
  ENTRY,
  PAYING_TEXT,
  QID,
  QNO,
  alipayOverview,
  executeSamples,
  executed,
  netSum,
  refused,
  refusedText,
  selectedText,
  type PayoutChannel,
  type RefusedReason,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  answerWith,
  assertPost,
  assertResults,
  batchLabels,
  button,
  checkbox,
  confirm,
  dismiss,
  liveTexts,
  notice,
  onceHeader,
  open,
  openQueue,
  posts,
  select,
  serverFor,
  settled,
  submitAgain,
  verifications,
  verify,
} from './helpers.ts';

// F1-08bb ④ rejected: the whole batch was refused (payout_disabled, queue_paused, or a watermark
// reason of the failing `channel`): its reason is shown, nothing reads as paid and no batch is shown;
// the ticks stay. ⑤ After fixing what refused it, a new submit is a new operation: it carries a new
// Idempotency-Key (contract: "After fixing what refused a batch … submit with a new key").

const sample = executeSamples();
const A = sample.find((row) => row.withdrawal_id === QID.approvedA)!;
const C = sample.find((row) => row.withdrawal_id === CID)!;

it(
  '[AC-F1-08bb-REJECT#1] rejected（watermark_stale，channel=alipay）：显示整批未执行与企业支付宝 W 过期的原因，不显示已发起打款与批次号，勾选保留；关掉后再点【执行所选】提交是新操作：请求体相同、Idempotency-Key 换新，executed 后逐单显示已发起打款',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor({ overview: alipayOverview({ watermark: null, water_level: null }) });
    answerWith(server, refused('watermark_stale', 'alipay'));
    answerWith(server, executed([QID.approvedA, CID], []));
    const panel = await openQueue(server);
    await select(panel, [QNO.approvedA, CNO]);
    await confirm(server, await open(server, panel));
    await verify();
    await notice(refusedText('watermark_stale', 'alipay'));
    await settled(server);
    const first = assertPost(server, [QID.approvedA, CID], 1, 1);
    expect(within(document.body).queryAllByText(PAYING_TEXT, { exact: true })).toEqual([]);
    expect(batchLabels(), 'no batch on a refused batch').toEqual([]);
    expect(checkbox(panel, QNO.approvedA).checked).toBe(true);
    expect(checkbox(panel, CNO).checked).toBe(true);
    expect(verifications(server)).toHaveLength(1);
    expect(posts(server), 'no automatic resubmit').toHaveLength(1);

    await dismiss();
    expect(liveTexts(panel)).toEqual([selectedText(2, netSum([A, C]))]);
    expect(button(panel, ENTRY)).toBeDefined();
    await submitAgain(server, await open(server, panel));
    const second = assertPost(server, [QID.approvedA, CID], 2, verifications(server).length);
    expect(second.body).toEqual(first.body);
    expect(onceHeader(second), 'a new key after a refused batch').not.toBe(onceHeader(first));
    await assertResults([QNO.approvedA, CNO], [PAYING_TEXT, PAYING_TEXT]);
  },
);

interface Refusal {
  readonly reason: RefusedReason;
  readonly channel: PayoutChannel | null;
  /** The ticked rows (list order). */
  readonly numbers: readonly string[];
  readonly ids: readonly string[];
}

async function assertRefusal(scenario: Refusal): Promise<void> {
  const server = serverFor();
  answerWith(server, refused(scenario.reason, scenario.channel));
  const panel = await openQueue(server);
  await select(panel, [...scenario.numbers].reverse());
  await confirm(server, await open(server, panel));
  await verify();
  await notice(refusedText(scenario.reason, scenario.channel));
  await settled(server);
  assertPost(server, scenario.ids, 1, 1);
  expect(within(document.body).queryAllByText(PAYING_TEXT, { exact: true })).toEqual([]);
  expect(batchLabels(), `${scenario.reason}: no batch`).toEqual([]);
  for (const number of scenario.numbers)
    expect(checkbox(panel, number).checked, `${number} stays ticked`).toBe(true);
  expect(verifications(server)).toHaveLength(1);
  expect(posts(server)).toHaveLength(1);
  cleanup();
}

it(
  '[AC-F1-08bb-REJECT#2] rejected 的开关类原因：payout_disabled 显示「整批未执行：打款开关已关闭」、queue_paused 显示「整批未执行：打款队列已暂停」；均不显示成功与批次号、勾选保留、不自动重发',
  { timeout: MULTI_TIMEOUT },
  async () => {
    await assertRefusal({
      reason: 'payout_disabled',
      channel: null,
      numbers: [QNO.approvedA],
      ids: [QID.approvedA],
    });
    await assertRefusal({
      reason: 'queue_paused',
      channel: null,
      numbers: [QNO.approvedA, CNO],
      ids: [QID.approvedA, CID],
    });
  },
);

it(
  '[AC-F1-08bb-REJECT#3] rejected 的水位类原因带通道名：watermark_below_forecast + bank_card →「银行卡余额 W 低于预计提现 P」，watermark_usable_exceeded + alipay →「企业支付宝在途与本批合计超过可用余额（W × 可用比例），请拆分批次」；均不显示成功与批次号、勾选保留',
  { timeout: MULTI_TIMEOUT },
  async () => {
    await assertRefusal({
      reason: 'watermark_below_forecast',
      channel: 'bank_card',
      numbers: [QNO.approvedB],
      ids: [QID.approvedB],
    });
    await assertRefusal({
      reason: 'watermark_usable_exceeded',
      channel: 'alipay',
      numbers: [QNO.approvedA, CNO],
      ids: [QID.approvedA, CID],
    });
  },
);
