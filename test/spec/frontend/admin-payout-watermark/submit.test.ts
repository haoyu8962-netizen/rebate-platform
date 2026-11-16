// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  CANCEL,
  CHANNEL_NAME,
  ENTRY,
  NOTICE,
  SUBMIT,
  yuan,
  type WatermarkRequest,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  alipayCard,
  answerWith,
  assertPost,
  button,
  click,
  closed,
  confirm,
  current,
  disabled,
  entryDialogs,
  entryOf,
  fillIn,
  holdWith,
  latestPass,
  notice,
  onceHeader,
  openEntry,
  openPanel,
  overviewReads,
  posts,
  serverFor,
  settled,
  step,
  stepDialogs,
  submitAgain,
  typed,
  verifications,
  verify,
} from './helpers.ts';

// F1-08bc ③: 【确认录入】 → StepUpModal (totp) → exactly one POST /admin/v1/payout-watermarks with
// the whole contract body (channel, available_fen in integer fen, measured_at with +08:00, note only
// when filled), X-Step-Up-Token and Idempotency-Key. Double clicks and clicks while it is in flight
// send nothing more; in flight the dialog stays and 【确认录入】 is disabled. On success the dialog
// closes, a notice says so and the overview is read again (the card shows the new W). Entering again
// afterwards is a new request with a new Idempotency-Key. Cancelling the dynamic code sends
// nothing and keeps the dialog; after closing the dialog the focus returns to its entry.

it(
  '[AC-F1-08bc-SUBMIT#1] 企业支付宝：连点【确认录入】与【验证并继续】、在途时再点都只发一次 POST /admin/v1/payout-watermarks（整个请求体 channel=alipay、available_fen=3456789、measured_at=2026-11-14T09:50:00+08:00、note，带 X-Step-Up-Token 与 Idempotency-Key）；在途时对话框保留、【确认录入】禁用；成功后关闭、提示「余额已录入」、重新读概览并显示新 W',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const release = holdWith(server);
    const panel = await openPanel(server);
    const reads = overviewReads(server).length;
    const modal = await openEntry(server, ENTRY.alipay);
    const body: WatermarkRequest = {
      channel: 'alipay',
      available_fen: 3456789,
      measured_at: '2026-11-14T09:50:00+08:00',
      note: '网银余额截图 09:50',
    };
    const submit = button(modal, SUBMIT);
    try {
      await fillIn(modal, {
        available: '34567.89',
        measuredAt: '2026-11-14 09:50:00',
        note: '网银余额截图 09:50',
      });
      await confirm(server, modal, true);
      await verify(true);
      await waitFor(() => expect(posts(server)).toHaveLength(1));
      expect(disabled(submit), `${SUBMIT} disabled in flight`).toBe(true);
      expect(entryDialogs(), 'the dialog stays in flight').toEqual([modal]);
      await click(submit, true);
      assertPost(server, body, 1, 1);
      expect(verifications(server)).toHaveLength(1);
      expect(server.pending).toBe(1);
    } finally {
      release();
    }
    await settled(server);
    await closed();
    await notice(NOTICE.done);
    assertPost(server, body, 1, 1);
    expect(verifications(server)).toHaveLength(1);
    expect(server.writes(), 'one verification and one entry').toHaveLength(2);
    await waitFor(() => expect(overviewReads(server).length).toBeGreaterThan(reads));
    const sent = server.log.indexOf(posts(server)[0]!);
    const reread = server.log.indexOf(overviewReads(server).at(-1)!);
    expect(reread, 'the overview read after the entry').toBeGreaterThan(sent);
    await settled(server);
    await waitFor(() =>
      expect(alipayCard(panel), 'the new W').toEqual([yuan(3456789), '2026-11-1409:50:00']),
    );
  },
);

it(
  '[AC-F1-08bc-SUBMIT#2] 微信运营账户：不填备注时请求体只有 channel=wechat、available_fen、measured_at（不带 note）；成功后再打开对话框显示新 W，再录入一次是新请求、换新的 Idempotency-Key',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    answerWith(server);
    answerWith(server);
    await openPanel(server);
    const first = await openEntry(server, ENTRY.wechat);
    await fillIn(first, { available: '0', measuredAt: '2026-11-15 00:10:00', note: '' });
    await confirm(server, first);
    await verify();
    await waitFor(() => expect(posts(server)).toHaveLength(1));
    await settled(server);
    const before: WatermarkRequest = {
      channel: 'wechat',
      available_fen: 0,
      measured_at: '2026-11-15T00:10:00+08:00',
    };
    const one = assertPost(server, before, 1, 1);
    await closed();
    await notice(NOTICE.done);
    await settled(server);

    const second = await openEntry(server, ENTRY.wechat);
    const fresh = [CHANNEL_NAME.wechat, yuan(0), '2026-11-1500:10:00'];
    await waitFor(() => expect(current(second), 'the new W').toEqual(fresh));
    await fillIn(second, { available: '1234567.8', measuredAt: '2026-11-15 00:20:00', note: '' });
    await submitAgain(server, second);
    const after: WatermarkRequest = {
      channel: 'wechat',
      available_fen: 123456780,
      measured_at: '2026-11-15T00:20:00+08:00',
    };
    const two = assertPost(server, after, 2, latestPass(server));
    expect(onceHeader(two), 'a new key for a new entry').not.toBe(onceHeader(one));
    await closed();
  },
);

it(
  '[AC-F1-08bc-SUBMIT#3] 取消动态码不提交、对话框保留且已填不丢；关闭对话框后焦点回到触发它的入口（微信通道卡上的【录入运营账户余额】）',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    await openPanel(server);
    const entry = entryOf(ENTRY.wechat);
    const modal = await openEntry(server, ENTRY.wechat);
    const form = { available: '88.80', measuredAt: '2026-11-14 09:55:00', note: '运营账户截图' };
    await fillIn(modal, form);
    await confirm(server, modal);
    await click(button(await step(), CANCEL));
    await waitFor(() => expect(stepDialogs()).toEqual([]));
    expect(server.writes(), 'nothing sent').toEqual([]);
    expect(entryDialogs(), 'the dialog stays').toEqual([modal]);
    expect(typed(modal), 'what was typed stays').toEqual(form);
    await click(button(modal, CANCEL));
    await closed();
    await waitFor(() => expect(document.activeElement).toBe(entry));
    expect(server.writes()).toEqual([]);
  },
);
