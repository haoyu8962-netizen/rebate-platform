// @vitest-environment jsdom
// F1-08ed: 原路退款的备注（选填，去首尾空白后 ≤ 200 字）按 Unicode 码点计，与
// POST …/refunds 的服务端（契约 AdminPayRefundCreateRequest.note maxLength，Ajv 按码点）一致；
// 请求体照旧：amount_fen、reason_code 与去首尾空白后的 note。
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import type { PayRefundCreateRequest } from '../../../../apps/admin/src/pages/pay-orders/model.ts';
import { RefundModal } from '../../../../apps/admin/src/pages/pay-orders/RefundModal.tsx';
import { payOrdersTexts } from '../../../../apps/admin/src/texts/pay-orders.ts';
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

type Submit = (body: PayRefundCreateRequest) => void;

function renderRefund(onSubmit: Submit): void {
  render(
    createElement(RefundModal, {
      target: 'PO2026103100000001',
      refundable: 10_000n,
      refundableNote: '',
      sending: false,
      amountRejected: 0,
      error: undefined,
      canSubmit: true,
      onCancel: () => undefined,
      onSubmit,
    }),
  );
}

/** The amount input (the only text input that is not the reason select's search box). */
function amountField(): HTMLInputElement {
  const found = Array.from(document.querySelectorAll('input')).filter(
    (node) =>
      node.getAttribute('role') !== 'combobox' &&
      !['hidden', 'search', 'radio', 'checkbox'].includes(node.type),
  );
  expect(found, 'one amount input').toHaveLength(1);
  return found[0]!;
}

/** Picks the first reason of the select. */
async function chooseReason(): Promise<void> {
  const combo = document.querySelector<HTMLElement>('[role="combobox"]');
  expect(combo, 'the reason select').not.toBeNull();
  await act(async () => {
    fireEvent.mouseDown(combo!);
  });
  let first: HTMLElement | undefined;
  await waitFor(() => {
    first = Array.from(
      document.querySelectorAll<HTMLElement>('.ant-select-item-option-content'),
    )[0];
    expect(first, 'a reason option').toBeDefined();
  });
  await press(first!);
}

/** Fills amount 1.00, a reason and the note; returns after the note is typed. */
async function fillRefund(note: string): Promise<void> {
  await type(amountField(), '1.00');
  await chooseReason();
  await type(noteField(), note);
}

it(
  '[AC-F1-08ed-REFUND#1] 退款备注 199 个汉字 + 1 个「𠮷」（前后带空白，去首尾空白后 200 码点）：不截断、字数显示 200、不报超长，提交的请求体带去首尾空白后的整段备注；201 码点：在备注旁报超长、不提交',
  { timeout: 60_000 },
  async () => {
    const accepted = vi.fn<Submit>();
    renderRefund(accepted);
    const note = fits('退');
    const typed = padded(note);
    await fillRefund(typed);
    expectAccepted(noteField(), typed, true);
    await press(buttonNamed(payOrdersTexts.refund.submit));
    await waitFor(() => expect(accepted).toHaveBeenCalledTimes(1));
    const body = accepted.mock.calls[0]![0];
    expect(Object.keys(body).sort()).toEqual(['amount_fen', 'note', 'reason_code']);
    expect(body.amount_fen).toBe(100);
    expect(body.note).toBe(note);
    expect(flagged(noteField()), 'no error after submitting').toBe(false);
    cleanup();

    const refused = vi.fn<Submit>();
    renderRefund(refused);
    await fillRefund(padded(over('退')));
    await press(buttonNamed(payOrdersTexts.refund.submit));
    await waitFlagged(noteField);
    await settle();
    expect(refused, 'a 201-code-point note is not submitted').not.toHaveBeenCalled();
  },
);
