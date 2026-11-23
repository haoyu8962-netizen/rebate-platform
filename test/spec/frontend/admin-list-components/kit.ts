import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import type { DataTableProps } from '../../../../apps/admin/src/components/data-table/index.ts';
import type { DetailDrawerProps } from '../../../../apps/admin/src/components/detail-drawer/index.ts';
import type { FilterBarProps } from '../../../../apps/admin/src/components/filter-bar/index.ts';
import type { ProductCellProps } from '../../../../apps/admin/src/components/product-cell/index.ts';
import type { StatCardsProps } from '../../../../apps/admin/src/components/stat-cards/index.ts';
import type { StatusTabsProps } from '../../../../apps/admin/src/components/status-tabs/index.ts';

beforeEach(() => {
  // antd Table / Form use matchMedia to subscribe to responsive breakpoints.
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

export function clipboardUser() {
  // setup supplies the Clipboard API in jsdom. Each test controls only the write result.
  const user = userEvent.setup();
  return { user, writeText: vi.spyOn(navigator.clipboard, 'writeText') };
}

export function enterValue(label: string, value: string, confirm = false): void {
  const input = screen.getByLabelText(label);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  if (confirm) fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.blur(input);
}

export function openOptions(control: HTMLElement): HTMLElement[] {
  if (control instanceof HTMLSelectElement) return within(control).getAllByRole('option');
  fireEvent.mouseDown(control);
  // antd virtualizes options and renders separate ARIA proxy nodes. Use the clickable options.
  const antdOptions = document.querySelectorAll<HTMLElement>('.ant-select-item-option');
  if (antdOptions.length > 0) return Array.from(antdOptions);
  return screen.getAllByRole('option');
}

export function chooseOption(control: HTMLElement, option: HTMLElement): void {
  if (control instanceof HTMLSelectElement && option instanceof HTMLOptionElement) {
    fireEvent.change(control, { target: { value: option.value } });
  } else {
    fireEvent.click(option);
  }
}

export function selectedOptionText(control: HTMLElement): string {
  if (control instanceof HTMLSelectElement) {
    return control.value === '' ? '' : (control.selectedOptions.item(0)?.textContent ?? '').trim();
  }
  return (
    control.closest('.ant-select')?.querySelector('.ant-select-selection-item')?.textContent ?? ''
  ).trim();
}

export function setQuery(values: Record<string, string>): void {
  window.history.replaceState(null, '', `/admin-list-fixture?${new URLSearchParams(values)}`);
}

export function readQuery(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

export interface OrderRow {
  readonly id: string;
  readonly buyer: string;
  readonly total: string;
}

export const tableProps: DataTableProps<OrderRow> = {
  rows: [
    { id: 'ORD-205', buyer: '会员乙', total: '¥20.50' },
    { id: 'ORD-206', buyer: '会员甲', total: '¥18.00' },
  ],
  rowKey: (row) => row.id,
  columns: [
    { key: 'order', title: '订单号', render: (row) => row.id },
    { key: 'buyer', title: '买家', render: (row) => row.buyer },
    { key: 'amount', title: '金额', render: (row) => row.total },
    { key: 'note', title: '备注', render: () => '演示备注', defaultVisible: false },
  ],
  storageKey: 'admin-list-fixture:orders:columns',
  total: 245,
  page: 2,
  pageSize: 20,
  onPageChange: () => undefined,
};

export function tableHeadings(): string[] {
  return screen.getAllByRole('columnheader').map((heading) => (heading.textContent ?? '').trim());
}

export function activePage(): string | null {
  const page = document.querySelector('[aria-current="page"], .ant-pagination-item-active');
  return page?.textContent?.trim() ?? null;
}

export const filterFields: FilterBarProps['fields'] = [
  { label: '订单号', kind: 'exact-text', name: 'order' },
  { label: '店铺关键词', kind: 'fuzzy-text', name: 'shop' },
  {
    label: '订单状态',
    kind: 'select',
    name: 'status',
    options: [
      { value: 'paid', label: '已付款' },
      { value: 'settled', label: '已结算' },
    ],
  },
  {
    label: '付款日期',
    kind: 'date-range',
    start: { label: '付款开始日期', name: 'paid_from' },
    end: { label: '付款结束日期', name: 'paid_to' },
  },
  {
    label: '佣金区间',
    kind: 'number-range',
    min: { label: '最低佣金', name: 'min_commission' },
    max: { label: '最高佣金', name: 'max_commission' },
    advanced: true,
  },
];

export const filters = {
  order: '0000123456',
  shop: '咖啡 & 茶',
  status: 'settled',
  paid_from: '2026-11-02',
  paid_to: '2026-11-12',
  min_commission: '0',
  max_commission: '350',
};

export function expectFilterValue(label: string, value: string): void {
  expect(screen.getByLabelText(label)).toHaveProperty('value', value);
}

export const statusItems: StatusTabsProps['items'] = [
  { key: 'paid', label: '已付款', count: 23 },
  { key: 'all', label: '全部' },
  { key: 'refunded', label: '已退款', count: 0 },
];

export const paidFilter = { status: 'paid', min_commission: '0' };
export const paidAmountFen = 9_007_199_254_740_993n;
export const statCards: StatCardsProps['cards'] = [
  { key: 'orders', label: '订单总数', kind: 'number', value: 13 },
  {
    key: 'income',
    label: '付款金额',
    kind: 'money',
    fen: paidAmountFen,
    signed: true,
    filterValue: paidFilter,
  },
  { key: 'commission', label: '预估佣金合计', kind: 'money', fen: null },
  { key: 'members', label: '下单人数', kind: 'number', value: 8 },
  { key: 'settled', label: '已结算单数', kind: 'number', value: 2 },
  { key: 'refunds', label: '退款单数', kind: 'number', value: 1 },
  { key: 'items', label: '售出件数', kind: 'number', value: 7 },
  { key: 'new', label: '新下单人数', kind: 'number', value: 3 },
];

export const shortText = 'ORD-205';
export const longText = 'ABCD-20261123-1234567890-WXYZ';
export const helpText = '预估佣金由平台返回，结算后显示实际金额。';
export const statusMapping = {
  paid: { label: '已付款', color: 'success' },
  failed: { label: '付款失败', color: 'error' },
};

export const product = {
  title: '便携手冲咖啡壶套装附温度计和旅行收纳袋，浅灰色礼盒装',
  imageUrl: '/fixtures/coffee-pot.png',
  platformIconUrl: '/fixtures/shop-platform.svg',
  tags: ['满减商品', '可退换'] as const,
  amountFen: 125_060n,
  commissionRateBp: 1234,
  estimatedCommissionFen: 15_432n,
  shopName: '山丘咖啡器具店',
  paidAtText: '2026-11-23 09:15:30',
} satisfies ProductCellProps;

export function hasSingleLineEllipsis(element: HTMLElement, container: HTMLElement): boolean {
  for (
    let node: HTMLElement | null = element;
    node && container.contains(node);
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    if (style.whiteSpace === 'nowrap' && style.textOverflow === 'ellipsis') return true;
    if (style.getPropertyValue('-webkit-line-clamp') === '1') return true;
  }
  return false;
}

export const member = { uid: '000586942', nickname: '青山会员' };

export const drawerTitle = '查看详情';
export const detailGroups: DetailDrawerProps['groups'] = [
  {
    key: 'order',
    title: '订单信息',
    fields: [
      { key: 'id', label: '订单编号', value: 'ORD-205' },
      { key: 'amount', label: '付款金额', value: '¥20.50' },
    ],
  },
  {
    key: 'member',
    title: '会员信息',
    fields: [
      { key: 'uid', label: '会员 UID', value: null },
      { key: 'points', label: '积分', value: 0 },
    ],
  },
];
