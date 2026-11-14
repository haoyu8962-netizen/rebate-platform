// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  CANCEL,
  PAUSE,
  REASON_200,
  REASON_201,
  RESUME,
  VERSION,
  overview,
  pausedOverview,
  resumeChannel,
  type Action,
  type Overview,
  type SwitchUpdate,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  assertPut,
  button,
  buttons,
  click,
  closed,
  disabled,
  isShown,
  openAction,
  openPanel,
  paragraphs,
  puts,
  reasonInput,
  serverFor,
  settle,
  settled,
  squash,
  stepDialogs,
  submit,
  switchDialogs,
  titleOf,
  typeReason,
} from './helpers.ts';

// F1-08bd ②: each entry opens a confirmation dialog first (no step-up, nothing written yet): its
// title, the consequence of the change (pausing makes 【执行所选】 unavailable; lifting the queue
// or a channel still leaves every execution to the water-level check, and the two pauses are
// lifted separately, BR-WDR-17 / BR-WDR-33 ①), an optional reason (at most 200 characters,
// counted in Unicode code points as the contract's AdminConfigReason does, F1-08ed), the confirm
// button and 【取消】. 【取消】 writes nothing and the focus returns to the entry. A reason over the
// limit opens no StepUpModal and sends nothing; exactly 200 code points are sent as typed.

interface Shown {
  readonly view: Overview;
  readonly action: Action;
}

it(
  '[AC-F1-08bd-DIALOG#1] 【暂停队列】【解除暂停】【解除通道暂停】（企业支付宝、微信零钱）各自打开确认对话框：标题与后果说明逐字如约（暂停后【执行所选】不可用；解除后执行仍过水位检查、队列与通道分开解除），有一个原因输入框、确认按钮与【取消】；打开时不弹动态码、不发写请求；【取消】关闭、不发请求，焦点回到入口',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const scenarios: readonly Shown[] = [
      { view: overview(), action: PAUSE },
      { view: pausedOverview(), action: RESUME },
      { view: pausedOverview(), action: resumeChannel('wechat') },
      { view: pausedOverview(), action: resumeChannel('alipay') },
    ];
    for (const { view, action } of scenarios) {
      const server = serverFor({ overview: view });
      const panel = await openPanel(server);
      const { modal, trigger } = await openAction(server, panel, action);
      expect(titleOf(modal), `${action.entry}: the title`).toBe(squash(action.title));
      const consequence = paragraphs(modal, action.text);
      expect(consequence, `${action.entry}: the consequence`).toEqual([squash(action.text)]);
      expect(reasonInput(modal).value, 'the reason starts empty').toBe('');
      expect(disabled(button(modal, action.submit)), `${action.submit} usable`).toBe(false);
      const cancel = buttons(modal, CANCEL).filter((node) => isShown(node) && !disabled(node));
      expect(cancel, `one usable ${CANCEL}`).toHaveLength(1);
      await settled(server);
      expect(server.writes(), 'nothing written on opening').toEqual([]);
      await click(cancel[0]!);
      await closed();
      await waitFor(() => expect(document.activeElement, 'the focus is back').toBe(trigger));
      await settled(server);
      expect(server.writes(), 'nothing written after cancelling').toEqual([]);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08bd-DIALOG#2] 原因按 Unicode 码点计：201 码点时点确认不弹动态码、不发请求，对话框与已填保留；改成 199 个汉字 + 1 个「𠮷」（200 码点）后确认 → 动态码 → 请求体 reason 恰为所填原值',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor({ overview: pausedOverview() });
    const panel = await openPanel(server);
    const { modal, mark } = await openAction(server, panel, RESUME);
    await typeReason(modal, REASON_201);
    const confirmButton = button(modal, RESUME.submit);
    if (!disabled(confirmButton)) await click(confirmButton);
    await settle();
    expect(stepDialogs(), 'no step-up for a reason over 200 code points').toEqual([]);
    expect(puts(server), 'nothing sent for a reason over 200 code points').toEqual([]);
    expect(switchDialogs(), 'the dialog stays').toEqual([modal]);
    expect(reasonInput(modal).value, 'what was typed stays').toBe(REASON_201);

    await typeReason(modal, REASON_200);
    await submit(server, modal, RESUME);
    const body: SwitchUpdate = {
      value: false,
      expected_version: VERSION.queue,
      reason: REASON_200,
    };
    assertPut(server, RESUME, body, 1, 1, mark);
    await closed();
  },
);
