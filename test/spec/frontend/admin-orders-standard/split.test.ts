// @vitest-environment jsdom
import { formatYuanAdmin, mulDivFloor } from '@couli/money';
import { within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DETAIL, LIST, ROUTE, createServer, detail } from '../admin-orders/orders-fixtures.ts';
import { FLOW_TIMEOUT, loaded, mount, section } from '../admin-orders/orders-helpers.ts';
import {
  BENEFICIARIES,
  BENEFICIARIES_WITHOUT_INDIRECT,
  SPLIT_BASE_FEN,
  splitDetail,
} from './kit.ts';

const CREDITED_BEIJING = /2026-10-16\s*01:42(?::18)?(?![:\d])/;
const RATIOS: Readonly<Record<number, string>> = {
  2500: '25.00%',
  5075: '50.75%',
  1000: '10.00%',
  1250: '12.50%',
  175: '1.75%',
};

type Beneficiary = (typeof BENEFICIARIES)[number];
type Role = Beneficiary['role'];

const ROLE_TITLES = [
  ['self', '本人自购'],
  ['share', '分享者'],
  ['direct', '直推上级'],
  ['indirect', '间推上级'],
] as const satisfies readonly (readonly [Role, string])[];

function beneficiaryLine(scope: HTMLElement, beneficiary: Beneficiary, status = ''): HTMLElement {
  const { user_id: userId, ratio_bp: ratioBp } = beneficiary;
  const matches = within(scope).queryAllByText(userId, { exact: true });
  expect(matches, `受益人 ${userId}`).toHaveLength(1);
  let node: HTMLElement | null = matches[0]!;
  while (node !== null && node !== scope) {
    const text = node.textContent ?? '';
    if (BENEFICIARIES.some((other) => other.user_id !== userId && text.includes(other.user_id)))
      break;
    if (text.includes(RATIOS[ratioBp]!) && text.includes(status)) return node;
    node = node.parentElement;
  }
  return expect.fail(`受益人 ${userId} 缺少独立的明细行`);
}

function expectForfeit(line: HTMLElement, beneficiary: Beneficiary): void {
  const tags = within(line).queryAllByText('已没收', { exact: true });
  expect(tags).toHaveLength(beneficiary.forfeit_reason === null ? 0 : 1);
}

function expectRoleGroups(
  split: HTMLElement,
  lines: readonly { line: HTMLElement; beneficiary: Beneficiary }[],
): void {
  expect(new Set(lines.map(({ line }) => line)).size).toBe(lines.length);
  const headings = ROLE_TITLES.flatMap(([role, title]) => {
    const matches = within(split).queryAllByText(title, { exact: true });
    const hasBeneficiaries = lines.some(({ beneficiary }) => beneficiary.role === role);
    expect(matches, `「${title}」分组标题`).toHaveLength(hasBeneficiaries ? 1 : 0);
    return matches.map((heading) => ({ role, title, heading }));
  });

  for (const [index, { role, title, heading }] of headings.entries()) {
    const next = headings[index + 1];
    if (next !== undefined) {
      expect(
        heading.compareDocumentPosition(next.heading) & Node.DOCUMENT_POSITION_FOLLOWING,
        `「${title}」在「${next.title}」之前`,
      ).toBeTruthy();
    }

    let group = heading;
    while (group !== split) {
      const parent = group.parentElement;
      if (parent === null) break;
      const hasOtherTitle = headings.some(
        (other) => other.heading !== heading && parent.contains(other.heading),
      );
      if (hasOtherTitle) break;
      group = parent;
    }
    for (const { line, beneficiary } of lines) {
      const message = `「${title}」分组是否包含受益人 ${beneficiary.user_id}`;
      expect(group.contains(line), message).toBe(beneficiary.role === role);
    }
  }
}

async function expectUnsettled(
  status: 'ESTIMATED' | 'WAITING',
  beneficiaries = BENEFICIARIES,
): Promise<void> {
  await mount(createServer(undefined, splitDetail(status, beneficiaries)), ROUTE);
  await loaded();
  const split = section('分佣明细');
  const lines = beneficiaries.map((beneficiary) => {
    const line = beneficiaryLine(split, beneficiary, '未结算');
    expect(line.textContent).toContain('未结算');
    expect(line.textContent).not.toContain('已结算');
    expectForfeit(line, beneficiary);
    return { line, beneficiary };
  });
  expectRoleGroups(split, lines);
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
    const lines = BENEFICIARIES.map((beneficiary) => {
      const snapshotLine = beneficiaryLine(snapshot, beneficiary);
      expect(snapshotLine.textContent).toContain(RATIOS[beneficiary.ratio_bp]);
      const line = beneficiaryLine(split, beneficiary, '已结算');
      expect(line.textContent).toContain('已结算');
      expect(line.textContent).toMatch(CREDITED_BEIJING);
      expectForfeit(line, beneficiary);
      return { line, beneficiary };
    });
    expectRoleGroups(split, lines);

    const text = split.textContent?.replaceAll(',', '');
    for (const { ratio_bp } of BENEFICIARIES) {
      const shareFen = mulDivFloor(BigInt(SPLIT_BASE_FEN), BigInt(ratio_bp), 10_000n);
      const yuan = formatYuanAdmin(shareFen).replace(/[^\d.]/g, '');
      const integerYuan = yuan.split('.')[0]!;
      for (const amount of [yuan, shareFen.toString(), integerYuan]) {
        expect(text, `不得展示推算金额 ${amount}`).not.toContain(amount);
      }
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
  '[AC-F1-07ed-SPLIT#3] WAITING 受益人逐行显示未结算和各自的没收标记，未出现的角色没有分组',
  async () => expectUnsettled('WAITING', BENEFICIARIES_WITHOUT_INDIRECT),
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
