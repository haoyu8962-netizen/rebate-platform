// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import type { Grants } from '../admin-adjustments-readonly/fixtures.ts';
import {
  ADJUSTMENT_ORDER,
  ALL_FUND,
  COLUMN,
  PENDING,
  READ_TEXT,
  SUPER_ADMIN,
  TEXT,
  WRITEOFF_ORDER,
  createWriteoffServer,
  snapshotOf,
} from './fixtures.ts';
import {
  buttons,
  mount,
  ready,
  rowOf,
  rowsWithApprove,
  settled,
  tabNames,
  usable,
  waitColumn,
} from './helpers.ts';

// Reverse of the entry cases (编排 D10-1733): an account without fund.writeoff never sees
// 【批准核销】 anywhere (the 坏账核销 rows included when fund.view shows the tab); every account
// holding fund.writeoff (with any other fund point) and the super admin sees exactly one usable
// 【批准核销】 on each PENDING row.

/** No 【批准核销】 anywhere on the page. */
function noEntry(label: string): void {
  expect(buttons(document.body, TEXT.approveEntry), label).toEqual([]);
}

/** fund.view without fund.writeoff: the 坏账核销 tab is read but offers no entry. */
async function readsWithout(points: Grants): Promise<void> {
  const label = points.join('+');
  const server = createWriteoffServer({ permissions: points });
  await ready(server, snapshotOf(points));
  expect(rowsWithApprove(WRITEOFF_ORDER), label).toEqual([]);
  noEntry(label);
  expect(server.others(), label).toEqual([]);
  cleanup();
}

/** Mounts as `snapshot` and checks one usable 【批准核销】 on each PENDING row. */
async function withEntries(points: Grants, snapshot: PermissionSnapshot): Promise<void> {
  const label = snapshot.isSuper ? 'super' : points.join('+');
  const server = createWriteoffServer({ permissions: points });
  await ready(server, snapshot);
  expect(rowsWithApprove(WRITEOFF_ORDER), label).toEqual(PENDING);
  for (const id of PENDING) {
    expect(usable(rowOf(id), TEXT.approveEntry), `${label} ${id}`).toHaveLength(1);
    expect(buttons(rowOf(id), TEXT.approveEntry), `${label} ${id}`).toHaveLength(1);
  }
  expect(server.others(), label).toEqual([]);
  cleanup();
}

it(
  '[AC-F1-08cd-ENTRY#4] 没有 fund.writeoff：只持 fund.view、持 fund.view + fund.adjust 时坏账核销页签可读但任何行都没有【批准核销】（不置灰，直接不出现）；只持 fund.adjust 时只有调账单页签、页面上没有【批准核销】；都不发写请求；同一页面换成只持 fund.writeoff 的账号才出现',
  { timeout: 180_000 },
  async () => {
    const readers: readonly Grants[] = [['fund.view'], ['fund.view', 'fund.adjust']];
    for (const points of readers) await readsWithout(points);

    const adjuster = createWriteoffServer({ permissions: ['fund.adjust'] });
    await mount(adjuster, snapshotOf(['fund.adjust']));
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(adjuster);
    expect(tabNames()).toEqual([READ_TEXT.adjustmentsTab]);
    noEntry('fund.adjust');
    expect(adjuster.others()).toEqual([]);
    cleanup();

    await withEntries(['fund.writeoff'], snapshotOf(['fund.writeoff']));
  },
);

it(
  '[AC-F1-08cd-ENTRY#5] 持 fund.writeoff 的各种组合（+ fund.view、+ fund.adjust、三项全持）与超管：两张待批准候选单的行上各恰 1 个可用【批准核销】，其余行没有',
  { timeout: 240_000 },
  async () => {
    const combos: readonly Grants[] = [
      ['fund.writeoff', 'fund.view'],
      ['fund.writeoff', 'fund.adjust'],
      ALL_FUND,
    ];
    for (const points of combos) await withEntries(points, snapshotOf(points));
    await withEntries(ALL_FUND, SUPER_ADMIN);
  },
);
