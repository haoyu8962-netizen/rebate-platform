// @vitest-environment jsdom
// F1-09-qr ③: the version list gains an error-rate column next to 渲染次数 / 错误次数.
// Format fixed by this test: error_count / render_count × 100, rounded to at most two decimals,
// trailing zeros dropped, followed by "%" (3/200 → 1.5%, 1/3 → 33.33%, 2/3 → 66.67%);
// render_count 0 → the page's empty placeholder "—" (never NaN, Infinity or 0%).
import { cleanup, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from '../admin-home-config/fixtures.ts';
import {
  history,
  loaded,
  mainElement,
  mount,
  versionRow,
  FLOW_TIMEOUT,
} from '../admin-home-config/helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function cellText(row: HTMLElement, title: RegExp): string {
  const table = row.closest('table');
  expect(table, 'version row inside a table').not.toBeNull();
  const index = within(table!)
    .getAllByRole('columnheader')
    .findIndex((node) => title.test(node.textContent ?? ''));
  expect(index, `column ${String(title)}`).toBeGreaterThanOrEqual(0);
  expect(row.children[index], `cell of column ${String(title)}`).toBeDefined();
  return (row.children[index]!.textContent ?? '').replace(/\s+/g, '');
}

it(
  '[AC-F1-09u-RATE#1] 版本列表有错误率列：error_count / render_count 的百分比（至多 2 位小数、去尾零），render_count 为 0 显示「—」，无 NaN / Infinity / 0%',
  async () => {
    const server = createServer();
    // [version, render_count, error_count, expected error rate]
    const rows = [
      [8, 0, 0, '—'],
      [7, 200, 3, '1.5%'],
      [6, 3, 1, '33.33%'],
      [5, 3, 2, '66.67%'],
      [4, 0, 2, '—'],
    ] as const;
    for (const entry of server.history.get('home')!) {
      const counts = rows.find(([version]) => version === entry.version);
      expect(counts, `fixture counts for v${entry.version}`).toBeDefined();
      entry.render_count = counts![1];
      entry.error_count = counts![2];
    }
    await mount(server);
    await loaded();
    await history(server);
    for (const [version, renders, errors, rate] of rows) {
      const row = await versionRow(mainElement(), version);
      expect(cellText(row, /错误率/), `error rate of v${version}`).toBe(rate);
      expect(cellText(row, /渲染次数/), `renders of v${version}`).toBe(String(renders));
      expect(cellText(row, /错误次数/), `errors of v${version}`).toBe(String(errors));
    }
    expect(mainElement().textContent).not.toMatch(/NaN|Infinity/);
  },
  FLOW_TIMEOUT,
);
