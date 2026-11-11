// @vitest-environment jsdom
// F1-15b: the record subpage's error states — the server's 10403 shows 「无权限」 (no rows, no
// automatic resend); a network failure offers 【重试】, which reads the list again.
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { PROCESSED, REWARDS, createRewardServer, failure } from './fixtures.ts';
import {
  NO_PERMISSION,
  SUBPAGE,
  click,
  listed,
  mainElement,
  mountAt,
  rowsWith,
  settled,
} from './helpers.ts';

it(
  '[AC-F1-15b-ERROR#1] 列表遇 10403 显示无权限，不列出记录、不自动重发',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    server.once('GET', REWARDS, () =>
      failure(10403, { reason: 'admin_permission_denied' }, '没有操作权限'),
    );
    await mountAt(server, SUBPAGE);
    await waitFor(() => expect(server.requests('GET', REWARDS)).toHaveLength(1));
    await waitFor(() => expect(mainElement().textContent).toMatch(NO_PERMISSION));
    await settled(server);
    expect(window.location.pathname).toBe(SUBPAGE);
    expect(server.requests('GET', REWARDS)).toHaveLength(1);
    expect(rowsWith(PROCESSED.invitee_phone_masked)).toEqual([]);
  },
);

it(
  '[AC-F1-15b-ERROR#2] 网络失败显示可重试，点【重试】重新读取并列出记录',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    server.once('GET', REWARDS, () => Promise.reject(new TypeError('Failed to fetch')));
    await mountAt(server, SUBPAGE);
    const reloadButtons = () =>
      within(mainElement()).queryAllByRole('button', { name: /重试|重新加载|重新读取/ });
    await waitFor(() => expect(reloadButtons().length, '【重试】 after a network failure').toBe(1));
    expect(rowsWith(PROCESSED.invitee_phone_masked)).toEqual([]);
    expect(server.requests('GET', REWARDS)).toHaveLength(1);
    await click(reloadButtons()[0]!);
    await listed(PROCESSED.invitee_phone_masked);
    expect(server.requests('GET', REWARDS)).toHaveLength(2);
  },
);
