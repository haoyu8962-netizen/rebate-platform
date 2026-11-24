// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import dictionary from '../../../../contracts/texts.admin.default.json' with { type: 'json' };
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { Detail, Server } from '../admin-orders/orders-fixtures.ts';
import { detail, manyRows, rows } from '../admin-orders/orders-fixtures.ts';
import { click, mainElement, queries, select, settled } from '../admin-orders/orders-helpers.ts';

export const PLATFORM_CODES = [
  'taobao',
  'jd',
  'pdd',
  'meituan',
  'vip',
  'douyin',
  'eleme',
  'kuaishou',
  'suning',
] as const satisfies readonly Schema<'PlatformCode'>[];

export const PLATFORM_NAMES = [
  '淘宝',
  '京东',
  '拼多多',
  '美团',
  '唯品会',
  '抖音',
  '饿了么',
  '快手',
  '苏宁',
] as const;

type RebateStatus = Schema<'AdminOrderRebateStatus'>;

export const REBATE_STATUSES = [
  'UNATTRIBUTED',
  'ESTIMATED',
  'WAITING',
  'CREDITED',
  'VOID',
  'CLAWED_BACK',
] as const satisfies readonly RebateStatus[];

export const ALL = '全部';
export const PAGE_SIZE_CONTROL = /^(?:Page Size|页码|每页条数)$/i;

const texts: Readonly<Record<string, string>> = dictionary.texts;

export function rebateLabel(code: RebateStatus): string {
  const name = texts[`admin_dict.rebate_status.${code}`];
  return name === undefined ? code : `${name} ${code}`;
}

export function tablistWith(label: string): HTMLElement {
  const matches = within(mainElement())
    .queryAllByRole('tablist')
    .filter((list) => within(list).queryAllByRole('tab', { name: label }).length > 0);
  expect(matches, `包含「${label}」的页签组`).toHaveLength(1);
  return matches[0]!;
}

export async function clickTab(list: HTMLElement, name: string): Promise<void> {
  const tabs = within(list).queryAllByRole('tab', { name });
  expect(tabs, `页签「${name}」`).toHaveLength(1);
  await click(tabs[0]!);
}

export function expectActiveTab(list: HTMLElement, label: string): void {
  const selected = within(list).queryAllByRole('tab', { selected: true });
  expect(selected.map((tab) => tab.textContent?.trim())).toEqual([label]);
}

export function selectControl(name: RegExp): HTMLElement {
  const controls = within(mainElement()).queryAllByRole('combobox', { name });
  expect(controls, `下拉框 ${name}`).toHaveLength(1);
  return controls[0]!;
}

export function selectedLabel(control: HTMLElement): string {
  const selection = control.closest('.ant-select')?.querySelector('.ant-select-selection-item');
  return (selection?.textContent ?? '').trim();
}

export async function choosePageSize(size: 20 | 50 | 100): Promise<void> {
  await select(PAGE_SIZE_CONTROL, new RegExp(`^${size}\\b`));
}

export function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export async function listRequestAfter(server: Server, previousCount: number) {
  await waitFor(() => expect(queries(server)).toHaveLength(previousCount + 1));
  await settled(server);
  expect(queries(server)).toHaveLength(previousCount + 1);
  return queries(server)[previousCount]!;
}

export function detailOnSecondPage() {
  const [order, ...before] = manyRows().slice(0, 51);
  return [...before, order!];
}

export const LONG_NUMBER = '231006-1234567891-98765432101234567890';
export const PRODUCT_IMAGE = 'https://example.test/orders/product.jpg';

export function cellRows() {
  const [attributed, unattributed] = rows();
  const withImage = { ...attributed!, sub_order_id: LONG_NUMBER, image_url: PRODUCT_IMAGE };
  return [withImage, unattributed!];
}

type Split = NonNullable<Detail['commission_split']>;

export const BENEFICIARIES = [
  {
    user_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c11',
    role: 'direct',
    ratio_bp: 2500,
    forfeit_reason: null,
  },
  {
    user_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c12',
    role: 'self',
    ratio_bp: 5075,
    forfeit_reason: null,
  },
  {
    user_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c13',
    role: 'share',
    ratio_bp: 1000,
    forfeit_reason: 'deleted',
  },
  {
    user_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c14',
    role: 'direct',
    ratio_bp: 1250,
    forfeit_reason: 'banned',
  },
  {
    user_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c15',
    role: 'indirect',
    ratio_bp: 175,
    forfeit_reason: 'minor',
  },
] satisfies Split['beneficiaries'];

export const BENEFICIARIES_WITHOUT_INDIRECT = BENEFICIARIES.filter(
  ({ role }) => role !== 'indirect',
);
export const SPLIT_BASE_FEN = 3_270_000;

export function splitDetail(
  rebateStatus: 'CREDITED' | 'ESTIMATED' | 'WAITING',
  beneficiaries: Split['beneficiaries'] = BENEFICIARIES,
): Detail {
  return detail({
    rebate_status: rebateStatus,
    display_status: rebateStatus === 'ESTIMATED' ? 'PAID' : rebateStatus,
    credited_at: rebateStatus === 'CREDITED' ? '2026-10-15T17:42:18Z' : null,
    commission_split: {
      ...detail().commission_split!,
      base_fen: SPLIT_BASE_FEN,
      beneficiaries,
    },
  });
}
