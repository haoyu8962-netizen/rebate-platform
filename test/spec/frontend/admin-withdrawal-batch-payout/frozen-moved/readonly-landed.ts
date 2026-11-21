import { expect } from 'vitest';
import type { Server } from '../../admin-withdrawals/fixtures.ts';
import {
  REVEAL,
  WRITE,
  actions,
  assertOnlyReads,
  click,
  main,
  revealEntries,
  settled,
  squash,
  usable,
} from '../../admin-withdrawals/helpers.ts';

/**
 * The page offers no usable write entry (and, on a detail, no usable reveal entry); pressing every
 * write, reveal or 【查看】-like entry, usable or not, sends nothing but the allowed reads and
 * shows no unmasked value.
 */
export async function assertReadOnlyLanded(
  server: Server,
  options: { readonly root?: HTMLElement; readonly detail?: boolean } = {},
  landed?: readonly string[],
) {
  const root = options.root ?? main();
  /** `node` is a `landed` entry: exempt from WRITE, asserted present, never pressed. */
  const isLanded = (node: HTMLElement): boolean =>
    landed !== undefined &&
    (landed.includes(squash(node.textContent)) ||
      landed.includes(squash(node.getAttribute('aria-label'))));
  expect(
    usable(root, WRITE)
      .filter((node) => !isLanded(node))
      .map((node) => squash(node.textContent)),
    'no usable write entry (approve / reject / batch / payout / export …)',
  ).toEqual([]);
  if (landed !== undefined)
    expect(
      usable(root, WRITE)
        .map((node) => squash(node.textContent) || squash(node.getAttribute('aria-label')))
        .sort(),
      'exactly the landed write entries are usable, each once',
    ).toEqual([...landed].sort());
  if (options.detail === true)
    expect(
      revealEntries(root).map(
        (node) => squash(node.textContent) || squash(node.getAttribute('aria-label')),
      ),
      'no usable reveal entry beside the masked values',
    ).toEqual([]);
  const pressable = [...actions(root, WRITE), ...actions(root, REVEAL), ...actions(root, /^查看/)];
  for (let index = pressable.length - 1; index >= 0; index -= 1)
    if (isLanded(pressable[index]!)) pressable.splice(index, 1);
  for (const node of new Set(pressable)) if (node.isConnected) await click(node);
  await settled(server);
  expect(server.writes(), 'no request other than GET').toEqual([]);
  assertOnlyReads();
}
