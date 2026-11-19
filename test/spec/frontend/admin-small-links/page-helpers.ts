// Harness of the 调账与核销 side (memory router: the frozen F1-08ca / cb / cd mounts over their fake
// servers, which log every request, also the reads of the page a link opens, and answer unknown
// paths 20001 [path]). Where a link went is read from what the shell shows (page title) and what
// the target page reads, not from the address.
import { waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import type { RequestLog } from '../admin-adjustments-readonly/fixtures.ts';
import { main, norm } from '../admin-adjustments-readonly/helpers.ts';

interface Logged {
  readonly log: readonly RequestLog[];
}

/** The page title (first h4 of the main area). */
export function pageTitle(): string {
  return norm(main().querySelector('h4')?.textContent);
}
export async function waitTitle(title: string): Promise<void> {
  await waitFor(() => expect(pageTitle()).toBe(title));
}

/** The value of the one text input of the main area labelled exactly `label`. */
export function inputValue(label: string): string {
  const found = within(main())
    .queryAllByLabelText(label, { exact: true })
    .filter(
      (node): node is HTMLInputElement =>
        node instanceof HTMLInputElement && !['hidden', 'checkbox', 'radio'].includes(node.type),
    );
  expect(found, `one input labelled ${label}`).toHaveLength(1);
  return found[0]!.value;
}

/**
 * The notice (antd Alert / role="alert") holding the one element whose whole text is `line`.
 */
export function noticeWith(line: string): HTMLElement {
  const nodes = Array.from(document.body.querySelectorAll<HTMLElement>('*')).filter(
    (node) =>
      norm(node.textContent) === line &&
      !Array.from(node.children).some((child) => norm(child.textContent) === line),
  );
  expect(nodes, `one element reading ${line}`).toHaveLength(1);
  const box = nodes[0]!.closest<HTMLElement>('[role="alert"], .ant-alert');
  expect(box, `${line} sits in a notice`).not.toBeNull();
  return box!;
}

/** Queries of GET `path` (exact) logged from `since` on, in order. */
export function readsOf(server: Logged, path: string, since = 0): Record<string, string>[] {
  return server.log
    .slice(since)
    .filter((request) => request.method === 'GET' && request.path === path)
    .map((request) => request.query);
}

/** Requests other than GET logged from `since` on. */
export function writesSince(server: Logged, since: number): RequestLog[] {
  return server.log.slice(since).filter((request) => request.method !== 'GET');
}
