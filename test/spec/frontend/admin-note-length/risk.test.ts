// @vitest-environment jsdom
// F1-08ed: 风控规则启停确认弹窗的原因（选填，≤ 200 字）按 Unicode 码点计，与
// POST /admin/v1/risk-rules/{rule_id}/enable | …/disable 的服务端（admin-risk-rules.ts codePoints）
// 一致。请求体带的是输入的原值（不去首尾空白），服务端按原值计，所以样本前后不带空白。
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { ConfirmModal } from '../../../../apps/admin/src/pages/risk/ConfirmModal.tsx';
import type { RiskRule } from '../../../../apps/admin/src/pages/risk/model.ts';
import { riskTexts } from '../../../../apps/admin/src/texts/risk.ts';
import {
  buttonNamed,
  counters,
  expectAccepted,
  flagged,
  noteField,
  press,
  settle,
  type,
  waitFlagged,
} from './dom.ts';
import { fits, LIMIT, over } from './support.ts';

type Confirm = (reason: string) => void;

const RULE: RiskRule = {
  rule_id: 'DEVICE_REGISTER_LIMIT',
  scene: 'register',
  name: '同设备注册上限',
  risk_action: 'block',
  status: 'disabled',
  threshold_keys: [],
  version: 3,
  updated_at: '2026-11-09T10:00:00+08:00',
};

function renderConfirm(onConfirm: Confirm): void {
  render(
    createElement(ConfirmModal, {
      rule: RULE,
      change: 'enable',
      reason: '',
      onCancel: () => undefined,
      onConfirm,
    }),
  );
}

function submitButton(): HTMLButtonElement {
  return buttonNamed(riskTexts.rules.confirm.submit(riskTexts.rules.enable));
}

it(
  '[AC-F1-08ed-RISK#1] 风控规则启用原因 199 个汉字 + 1 个「𠮷」（200 码点）：不截断、页面显示的字数为 200、不报超长，【确认启用】交出这段原值；201 码点：字数显示 201，确认时在原因旁报超长、不往下走',
  { timeout: 60_000 },
  async () => {
    const accepted = vi.fn<Confirm>();
    renderConfirm(accepted);
    const reason = fits('风');
    await type(noteField(), reason);
    expectAccepted(noteField(), reason, true);
    await press(submitButton());
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledWith(reason);
    expect(flagged(noteField()), 'no error after confirming').toBe(false);
    cleanup();

    const refused = vi.fn<Confirm>();
    renderConfirm(refused);
    await type(noteField(), over('风'));
    const shown = counters(noteField());
    expect(shown.length, 'the field shows its character count').toBeGreaterThan(0);
    for (const text of shown)
      expect(text, 'the counter counts code points').toMatch(
        new RegExp(`^${LIMIT + 1}(?:/${LIMIT})?$`),
      );
    await press(submitButton());
    await waitFlagged(noteField);
    await settle();
    expect(refused, 'a 201-code-point reason goes no further').not.toHaveBeenCalled();
  },
);
