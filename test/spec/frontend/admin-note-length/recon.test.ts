// @vitest-environment jsdom
// F1-08ed: 差错单【核销】的备注（选填，去首尾空白后 ≤ 200 字）与【关闭（不处理）】的原因（必填，
// 去首尾空白后 1–200 字）按 Unicode 码点计，与 POST /admin/v1/recon-diffs/{id}/write-off、
// …/close 的服务端（[...s].length，去首尾空白后）一致。
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { CloseModal } from '../../../../apps/admin/src/pages/recon/CloseModal.tsx';
import { WriteOffModal } from '../../../../apps/admin/src/pages/recon/WriteOffModal.tsx';
import { reconTexts } from '../../../../apps/admin/src/texts/recon.ts';
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

type NoteSubmit = (note: string | undefined) => void;
type ReasonSubmit = (reason: string) => void;

function renderWriteOff(onSubmit: NoteSubmit): void {
  render(
    createElement(WriteOffModal, {
      reconDiffId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f0001',
      withdrawalRef: 'wd_0199a3b4',
      busy: false,
      covered: false,
      locked: false,
      fieldError: undefined,
      error: undefined,
      canSubmit: true,
      onCancel: () => undefined,
      onSubmit,
    }),
  );
}

function renderClose(onSubmit: ReasonSubmit): void {
  render(
    createElement(CloseModal, {
      reconDiffId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f0002',
      sending: false,
      fieldError: undefined,
      error: undefined,
      canSubmit: true,
      onCancel: () => undefined,
      onSubmit,
    }),
  );
}

it(
  '[AC-F1-08ed-RECON#1] 【核销】备注 199 个汉字 + 1 个「𠮷」（前后带空白，去首尾空白后 200 码点）：不截断、字数显示 200、不报超长，确认后交出去首尾空白后的整段备注；201 码点：在备注旁报超长、不提交',
  { timeout: 60_000 },
  async () => {
    const accepted = vi.fn<NoteSubmit>();
    renderWriteOff(accepted);
    const note = fits('核');
    const typed = padded(note);
    await type(noteField(), typed);
    expectAccepted(noteField(), typed, true);
    await press(buttonNamed(reconTexts.writeOff.submit));
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledWith(note);
    expect(flagged(noteField()), 'no error after confirming').toBe(false);
    cleanup();

    const refused = vi.fn<NoteSubmit>();
    renderWriteOff(refused);
    await type(noteField(), padded(over('核')));
    await press(buttonNamed(reconTexts.writeOff.submit));
    await waitFlagged(noteField);
    await settle();
    expect(refused, 'a 201-code-point note is not submitted').not.toHaveBeenCalled();
  },
);

it(
  '[AC-F1-08ed-RECON#2] 【关闭（不处理）】原因 199 个汉字 + 1 个「𠮷」（前后带空白，去首尾空白后 200 码点）：不截断、字数显示 200、不报错，确认后交出去首尾空白后的整段原因；201 码点或只有空白：在原因旁报错、不提交',
  { timeout: 60_000 },
  async () => {
    const accepted = vi.fn<ReasonSubmit>();
    renderClose(accepted);
    const reason = fits('关');
    const typed = padded(reason);
    await type(noteField(), typed);
    expectAccepted(noteField(), typed, true);
    await press(buttonNamed(reconTexts.close.submit));
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledWith(reason);
    expect(flagged(noteField()), 'no error after confirming').toBe(false);
    cleanup();

    const refused = vi.fn<ReasonSubmit>();
    renderClose(refused);
    await type(noteField(), padded(over('关')));
    await press(buttonNamed(reconTexts.close.submit));
    await waitFlagged(noteField);
    await settle();
    expect(refused, 'a 201-code-point reason is not submitted').not.toHaveBeenCalled();
    cleanup();

    const blank = vi.fn<ReasonSubmit>();
    renderClose(blank);
    await type(noteField(), ' \n ');
    await press(buttonNamed(reconTexts.close.submit));
    await waitFlagged(noteField);
    await settle();
    expect(blank, 'a blank reason is still refused').not.toHaveBeenCalled();
  },
);
