// @vitest-environment jsdom
// F1-08ed: 推广位【停用】的原因（选填，1–200 字）按 Unicode 码点计，与 POST
// /admin/v1/union-pids/{pid_id}/retire 的服务端（union/domain/admin-reason.ts，[...value].length）
// 一致。写请求只在动态码之后发出：这里以「是否进入动态码」判断是否会提交。
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { RetireDialog } from '../../../../apps/admin/src/pages/unions/RetireDialog.tsx';
import type { StepUp, StepUpRequest } from '../../../../apps/admin/src/pages/unions/useStepUp.tsx';
import { unionsTexts } from '../../../../apps/admin/src/texts/unions.ts';
import { ACTIVE_ID, pids } from '../admin-union-pids/fixtures.ts';
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
import { fits, over, padded } from './support.ts';

type Ask = (request: StepUpRequest) => void;

function activeRow() {
  const row = pids().find((item) => item.pid_id === ACTIVE_ID);
  expect(row, 'the active PID sample').toBeDefined();
  return row!;
}

function renderRetire(ask: Ask): void {
  const stepUp: StepUp = { ask, open: false, modal: createElement('div') };
  render(
    createElement(RetireDialog, {
      row: activeRow(),
      stepUp,
      onClose: () => undefined,
      onRetired: () => undefined,
      onConflict: () => undefined,
    }),
  );
}

it(
  '[AC-F1-08ed-UNIONS#1] 推广位【停用】原因 199 个汉字 + 1 个「𠮷」（前后带空白，去首尾空白后 200 码点）：输入框不按 UTF-16 截断、不报错，【验证并停用】进入动态码；201 码点：在原因旁报错、不进入动态码',
  { timeout: 60_000 },
  async () => {
    const accepted = vi.fn<Ask>();
    renderRetire(accepted);
    const typed = padded(fits('停'));
    await type(noteField(), typed);
    expectAccepted(noteField(), typed, false);
    await press(buttonNamed(unionsTexts.pids.retireSubmit));
    expect(accepted, 'the step-up is asked for once').toHaveBeenCalledTimes(1);
    expect(flagged(noteField()), 'no error after confirming').toBe(false);
    cleanup();

    const refused = vi.fn<Ask>();
    renderRetire(refused);
    await type(noteField(), padded(over('停')));
    await press(buttonNamed(unionsTexts.pids.retireSubmit));
    await waitFlagged(noteField);
    await settle();
    expect(
      refused,
      'no step-up (and no request) for a 201-code-point reason',
    ).not.toHaveBeenCalled();
  },
);
