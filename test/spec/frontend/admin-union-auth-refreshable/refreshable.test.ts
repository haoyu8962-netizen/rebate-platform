// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CREDENTIAL, LIST, PHONES, SECRET } from '../admin-unions/fixtures.ts';
import { FLOW_TIMEOUT, loaded, main, mount, settle } from '../admin-unions/helpers.ts';
import {
  ACCESS_TOKEN,
  EXPIRY_COLUMN,
  MANUAL_ACCOUNT,
  RAW_DURATION,
  REFRESHABLE_COLUMN,
  REFRESH_TOKEN,
  accountCell,
  listServer,
  saveManualCredential,
} from './kit.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

it(
  '[AC-F1-10gd-LIST#1] 账号行按续期字段显示，保留到期时间与估算标记',
  async () => {
    const { server, directFetch } = await mount(listServer());
    await loaded();
    await settle();

    expect(main().textContent).not.toContain('联盟账号读取失败');
    expect(screen.queryAllByRole('alert')).toEqual([]);
    expect(server.log.map(({ method, path }) => `${method} ${path}`).sort()).toEqual([
      `GET ${LIST}`,
      `GET ${PHONES}`,
    ]);
    expect(directFetch).not.toHaveBeenCalled();

    expect(within(main()).queryByRole('columnheader', { name: REFRESHABLE_COLUMN })).not.toBeNull();
    const labels = [
      ['测试 OAuth 账号', '能'],
      ['测试不可续期账号', '不能'],
      [MANUAL_ACCOUNT, '未知'],
      ['测试旧版响应账号', '未知'],
    ] as const;
    for (const [account, label] of labels) {
      const cell = accountCell(account, REFRESHABLE_COLUMN);
      expect(cell?.textContent?.trim(), account).toBe(label);
      expect(within(cell!).queryAllByRole('button')).toEqual([]);
      expect(within(cell!).queryAllByRole('link')).toEqual([]);
    }
    expect(screen.queryByRole('button', { name: /续期/ })).toBeNull();

    const exactExpiry = accountCell('测试 OAuth 账号', EXPIRY_COLUMN)?.textContent;
    expect(exactExpiry).toMatch(/2026[-/]12[-/]31.*00:30/);
    expect(exactExpiry).not.toContain('估算');
    const estimatedExpiry = accountCell(MANUAL_ACCOUNT, EXPIRY_COLUMN)?.textContent;
    expect(estimatedExpiry).toMatch(/2026[-/]12[-/]31.*00:30/);
    expect(estimatedExpiry).toContain('估算');

    for (const value of [String(RAW_DURATION), ACCESS_TOKEN, REFRESH_TOKEN]) {
      expect(document.body.textContent).not.toContain(value);
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gd-MANUAL#1] 保存响应的续期字段为 null 时将该行从能更新为未知',
  async () => {
    const { before, server } = await saveManualCredential({ auth_refreshable: null });

    expect(server.requests('PUT', CREDENTIAL)).toHaveLength(1);
    expect(server.requests('GET', LIST)).toHaveLength(1);
    expect(document.body.textContent).not.toContain(SECRET);
    expect(before).toBe('能');
    expect(accountCell(MANUAL_ACCOUNT, REFRESHABLE_COLUMN)?.textContent?.trim()).toBe('未知');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gd-MANUAL#2] 保存响应缺省续期字段时将该行从能更新为未知',
  async () => {
    const { before, server } = await saveManualCredential({});

    expect(server.requests('PUT', CREDENTIAL)).toHaveLength(1);
    expect(server.requests('GET', LIST)).toHaveLength(1);
    expect(document.body.textContent).not.toContain(SECRET);
    expect(before).toBe('能');
    expect(accountCell(MANUAL_ACCOUNT, REFRESHABLE_COLUMN)?.textContent?.trim()).toBe('未知');
  },
  FLOW_TIMEOUT,
);
