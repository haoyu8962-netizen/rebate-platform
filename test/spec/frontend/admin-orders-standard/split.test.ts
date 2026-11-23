// @vitest-environment jsdom
import { formatYuanAdmin, mulDivFloor } from '@couli/money';
import { within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DETAIL, LIST, ROUTE, createServer, detail } from '../admin-orders/orders-fixtures.ts';
import { FLOW_TIMEOUT, loaded, mount, section } from '../admin-orders/orders-helpers.ts';
import { BENEFICIARIES, SPLIT_BASE_FEN, splitDetail } from './kit.ts';

const CREDITED_BEIJING = /2026-10-16\s*01:42(?::18)?(?![:\d])/;
const ratios = ['25.00%', '50.75%', '10.00%', '12.50%', '1.75%'];

function beneficiaryLine(scope: HTMLElement, index: number, status = ''): HTMLElement {
  const userId = BENEFICIARIES[index]!.user_id;
  const matches = within(scope).queryAllByText(userId, { exact: true });
  expect(matches, `受益人 ${userId}`).toHaveLength(1);
  let node: HTMLElement | null = matches[0]!;
  while (node !== null && node !== scope) {
    const text = node.textContent ?? '';
    if (BENEFICIARIES.some((other) => other.user_id !== userId && text.includes(other.user_id)))
      break;
    if (text.includes(ratios[index]!) && text.includes(status)) return node;
    node = node.parentElement;
  }
  return expect.fail(`受益人 ${userId} 缺少独立的明细行`);
}

function expectForfeit(line: HTMLElement, index: number): void {
  const tags = within(line).queryAllByText('已没收', { exact: true });
  expect(tags).toHaveLength(BENEFICIARIES[index]!.forfeit_reason === null ? 0 : 1);
}

async function expectUnsettled(status: 'ESTIMATED' | 'WAITING'): Promise<void> {
  await mount(createServer(undefined, splitDetail(status)), ROUTE);
  await loaded();
  const split = section('分佣明细');
  BENEFICIARIES.forEach((_, index) => {
    const line = beneficiaryLine(split, index, '未结算');
    expect(line.textContent).toContain('未结算');
    expect(line.textContent).not.toContain('已结算');
    expectForfeit(line, index);
  });
}

it(
  '[AC-F1-07ed-SPLIT#1] 整页详情保留快照，明细按角色归组并逐行显示同格式比例、已结算和北京入账时间',
  async () => {
    const { server } = await mount(createServer(undefined, splitDetail('CREDITED')), ROUTE);
    await loaded();
    expect(window.location.pathname).toBe(ROUTE);
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
    expect(server.requests('GET', LIST)).toHaveLength(0);
    const snapshot = section('分佣快照');
    const split = section('分佣明细');
    expect(snapshot).not.toBe(split);
    const lines = BENEFICIARIES.map((_, index) => {
      expect(beneficiaryLine(snapshot, index).textContent).toContain(ratios[index]!);
      const line = beneficiaryLine(split, index, '已结算');
      expect(line.textContent).toContain('已结算');
      expect(line.textContent).toMatch(CREDITED_BEIJING);
      expectForfeit(line, index);
      return { line, role: BENEFICIARIES[index]!.role };
    });
    expect(new Set(lines.map(({ line }) => line)).size).toBe(BENEFICIARIES.length);
    lines.sort(({ line: left }, { line: right }) =>
      (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING) === 0 ? 1 : -1,
    );
    const direct = lines.flatMap(({ role }, index) => (role === 'direct' ? [index] : []));
    expect(direct).toHaveLength(2);
    expect(direct[1]).toBe(direct[0]! + 1);

    const text = split.textContent?.replaceAll(',', '');
    for (const { ratio_bp } of BENEFICIARIES) {
      const shareFen = mulDivFloor(BigInt(SPLIT_BASE_FEN), BigInt(ratio_bp), 10_000n);
      const yuan = formatYuanAdmin(shareFen).replace(/[^\d.]/g, '');
      expect(text, `不得展示推算金额 ${yuan}`).not.toContain(yuan);
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07ed-SPLIT#2] ESTIMATED 订单的受益人逐行显示未结算，没收标记独立显示',
  async () => expectUnsettled('ESTIMATED'),
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07ed-SPLIT#3] WAITING 订单的受益人逐行显示未结算，没收标记独立显示',
  async () => expectUnsettled('WAITING'),
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07ed-SPLIT#4] 分佣快照为空时明细展示暂无分佣明细',
  async () => {
    await mount(createServer(undefined, detail({ commission_split: null })), ROUTE);
    await loaded();
    expect(section('分佣明细').textContent).toContain('暂无分佣明细');
  },
  FLOW_TIMEOUT,
);
