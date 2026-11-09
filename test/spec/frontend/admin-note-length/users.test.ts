// @vitest-environment jsdom
// F1-08ed: 用户详情【查看完整手机号】的原因（必填，1–200 字）按 Unicode 码点计，与
// POST /admin/v1/users/{user_id}/reveal 的服务端（契约 AdminUserReason maxLength，Ajv 按码点）一致。
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { ReasonModal } from '../../../../apps/admin/src/pages/users/ReasonModal.tsx';
import { usersTexts } from '../../../../apps/admin/src/texts/users.ts';
import {
  buttonNamed,
  expectAccepted,
  flagged,
  noteField,
  press,
  settle,
  type,
  waitFlagged,
} from './dom.ts';
import { fits, over } from './support.ts';

type Confirm = (reason: string) => void;

function renderReason(onConfirm: Confirm): void {
  render(
    createElement(ReasonModal, {
      initialReason: '',
      onCancel: () => undefined,
      onConfirm,
    }),
  );
}

it(
  '[AC-F1-08ed-USERS#1] 查看完整手机号的原因 199 个汉字 + 1 个「𠮷」（200 码点）：不截断、字数显示 200、不报错，【验证并查看】交出这段原因；201 码点或空白：在原因旁报错、不往下走',
  { timeout: 60_000 },
  async () => {
    const accepted = vi.fn<Confirm>();
    renderReason(accepted);
    const reason = fits('查');
    await type(noteField(), reason);
    expectAccepted(noteField(), reason, true);
    await press(buttonNamed(usersTexts.reveal.submit));
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted.mock.calls[0]?.[0]?.trim()).toBe(reason);
    expect(flagged(noteField()), 'no error after confirming').toBe(false);
    cleanup();

    const refused = vi.fn<Confirm>();
    renderReason(refused);
    await type(noteField(), over('查'));
    await press(buttonNamed(usersTexts.reveal.submit));
    await waitFlagged(noteField);
    await settle();
    expect(refused, 'a 201-code-point reason goes no further').not.toHaveBeenCalled();
    cleanup();

    const blank = vi.fn<Confirm>();
    renderReason(blank);
    await type(noteField(), '   ');
    await press(buttonNamed(usersTexts.reveal.submit));
    await waitFlagged(noteField);
    await settle();
    expect(blank, 'a blank reason is still refused').not.toHaveBeenCalled();
  },
);
