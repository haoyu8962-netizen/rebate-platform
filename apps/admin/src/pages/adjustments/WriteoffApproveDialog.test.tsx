import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { adjustmentsTexts } from '../../texts/adjustments.ts';
import { userWithdrawalsRoute } from '../withdrawals/prefill.ts';
import type { Writeoff } from './model.ts';
import { WriteoffApproveDialog } from './WriteoffApproveDialog.tsx';

// The write and the re-read are not under test here: no request is made while the dialog is only open.
vi.mock('./useAdjustmentWrite.tsx', () => ({
  useAdjustmentWrite: () => ({
    busy: false,
    unknown: false,
    phoneMissing: false,
    stepUp: null,
    submit: vi.fn(),
    retry: vi.fn(),
  }),
}));
vi.mock('./useRead.ts', () => ({ useRead: () => ({ status: 'idle' }) }));

// antd Modal 在 jsdom 下注入样式后 getComputedStyle 变慢，单条可能超过默认 5 秒。
vi.setConfig({ testTimeout: 15_000 });

const w = adjustmentsTexts.writeoffApprove;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function candidate(approveBlocked: boolean): Writeoff {
  return {
    id: 'wo_1',
    account_id: 'acc_1',
    user_id: 'user_frozen',
    negative_since: '2026-11-01',
    negative_days: 109,
    candidate_fen: 12000,
    available_fen: -12345,
    frozen_fen: 5000,
    status: 'PENDING',
    approve_blocked: approveBlocked,
    initiator_id: null,
    approver_id: null,
    approved_at: null,
    voucher_id: null,
    created_at: '2026-11-18T00:00:00+08:00',
  } as Writeoff;
}

function renderDialog(item: Writeoff): HTMLElement {
  // antd Descriptions reads breakpoints through matchMedia, which jsdom does not provide.
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));
  render(
    <MemoryRouter>
      <WriteoffApproveDialog
        item={item}
        planned={false}
        onClose={() => {}}
        onApproved={() => {}}
        onStale={() => {}}
        onCheck={() => {}}
      />
    </MemoryRouter>,
  );
  return screen.getByRole('dialog');
}

it('[F1-08fe] approve_blocked from the list: the frozen notice carries 【去处理提现单】 before any approval is sent', () => {
  const dialog = renderDialog(candidate(true));
  expect(within(dialog).getByText(w.frozenPending)).toBeTruthy();
  const links = within(dialog).getAllByRole('link', { name: w.toWithdrawals });
  expect(links).toHaveLength(1);
  expect(links[0]!.getAttribute('href')).toBe(userWithdrawalsRoute('user_frozen'));
});

it('[F1-08fe] not approve_blocked and not refused: no frozen notice and no 【去处理提现单】', () => {
  const dialog = renderDialog(candidate(false));
  expect(within(dialog).queryByText(w.frozenPending)).toBeNull();
  expect(within(dialog).queryAllByRole('link', { name: w.toWithdrawals })).toEqual([]);
});
