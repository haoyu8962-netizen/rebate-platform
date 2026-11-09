// F1-08ed: DOM helpers of the dialog rule tests (jsdom). The dialogs are rendered on their own with
// their props: the fake servers of the existing page tests count the note in UTF-16 units, so a
// 200-code-point note could never pass through them.
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { LIMIT } from './support.ts';

// antd's Form.Item lays out with Grid Row, which listens to window.matchMedia (absent in jsdom).
beforeEach(() => {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}

/** Lets pending effects and promise callbacks run. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

/** Visible textareas on the page (antd's hidden measuring textarea excluded). */
export function textareas(): HTMLTextAreaElement[] {
  return Array.from(document.querySelectorAll('textarea')).filter(
    (node) => node.getAttribute('aria-hidden') !== 'true',
  );
}

/** The one free-text field of the open dialog (each dialog here has exactly one). */
export function noteField(): HTMLTextAreaElement {
  const found = textareas();
  expect(found, 'one note / reason textarea').toHaveLength(1);
  return found[0]!;
}

export async function type(node: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(node, { target: { value } });
  });
  await settle();
}

export async function press(node: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(node);
  });
  await settle();
}

/** The one button whose text (spaces removed) is `name`. */
export function buttonNamed(name: string): HTMLButtonElement {
  const wanted = squash(name);
  const found = Array.from(document.querySelectorAll('button')).filter(
    (node) => squash(node.textContent) === wanted,
  );
  expect(found, `one button 「${name}」`).toHaveLength(1);
  return found[0]!;
}

export function isDisabled(node: HTMLElement): boolean {
  return (
    node.hasAttribute('disabled') ||
    node.getAttribute('aria-disabled') === 'true' ||
    node.closest('fieldset[disabled]') !== null
  );
}

/**
 * Whether the field is shown as wrong: aria-invalid, antd's error status or out-of-range mark on it
 * or its wrapper, or an error message in its form item.
 */
export function flagged(field: HTMLElement): boolean {
  if (field.getAttribute('aria-invalid') === 'true') return true;
  if (
    field.closest(
      '.ant-input-status-error, .ant-input-affix-wrapper-status-error, .ant-input-out-of-range',
    ) !== null
  )
    return true;
  const item = field.closest('.ant-form-item');
  if (item === null) return false;
  if (item.classList.contains('ant-form-item-has-error')) return true;
  return Array.from(item.querySelectorAll('.ant-form-item-explain-error')).some(
    (node) => squash(node.textContent) !== '',
  );
}

/** Waits until the field is shown as wrong. */
export async function waitFlagged(field: () => HTMLElement): Promise<void> {
  await waitFor(() => expect(flagged(field()), 'the field is marked as too long').toBe(true));
}

/** Texts of the character counters (antd showCount) next to `field`, spaces removed. */
export function counters(field: HTMLElement): string[] {
  const wrapper =
    field.closest('.ant-input-textarea-affix-wrapper, .ant-input-affix-wrapper') ??
    field.parentElement;
  if (wrapper === null) return [];
  return Array.from(
    wrapper.querySelectorAll('.ant-input-data-count, .ant-input-show-count-suffix'),
    (node) => squash(node.textContent),
  );
}

/**
 * A note of 200 code points after trimming is kept whole and counted as 200: the field holds the
 * typed text unchanged, no native maxlength below its UTF-16 length, every counter shows 200 (with
 * the limit 200 when it shows one); with `counted`, the field has a counter.
 */
export function expectAccepted(field: HTMLTextAreaElement, typed: string, counted: boolean): void {
  expect(field.value, 'the typed text is kept whole (not cut in UTF-16 units)').toBe(typed);
  const limit = field.getAttribute('maxlength');
  if (limit !== null)
    expect(
      Number(limit),
      'no native maxlength cutting a 200-code-point note',
    ).toBeGreaterThanOrEqual(typed.length);
  const shown = counters(field);
  if (counted) expect(shown.length, 'the field shows its character count').toBeGreaterThan(0);
  for (const text of shown)
    expect(text, 'the counter counts code points after trimming').toMatch(
      new RegExp(`^${LIMIT}(?:/${LIMIT})?$`),
    );
  expect(flagged(field), 'a 200-code-point note is not marked as too long').toBe(false);
}
