// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { OFF_NOTE } from '../admin-payout-execute/fixtures.ts';
import { checkbox, select } from '../admin-payout-execute/helpers.ts';
import { QNO } from '../admin-payouts-readonly/fixtures.ts';
import { listed } from '../admin-payouts-readonly/helpers.ts';
import {
  CANCEL,
  ENTRY,
  PAUSE,
  QUEUE,
  RESUME,
  VERSION,
  accountOf,
  overview,
  pausedOverview,
  resumeChannel,
  type Grants,
  type SwitchUpdate,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  assertPut,
  button,
  buttons,
  channelCard,
  click,
  closed,
  confirm,
  disabled,
  holdPut,
  latestPass,
  notice,
  openAction,
  openPanel,
  pauseNames,
  pausedShown,
  pressables,
  puts,
  queueShown,
  reasonInput,
  rereadAfter,
  serverFor,
  settled,
  step,
  stepDialogs,
  submit,
  switchDialogs,
  tryAgain,
  typeReason,
  verifications,
  verify,
  versionOf,
} from './helpers.ts';

// F1-08bd ②: confirm → StepUpModal (totp) → exactly one PUT /admin/v1/kill-switches/{key} with the
// whole contract body (value, expected_version from the version adminListKillSwitches answered for
// that switch — 0 for a switch never written — and reason only when one was typed), X-Step-Up-Token
// and no Idempotency-Key. Double clicks and clicks in flight send nothing more; in flight the dialog
// stays and its confirm button is disabled. On success the dialog closes, a notice says so, the
// overview is read again and the entries follow it: lifting the queue leaves the channel pauses (and
// lifting a channel leaves the queue pause and the other channels) as they are. Cancelling the
// dynamic code sends nothing and keeps the dialog; closing it returns the focus to its entry.

/** The entry of F1-08bb, offered only while the queue runs. */
const EXECUTE = '执行所选';
/** The rows of 打款队列 「全部」 (the frozen queue samples). */
const ROWS = [QNO.approvedA, QNO.paying, QNO.approvedB, QNO.stuck, QNO.untried];
const QUEUE_PAUSED = '已暂停';
const QUEUE_RUNNING = '运行中';
const CHANNEL_PAUSED = '已暂停';
const CHANNEL_RUNNING = '未暂停';

it(
  '[AC-F1-08bd-SUBMIT#1] 【解除暂停】：连点确认与【验证并继续】、在途时再点都只发一次 PUT /admin/v1/kill-switches/payout.queue_paused（整个请求体 value=false、expected_version=7（开关列表里该开关的 version）、reason；带 X-Step-Up-Token，不带 Idempotency-Key）；在途时对话框保留、确认按钮禁用；成功后关闭、提示「打款队列已解除暂停」、重新读概览，标题行换成【暂停队列】，两个通道暂停不随之解除',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor({ overview: pausedOverview() });
    const release = holdPut(server);
    const panel = await openPanel(server);
    const { modal, mark } = await openAction(server, panel, RESUME);
    const reason = '财务已充值，恢复出款';
    const body: SwitchUpdate = { value: false, expected_version: VERSION.queue, reason };
    const confirmButton = button(modal, RESUME.submit);
    try {
      await typeReason(modal, reason);
      await confirm(server, modal, RESUME, true);
      await verify(true);
      await waitFor(() => expect(puts(server)).toHaveLength(1));
      expect(disabled(confirmButton), `${RESUME.submit} disabled in flight`).toBe(true);
      expect(switchDialogs(), 'the dialog stays in flight').toEqual([modal]);
      await click(confirmButton, true);
      assertPut(server, RESUME, body, 1, 1, mark);
      expect(verifications(server)).toHaveLength(1);
    } finally {
      release();
    }
    await settled(server);
    await closed();
    await notice(RESUME.done);
    const sent = assertPut(server, RESUME, body, 1, 1, mark);
    expect(verifications(server)).toHaveLength(1);
    expect(server.writes(), 'one verification and one PUT').toHaveLength(2);
    await rereadAfter(server, sent);
    const after = [ENTRY.pause, ENTRY.channel, ENTRY.channel].sort();
    await waitFor(() => expect(pauseNames(), 'after lifting the queue').toEqual(after));
    expect(queueShown(panel)).toEqual([QUEUE_RUNNING]);
    expect(pausedShown(panel, 'alipay')).toEqual([CHANNEL_PAUSED]);
    expect(pausedShown(panel, 'wechat')).toEqual([CHANNEL_PAUSED]);
  },
);

it(
  '[AC-F1-08bd-SUBMIT#2] 【暂停队列】（开关从未写过，version 为 0）：不填原因时请求体恰为 value=true、expected_version=0（不带 reason）；成功后提示「打款队列已暂停」，标题行换成【解除暂停】；已勾选待执行单时【执行所选】随之不再提供、批量栏写明队列已暂停',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const grants: Grants = ['fund.view', 'payout.execute', 'switch.payout'];
    const server = serverFor({
      overview: overview(),
      permissions: grants,
      versions: { [QUEUE]: 0 },
    });
    const panel = await openPanel(server, accountOf(grants));
    await listed(panel, ROWS);
    await select(panel, [QNO.approvedA]);
    expect(buttons(panel, EXECUTE), 'offered before the pause').toHaveLength(1);
    const { modal, mark } = await openAction(server, panel, PAUSE);
    await submit(server, modal, PAUSE);
    const sent = assertPut(server, PAUSE, { value: true, expected_version: 0 }, 1, 1, mark);
    await closed();
    await notice(PAUSE.done);
    await rereadAfter(server, sent);
    const after = [ENTRY.resume, ENTRY.channel].sort();
    await waitFor(() => expect(pauseNames(), 'the entries after pausing').toEqual(after));
    expect(queueShown(panel)).toEqual([QUEUE_PAUSED]);
    expect(versionOf(server, QUEUE), 'one change on the server').toBe(1);
    await waitFor(() => expect(buttons(panel, EXECUTE), 'none once paused').toEqual([]));
    // The page may have read the queue again (dropping the tick): tick the row again then.
    await listed(panel, ROWS);
    if (!checkbox(panel, QNO.approvedA).checked) await select(panel, [QNO.approvedA]);
    await waitFor(() =>
      expect(within(panel).queryAllByText(OFF_NOTE.queue, { exact: true })).toHaveLength(1),
    );
    expect(buttons(panel, EXECUTE), 'still none with a tick').toEqual([]);
  },
);

it(
  '[AC-F1-08bd-SUBMIT#3] 【解除通道暂停】分通道、与队列分开：微信零钱卡上的入口发 PUT payout.channel_paused.wechat（value=false、expected_version=5、reason），成功后微信零钱卡显示未暂停且没有入口，企业支付宝卡的入口与【解除暂停】仍在；再解除企业支付宝（不填原因）发 PUT payout.channel_paused.alipay（value=false、expected_version=3），之后只剩【解除暂停】',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor({ overview: pausedOverview() });
    const panel = await openPanel(server);
    const wechat = resumeChannel('wechat');
    const first = await openAction(server, panel, wechat);
    const reason = '微信商户号额度已恢复';
    await typeReason(first.modal, reason);
    await submit(server, first.modal, wechat);
    const wechatBody: SwitchUpdate = { value: false, expected_version: VERSION.wechat, reason };
    const one = assertPut(server, wechat, wechatBody, 1, 1, first.mark);
    await closed();
    await notice(wechat.done);
    await rereadAfter(server, one);
    await waitFor(() => expect(pressables(channelCard(panel, 'wechat'))).toEqual([]));
    expect(pausedShown(panel, 'wechat')).toEqual([CHANNEL_RUNNING]);
    expect(pressables(channelCard(panel, 'alipay'))).toEqual([ENTRY.channel]);
    expect(pauseNames(), 'the queue pause stays').toEqual([ENTRY.resume, ENTRY.channel].sort());
    expect(queueShown(panel)).toEqual([QUEUE_PAUSED]);

    const alipay = resumeChannel('alipay');
    await tryAgain(server, panel, alipay);
    const alipayBody: SwitchUpdate = { value: false, expected_version: VERSION.alipay };
    const since = server.log.indexOf(one) + 1;
    const two = assertPut(server, alipay, alipayBody, 2, latestPass(server), since);
    await closed();
    await notice(alipay.done);
    await rereadAfter(server, two);
    await waitFor(() => expect(pauseNames(), 'only the queue pause').toEqual([ENTRY.resume]));
    expect(pausedShown(panel, 'alipay')).toEqual([CHANNEL_RUNNING]);
    expect(queueShown(panel)).toEqual([QUEUE_PAUSED]);
  },
);

it(
  '[AC-F1-08bd-SUBMIT#4] 取消动态码不提交、对话框保留且原因不丢；【取消】关闭对话框后焦点回到【解除暂停】，全程不发写请求、入口不变',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor({ overview: pausedOverview() });
    const panel = await openPanel(server);
    const { modal, trigger } = await openAction(server, panel, RESUME);
    await typeReason(modal, '先核对余额');
    await confirm(server, modal, RESUME);
    await click(button(await step(), CANCEL));
    await waitFor(() => expect(stepDialogs()).toEqual([]));
    await settled(server);
    expect(puts(server), 'no PUT').toEqual([]);
    expect(verifications(server), 'no verification').toEqual([]);
    expect(switchDialogs(), 'the dialog stays').toEqual([modal]);
    expect(reasonInput(modal).value, 'the reason stays').toBe('先核对余额');
    await click(button(modal, CANCEL));
    await closed();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(server.writes()).toEqual([]);
    expect(pauseNames()).toEqual([ENTRY.resume, ENTRY.channel, ENTRY.channel].sort());
  },
);
