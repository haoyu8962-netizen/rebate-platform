import { act, screen } from '@testing-library/react';
import { expect } from 'vitest';

/** Let pending promises, zero-delay timers and React renders run (only Date is faked). */
export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** How many smallest text nodes match; a plain count so a missing row fails as an assertion. */
export function count(pattern: RegExp | string): number {
  return screen.queryAllByText(pattern, { exact: false }).length;
}

/** All alert texts on the page, joined (empty when there is none). */
export function alertText(): string {
  return screen
    .queryAllByRole('alert')
    .map((element) => element.textContent ?? '')
    .join(' ');
}

/** `earlier` is rendered before `later` in document order. */
export function expectBefore(earlier: RegExp | string, later: RegExp | string): void {
  expect(count(earlier), `${String(earlier)} 须在页面上`).toBe(1);
  expect(count(later), `${String(later)} 须在页面上`).toBe(1);
  const first = screen.getByText(earlier, { exact: false });
  const second = screen.getByText(later, { exact: false });
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
}
