// Harness of the 余额流水 side (browser router: the frozen F1-08fa mount over its fake server, which
// logs every request, also those of the pages a link opens, and answers them 20001 [path]). Pages
// are reached only through the real shell, so a missing link is an assertion failure.
import { waitFor } from '@testing-library/react';
import { expect } from 'vitest';
import type { RequestLog, Server } from '../admin-ledger-readonly/fixtures.ts';
import {
  controlNames,
  controls,
  dataRows,
  main,
  tableTitles,
} from '../admin-ledger-readonly/helpers.ts';
import { PAGE } from './fixtures.ts';

export * from '../admin-ledger-readonly/helpers.ts';

/** The 业务单号 cell of body row `index` of the ledger table. */
export function bizCell(index: number): HTMLElement {
  const column = tableTitles().indexOf(PAGE.refLabel);
  expect(column, 'the 业务单号 column').toBeGreaterThanOrEqual(0);
  const row = dataRows()[index];
  expect(row, `ledger row ${index}`).toBeDefined();
  const cell = row!.children[column];
  expect(cell, `the 业务单号 cell of row ${index}`).toBeInstanceOf(HTMLElement);
  return cell as HTMLElement;
}

/** Names of the links / buttons inside the 业务单号 cell of row `index` (spaces removed). */
export function bizLinks(index: number): string[] {
  return controlNames(bizCell(index));
}

/** The one link of the 业务单号 cell of row `index`. */
export function bizLink(index: number): HTMLElement {
  const found = controls(bizCell(index));
  expect(found, `one link in the 业务单号 cell of row ${index}`).toHaveLength(1);
  return found[0]!;
}

/** The 资金摘要 card (the antd Card holding the summary items). */
export function summaryCard(): HTMLElement {
  const labels = main().querySelectorAll<HTMLElement>('dt, .ant-descriptions-item-label');
  const label = Array.from(labels).find(
    (node) => (node.textContent ?? '').trim() === PAGE.availableLabel,
  );
  expect(label, 'the 资金摘要 item 可用余额').toBeDefined();
  const card = label!.closest<HTMLElement>('.ant-card');
  expect(card, 'the 资金摘要 card').not.toBeNull();
  return card!;
}

/** Waits until the browser address is `pathname`. */
export async function landedOn(pathname: string): Promise<void> {
  await waitFor(() => expect(window.location.pathname).toBe(pathname));
}

/** GET requests of `path` (exact) in the log. */
export function gets(server: Server, path: string): RequestLog[] {
  return server.log.filter((request) => request.method === 'GET' && request.path === path);
}

/** Waits until a GET of `path` was sent. */
export async function waitGet(server: Server, path: string): Promise<void> {
  await waitFor(() => expect(gets(server, path).length, `GET ${path}`).toBeGreaterThan(0));
}

/** Every request whose method is not GET. */
export function nonGets(server: Server): RequestLog[] {
  return server.log.filter((request) => request.method !== 'GET');
}

/** The selected tab of the main area (its text, spaces removed). */
export function selectedTab(): string | undefined {
  const tab = main().querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  return tab === null ? undefined : (tab.textContent ?? '').replace(/\s+/g, '');
}
