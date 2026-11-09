import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { reconTexts } from '../../texts/recon.ts';
import { ClawbackModal, type ClawbackModalProps } from './ClawbackModal.tsx';
import { NOTE_MAX, noteLength } from './model.ts';

// antd Modal 在 jsdom 下注入样式后 getComputedStyle 变慢，单条可能超过默认 5 秒。
vi.setConfig({ testTimeout: 15_000 });

const t = reconTexts.clawback;
const EXT = '𠮷'; // one code point, two UTF-16 units

afterEach(() => {
  cleanup();
});

function renderModal(onSubmit: ClawbackModalProps['onSubmit']): void {
  render(
    <ClawbackModal
      reconDiffId="rd_1"
      orderKey="order_1"
      dimensions={[]}
      expectedFen={100}
      busy={false}
      covered={false}
      locked={false}
      fieldError={undefined}
      error={undefined}
      canSubmit
      onCancel={() => {}}
      onSubmit={onSubmit}
    />,
  );
}

function typeAndConfirm(note: string): void {
  fireEvent.change(screen.getByRole('textbox', { name: t.label }), { target: { value: note } });
  fireEvent.click(screen.getByRole('button', { name: t.submit }));
}

it('[F1-08ec] noteLength counts code points after trimming', () => {
  expect(NOTE_MAX).toBe(200);
  const note = '证'.repeat(199) + EXT;
  expect(note.length).toBe(201);
  expect(noteLength(note)).toBe(200);
  expect(noteLength(`  ${note}\n`)).toBe(200);
  expect(noteLength(' \t\n ')).toBe(0);
});

it('[F1-08ec] 199 Han characters plus one 𠮷 (200 code points) are accepted unchanged', () => {
  const onSubmit = vi.fn();
  renderModal(onSubmit);
  const note = '证'.repeat(199) + EXT;
  typeAndConfirm(`  ${note}  `);
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledWith(note);
  expect(screen.queryByText(t.invalid)).toBeNull();
  // The field keeps the whole note (no truncation at 200 UTF-16 units).
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: t.label }).value).toBe(
    `  ${note}  `,
  );
});

it('[F1-08ec] 201 code points are refused next to the field without submitting', () => {
  const onSubmit = vi.fn();
  renderModal(onSubmit);
  typeAndConfirm('证'.repeat(199) + EXT + EXT);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.getByText(t.invalid)).toBeTruthy();
});

it('[F1-08ec] a whitespace-only note counts as no note (request body {})', () => {
  const onSubmit = vi.fn();
  renderModal(onSubmit);
  typeAndConfirm(' \t\n ');
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledWith(undefined);
  expect(screen.queryByText(t.invalid)).toBeNull();
});
