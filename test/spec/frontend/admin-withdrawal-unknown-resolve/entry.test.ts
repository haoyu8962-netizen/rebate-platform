// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import {
  EXECUTE,
  SUPER,
  assertEntries,
  assertNoEntries,
  assertNoOtherActions,
  buttons,
  main,
  mount,
  serverFor,
  unknownPayout,
  type Withdrawal,
} from './helpers.ts';

const OTHER_STATUSES = [
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'PAID_API',
  'PAID_MANUAL',
  'FAILED',
] as const;

it(
  '[AC-F1-08aj-ENTRY#1] 结果未知转人工的单：只持 withdraw.review / fund.view / 线下补录点时没有【立即查询】【人工处置】；持 payout.execute 或超管时两个入口都可用，不点不发写请求',
  { timeout: 120_000 },
  async () => {
    const without: PermissionSnapshot[] = [
      {
        isSuper: false,
        permissions: ['withdraw.review'],
        stepUp: { 'withdraw.review': { tier: 'totp', operations: {} } },
      },
      { isSuper: false, permissions: ['fund.view'], stepUp: {} },
      {
        isSuper: false,
        permissions: ['withdraw.review', 'fund.view', 'payout.manual_entry'],
        stepUp: { 'payout.manual_entry': { tier: 'totp', operations: {} } },
      },
    ];
    for (const permissions of without) {
      const server = serverFor();
      await mount(server, permissions);
      assertNoEntries(permissions.permissions.join('+'));
      expect(server.writes()).toEqual([]);
      cleanup();
    }
    const holders: PermissionSnapshot[] = [
      EXECUTE,
      SUPER,
      {
        isSuper: false,
        permissions: ['withdraw.review', 'payout.execute'],
        stepUp: { 'payout.execute': { tier: 'totp', operations: {} } },
      },
    ];
    for (const permissions of holders) {
      const server = serverFor();
      await mount(server, permissions);
      assertEntries();
      assertNoOtherActions();
      expect(server.writes()).toEqual([]);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08aj-ENTRY#2] 入口只看 PAYING 且 needs_manual=true：未转人工的打款中单、其余各状态（含已处置的 needs_manual 单）、付款方侧失败退回的已通过单都没有入口；转人工的单有入口且没有执行打款、手动成功、撤销、重新计算、上传',
  { timeout: 150_000 },
  async () => {
    const payerSide: Withdrawal = {
      ...unknownPayout('APPROVED', false),
      hold_reason: 'payer_side_after_transfer',
      hold_at: '2026-11-12T10:00:10+08:00',
      executor_id: null,
      executed_at: null,
    };
    const items: Withdrawal[] = [unknownPayout('PAYING', false)];
    for (const status of OTHER_STATUSES) items.push(unknownPayout(status, true));
    items.push(payerSide);
    for (const item of items) {
      const server = serverFor(item);
      await mount(server, SUPER);
      assertNoEntries(`${item.status} needs_manual=${String(item.needs_manual)}`);
      expect(server.writes()).toEqual([]);
      cleanup();
    }
    const server = serverFor();
    await mount(server, EXECUTE);
    assertEntries();
    assertNoOtherActions();
    expect(buttons(main(), '审核通过')).toEqual([]);
    expect(buttons(main(), '驳回')).toEqual([]);
    expect(server.writes()).toEqual([]);
  },
);
