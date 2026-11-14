// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
import { expect, it } from 'vitest';
import type {
  KnownPermission,
  PermissionSnapshot,
  StepUpAnnotation,
} from '../../../../apps/admin/src/providers/access-control/index.ts';
import type { Grants } from '../admin-adjustments-readonly/fixtures.ts';
import {
  ADJ,
  ADJUSTMENT_ORDER,
  ALL_FUND,
  SUPER_ADMIN,
  TEXT,
  createApproveServer,
} from './fixtures.ts';
import { buttons, drawer, openDetail, ready, rowOf, rowsWithApprove, usable } from './helpers.ts';

// Reverse of the entry cases (编排 D10-1733): an account without fund.adjust never sees 【批准】 on
// the PENDING form (list row or detail) nor the dialog's 【驳回】【批准并短信验证】; every account
// holding fund.adjust (with any other fund point) and the super admin sees exactly one usable
// 【批准】 on the PENDING row and in its detail.

/** A non-super snapshot of `points` (fund.adjust carries the sms tier, the others none). */
function snapshotOf(points: Grants): PermissionSnapshot {
  const stepUp: Partial<Record<KnownPermission, StepUpAnnotation>> = {};
  for (const point of points)
    stepUp[point] = { tier: point === 'fund.adjust' ? 'sms' : null, operations: {} };
  return { isSuper: false, permissions: points, stepUp };
}

/** None of 【批准】【驳回】【批准并短信验证】 anywhere on the page. */
function noDecisionEntries(label: string): void {
  expect(buttons(document.body, TEXT.approveEntry), label).toEqual([]);
  expect(buttons(document.body, TEXT.reject), label).toEqual([]);
  expect(buttons(document.body, TEXT.approve), label).toEqual([]);
}

/** Mounts with `points` and checks that the PENDING form offers no decision (row and detail). */
async function withoutEntries(points: Grants): Promise<void> {
  const label = points.join('+');
  const server = createApproveServer({ permissions: points });
  await ready(server, ADJUSTMENT_ORDER, snapshotOf(points));
  expect(rowsWithApprove(ADJUSTMENT_ORDER), label).toEqual([]);
  noDecisionEntries(label);
  await openDetail(server, ADJ.prefilled);
  noDecisionEntries(label);
  expect(server.others(), label).toEqual([]);
  cleanup();
}

/** Mounts as `snapshot` and checks one usable 【批准】 on the PENDING row and in its detail. */
async function withEntries(points: Grants, snapshot: PermissionSnapshot): Promise<void> {
  const label = snapshot.isSuper ? 'super' : points.join('+');
  const server = createApproveServer({ permissions: points });
  await ready(server, ADJUSTMENT_ORDER, snapshot);
  expect(rowsWithApprove(ADJUSTMENT_ORDER), label).toEqual([ADJ.prefilled]);
  expect(usable(rowOf(ADJ.prefilled), TEXT.approveEntry), label).toHaveLength(1);
  expect(buttons(rowOf(ADJ.prefilled), TEXT.approveEntry), label).toHaveLength(1);
  await openDetail(server, ADJ.prefilled);
  expect(usable(drawer(), TEXT.approveEntry), label).toHaveLength(1);
  expect(buttons(drawer(), TEXT.approveEntry), label).toHaveLength(1);
  expect(server.others(), label).toEqual([]);
  cleanup();
}

it(
  '[AC-F1-08cc-ENTRY#6] 没有 fund.adjust：只持 fund.view、持 fund.view + fund.writeoff 时，待批准行与其详情都没有【批准】【驳回】【批准并短信验证】（不置灰，直接不出现），也不发任何写请求；同一页面换成只持 fund.adjust 的账号才出现',
  { timeout: 180_000 },
  async () => {
    const without: readonly Grants[] = [['fund.view'], ['fund.view', 'fund.writeoff']];
    for (const points of without) await withoutEntries(points);
    await withEntries(['fund.adjust'], snapshotOf(['fund.adjust']));
  },
);

it(
  '[AC-F1-08cc-ENTRY#7] 持 fund.adjust 的各种组合（+ fund.view、+ fund.writeoff、三项全持）与超管：待批准行与其详情各恰 1 个可用【批准】，其余行没有',
  { timeout: 240_000 },
  async () => {
    const combos: readonly Grants[] = [
      ['fund.adjust', 'fund.view'],
      ['fund.adjust', 'fund.writeoff'],
      ALL_FUND,
    ];
    for (const points of combos) await withEntries(points, snapshotOf(points));
    await withEntries(ALL_FUND, SUPER_ADMIN);
  },
);
