import { waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import type { RequestLog, Server } from '../admin-settle-bills/fixtures.ts';
import { click, main } from '../admin-settle-bills/helpers.ts';
import { AWAITING } from './fixtures.ts';

/** The accessible name of the filter's 「待确认」 switch or check box. */
export const AWAITING_LABEL = /待确认/;

/** Check boxes and switches of the main area whose accessible name holds 「待确认」. */
export function awaitingToggles(): HTMLElement[] {
  const scope = within(main());
  return [
    ...scope.queryAllByRole('checkbox', { name: AWAITING_LABEL }),
    ...scope.queryAllByRole('switch', { name: AWAITING_LABEL }),
  ];
}
export function awaitingToggle(): HTMLElement {
  const found = awaitingToggles();
  expect(found, 'one 「待确认」 check box or switch in the list filter').toHaveLength(1);
  return found[0]!;
}
/** A check box (native or ARIA) or a switch is on. */
export function isOn(node: HTMLElement): boolean {
  if (node instanceof HTMLInputElement) return node.checked;
  return node.getAttribute('aria-checked') === 'true';
}
/** Turns the 「待确认」 filter on or off (it applies with 【查询】). */
export async function setAwaiting(on: boolean): Promise<void> {
  const node = awaitingToggle();
  if (isOn(node) !== on) await click(node);
  await waitFor(() => expect(isOn(awaitingToggle()), `「待确认」 ${on ? 'on' : 'off'}`).toBe(on));
}

/** The list reads of the bill table (a count read, page_size=1, aside). */
export function tableReadsOf(server: Server): RequestLog[] {
  return server.reads().filter((read) => read.query['page_size'] !== '1');
}
/** The awaiting_confirm values the table reads sent, in order (undefined: left out). */
export function awaitingSent(reads: readonly RequestLog[]): (string | undefined)[] {
  return reads.map((read) => read.query[AWAITING]);
}
