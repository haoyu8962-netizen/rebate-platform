import { act, fireEvent, waitFor } from '@testing-library/react';
import { expect } from 'vitest';
import { EXPORTS } from '../admin-ledger-readonly/fixtures.ts';
import {
  control,
  controlsNamed,
  isDisabled,
  main,
  pageTitle,
  settled,
} from '../admin-ledger-readonly/helpers.ts';
import { EXPORT_LABEL, type ExportFilters, type SentRequest, type Server } from './fixtures.ts';

export function exportButton(): HTMLElement {
  // Assert before dereferencing: every export flow fails by assertion on the pre-feature page.
  return control(main(), EXPORT_LABEL);
}

export function expectEntry(): void {
  const action = exportButton();
  expect(isDisabled(action)).toBe(false);
  const title = main().querySelector('h4');
  expect(title, '余额流水 title').not.toBeNull();
  expect(controlsNamed(title!.parentElement!, EXPORT_LABEL)).toEqual([action]);
  expect(controlsNamed(title!.parentElement!, '导出记录')).toHaveLength(1);
}

export async function submit(server: Server, twice = false): Promise<void> {
  const count = server.exportPosts().length;
  const action = exportButton();
  await act(async () => {
    fireEvent.click(action);
    if (twice) fireEvent.click(action);
  });
  await waitFor(() => expect(server.exportPosts()).toHaveLength(count + 1));
}

export function expectRequest(sent: SentRequest, filters: ExportFilters): void {
  expect(sent.method).toBe('POST');
  expect(sent.path).toBe(EXPORTS);
  expect(sent.query).toEqual({});
  expect(sent.body).toEqual({ resource: 'ledger', filters });
  expect(sent.headers.has('Idempotency-Key')).toBe(false);
  expect(sent.headers.has('X-Step-Up-Token')).toBe(false);
}

export async function notice(text: string): Promise<void> {
  await waitFor(() => {
    const areas = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="alert"], [role="status"], .ant-message-notice-content, .ant-notification-notice-description',
      ),
    );
    const texts = areas.map((area) => area.textContent?.trim() ?? '');
    expect(
      texts.find((value) => value === text),
      '完整提示文案',
    ).toBe(text);
  });
}

export async function expectSuccess(server: Server, id: string): Promise<void> {
  await notice(`已创建导出任务 ${id}，到导出记录下载`);
  await settled(server);
  expect(isDisabled(exportButton())).toBe(false);
  expect(window.location.pathname).toBe('/ledger');
  expect(pageTitle()).toBe('余额流水');
}

export function expectOnlyExportsWritten(server: Server, count: number): void {
  const writes = server.requests.filter((sent) => sent.method !== 'GET');
  expect(writes.map((sent) => [sent.method, sent.path])).toEqual(
    Array.from({ length: count }, () => ['POST', EXPORTS]),
  );
  expect(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).toHaveLength(0);
}
