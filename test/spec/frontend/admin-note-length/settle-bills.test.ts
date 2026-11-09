// @vitest-environment jsdom
// F1-08ed: 月结批次【驳回】的原因（必填，去首尾空白后 1–200 字）按 Unicode 码点计，与 POST
// /admin/v1/settle-batches/{batch_id}/reject 的服务端（[...reason].length，去首尾空白后）一致。
// 写请求只在动态码之后发出：提交后驳回对话框让位给动态码对话框，即表示会往下提交。
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import {
  BatchDialog,
  type WriteNotice,
} from '../../../../apps/admin/src/pages/settle-bills/WriteDialogs.tsx';
import { settleBillsTexts } from '../../../../apps/admin/src/texts/settle-bills.ts';
import { BATCH, batch } from '../admin-settle-bills-write/fixtures.ts';
import {
  buttonNamed,
  expectAccepted,
  flagged,
  isDisabled,
  noteField,
  press,
  settle,
  textareas,
  type,
  waitFlagged,
} from './dom.ts';
import { fits, over, padded } from './support.ts';

const t = settleBillsTexts.writes.reject;

function renderReject(onFinished: (notice: WriteNotice) => void): void {
  render(
    createElement(BatchDialog, {
      batch: batch({
        batch_id: BATCH.issuedTaobao,
        platform: 'taobao',
        kind: 'main',
        status: 'DRAFT',
        order_count: 1196,
        created_at: '2026-09-24T02:10:00+08:00',
        row_version: 0,
      }),
      action: 'reject',
      onClose: () => undefined,
      onFinished,
    }),
  );
}

it(
  '[AC-F1-08ed-SETTLE#1] 批次驳回原因 199 个汉字 + 1 个「𠮷」（前后带空白，去首尾空白后 200 码点）：不报超长、【确认驳回】可点，点后进入动态码；201 码点：在原因旁报超长、不进入动态码',
  { timeout: 60_000 },
  async () => {
    const finished = vi.fn<(notice: WriteNotice) => void>();
    renderReject(finished);
    const typed = padded(fits('驳'));
    await type(noteField(), typed);
    expectAccepted(noteField(), typed, false);
    const submit = buttonNamed(t.submit);
    expect(isDisabled(submit), '【确认驳回】 is usable for 200 code points').toBe(false);
    await press(submit);
    expect(
      textareas(),
      'the reject dialog gives way to the step-up (the write follows the code)',
    ).toHaveLength(0);
    expect(finished, 'nothing is finished before the step-up').not.toHaveBeenCalled();
    cleanup();

    const refused = vi.fn<(notice: WriteNotice) => void>();
    renderReject(refused);
    await type(noteField(), padded(over('驳')));
    await waitFlagged(noteField);
    const blocked = buttonNamed(t.submit);
    if (!isDisabled(blocked)) await press(blocked);
    await settle();
    expect(textareas(), 'the reject dialog stays (no step-up)').toHaveLength(1);
    expect(flagged(noteField()), 'the reason is still marked as too long').toBe(true);
    expect(refused).not.toHaveBeenCalled();
  },
);
