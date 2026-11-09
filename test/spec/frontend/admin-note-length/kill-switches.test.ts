// @vitest-environment jsdom
// F1-08ed: 紧急开关确认弹窗的操作说明（选填，≤ 200 字）按 Unicode 码点计，与
// /admin/v1/kill-switches/{key} 写入的服务端（契约 AdminConfigReason maxLength，Ajv 按码点）一致。
// 弹窗交出的是输入的原值（不去首尾空白），服务端按原值计，所以样本前后不带空白。
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { ConfirmModal } from '../../../../apps/admin/src/pages/kill-switches/ConfirmModal.tsx';
import { verbOf, type SwitchRow } from '../../../../apps/admin/src/pages/kill-switches/model.ts';
import { killSwitchesTexts } from '../../../../apps/admin/src/texts/kill-switches.ts';
import {
  buttonNamed,
  counters,
  expectAccepted,
  flagged,
  isDisabled,
  noteField,
  press,
  type,
} from './dom.ts';
import { fits, LIMIT, over } from './support.ts';

type Confirm = (reason: string) => void;

const ROW: SwitchRow = {
  key: 'convert.enabled.taobao',
  value: null,
  default: true,
  value_type: 'boolean',
  options: null,
  permissions: ['config.kill_switch'],
  admin_editable: true,
  version: 0,
  updated_by: null,
  updated_at: null,
};

function renderConfirm(onConfirm: Confirm): void {
  render(
    createElement(ConfirmModal, {
      row: ROW,
      next: false,
      onNext: () => undefined,
      onCancel: () => undefined,
      onConfirm,
    }),
  );
}

function submitButton(): HTMLButtonElement {
  return buttonNamed(killSwitchesTexts.submit(verbOf(ROW, false)));
}

it(
  '[AC-F1-08ed-KILL#1] 紧急开关操作说明 199 个汉字 + 1 个「𠮷」（200 码点）：不截断、页面显示的字数为 200、不报超长，【验证并…】交出这段原值；201 码点：字数显示 201 并报超长（或不能提交）',
  { timeout: 60_000 },
  async () => {
    const accepted = vi.fn<Confirm>();
    renderConfirm(accepted);
    const reason = fits('停');
    await type(noteField(), reason);
    expectAccepted(noteField(), reason, true);
    await press(submitButton());
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledWith(reason);
    expect(flagged(noteField()), 'no error after confirming').toBe(false);
    cleanup();

    const refused = vi.fn<Confirm>();
    renderConfirm(refused);
    await type(noteField(), over('停'));
    const shown = counters(noteField());
    expect(shown.length, 'the field shows its character count').toBeGreaterThan(0);
    for (const text of shown)
      expect(text, 'the counter counts code points').toMatch(
        new RegExp(`^${LIMIT + 1}(?:/${LIMIT})?$`),
      );
    expect(
      flagged(noteField()) || isDisabled(submitButton()),
      'a 201-code-point note is marked as too long or cannot be confirmed',
    ).toBe(true);
  },
);
