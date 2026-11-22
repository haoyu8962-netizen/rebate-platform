// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import { click } from '../admin-withdrawal-auto-payout-settings/helpers.ts';
import {
  CLOSE,
  banners,
  handlersWithoutRole,
  noticeShown,
  squash,
  stored,
} from '../admin-unknown-relogin-marker/helpers.ts';

export const UNKNOWN_AT = '2026-11-18T04:09:00.000Z';
export const UNKNOWN_SHOWN = '2026-11-18 12:09:00';
export const AFTER_ANSWERS = '2026-11-18T04:12:00.000Z';

export function expectStoredMarker(
  page: string,
  at: string,
  items: readonly { readonly value: string }[] = stored(),
): void {
  expect(
    items.map(({ value }) => JSON.parse(value) as unknown),
    '该账号该页只有一项标记，时刻取自未知回答',
  ).toEqual([{ page, unknown: true, at }]);
}

// 冻结的 closeBanner 还会检查存储立即清空。并发时这里仅检查关闭后的可见提示。
export async function dismissBanner(): Promise<void> {
  await waitFor(() => expect(banners()).toHaveLength(1));
  const banner = banners()[0]!;
  expect(handlersWithoutRole(banner)).toEqual([]);
  await click(within(banner).getByRole('button', { name: CLOSE }));
  await waitFor(() => expect(noticeShown()).toBe(false));
}

export async function expectNewBanner(): Promise<void> {
  await waitFor(() => expect(banners()).toHaveLength(1));
  const banner = banners()[0]!;
  expect(squash(banner.textContent)).toContain(squash(UNKNOWN_SHOWN));
  expect(within(banner).getAllByRole('button')).toEqual([
    within(banner).getByRole('button', { name: CLOSE }),
  ]);
  expect(handlersWithoutRole(banner)).toEqual([]);
}
