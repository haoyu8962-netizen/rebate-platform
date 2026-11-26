import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import { ROUTE, type Server } from '../admin-orders/orders-fixtures.ts';
import { click, fill, loaded, mount, textbox } from '../admin-orders/orders-helpers.ts';
import { ASSIGN_REASON, ENTRY, NOTE, TARGET, controls, entryName, type Action } from './kit.ts';

export async function renderOrder(
  server: Server,
  permission?: 'order.hold' | 'order.assign' | 'order.claim',
) {
  const view = await mount(
    server,
    ROUTE,
    permission === undefined
      ? { isSuper: true, permissions: [] }
      : { isSuper: false, permissions: ['order.view', permission] },
  );
  await loaded();
  return view;
}

export async function open(action: Action): Promise<HTMLElement> {
  const entries = controls(screen.getByRole('main'), entryName(ENTRY[action]));
  expect(entries, `详情页入口「${ENTRY[action]}」`).toHaveLength(1);
  await click(entries[0]!);
  return screen.findByRole('dialog', { name: entryName(ENTRY[action]) });
}

export function submitButton(form: HTMLElement): HTMLElement {
  const buttons = within(form).queryAllByRole('button', {
    name: /^(?:确认|提交|保存|暂停结算|恢复结算|指定归属)/,
  });
  expect(buttons, '表单有一个提交按钮').toHaveLength(1);
  return buttons[0]!;
}

export async function submit(form: HTMLElement): Promise<void> {
  await click(submitButton(form));
}

export const HOLD_REASON_LABEL = /原因/;
export const SUB_REASON_LABEL = /原因/;
export const UID_LABEL = /UID|用户/i;
export const ASSIGN_REASON_LABEL = /原因/;

export function noteField(form: HTMLElement): HTMLElement {
  return textbox(/备注|说明/, form);
}

export type Choice = { readonly label: string | RegExp; readonly code: string };
export const STAFF_REASONS = [
  { code: 'RISK', label: /风控|风险|\bRISK\b/i },
  { code: 'CS', label: /客服|\bCS\b/i },
] as const;

function named(choice: Choice, label: string): boolean {
  return typeof choice.label === 'string' ? choice.label === label : choice.label.test(label);
}

async function picker(form: HTMLElement, label: RegExp) {
  const scope = within(form);
  const radios = scope.queryAllByRole('radio');
  if (radios.length > 0) {
    return radios.map((node) => ({
      label: node.getAttribute('aria-label') ?? node.closest('label')?.textContent?.trim() ?? '',
      choose: () => click(node),
    }));
  }

  const combos = scope.queryAllByRole('combobox', { name: label });
  expect(combos, `有一个可访问的选项控件 ${String(label)}`).toHaveLength(1);
  const combo = combos[0]!;
  if (combo instanceof HTMLSelectElement) {
    return Array.from(combo.options)
      .filter((option) => option.value !== '')
      .map((option) => ({
        label: option.label,
        choose: async () => {
          await act(async () => {
            fireEvent.change(combo, { target: { value: option.value } });
          });
        },
      }));
  }

  await act(async () => {
    fireEvent.mouseDown(combo);
  });
  const options = () => {
    const antdOptions = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content',
      ),
    );
    return antdOptions.length === 0 ? screen.queryAllByRole('option') : antdOptions;
  };
  await waitFor(() => expect(options().length).toBeGreaterThan(0));
  return options().map((node) => ({
    label: node.textContent?.trim() ?? '',
    choose: () => click(node),
  }));
}

export async function choose(
  form: HTMLElement,
  label: RegExp,
  choice: Choice,
  allowed?: readonly Choice[],
): Promise<void> {
  const options = await picker(form, label);
  if (allowed !== undefined) {
    const codes = options.map((option) => allowed.find((item) => named(item, option.label))?.code);
    expect(codes.sort()).toEqual(allowed.map((item) => item.code).sort());
  }
  const matches = options.filter((option) => named(choice, option.label));
  expect(matches, `选项 ${choice.code}`).toHaveLength(1);
  await matches[0]!.choose();
}

export async function fillHold(
  form: HTMLElement,
  reason: Choice = STAFF_REASONS[0],
  note = NOTE,
): Promise<void> {
  await choose(form, HOLD_REASON_LABEL, reason);
  await fill(noteField(form), note);
}

export async function fillAssign(form: HTMLElement, reason = ASSIGN_REASON): Promise<void> {
  await fill(textbox(UID_LABEL, form), TARGET);
  await fill(textbox(ASSIGN_REASON_LABEL, form), reason);
}
