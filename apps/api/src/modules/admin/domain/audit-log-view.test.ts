import { expect, it } from 'vitest';
import {
  deriveAudit,
  permissionMatch,
  systemActorName,
  targetIdMatch,
  targetTypeMatch,
  type AuditCondition,
} from './audit-log-view.ts';

const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
const CONFIG = new Map([
  ['external_page.union_host_block', 'config.risk'],
  ['growth.example', 'config.business'],
  ['broken.example', 'not.a.point'],
]);

/** Evaluates a plan the way the SQL side does, to check derivation and filters agree. */
function matches(
  plans: readonly AuditCondition[],
  row: { action: string; target: string | null; after: unknown },
): boolean {
  return plans.some((plan) => {
    if (!plan.actions.includes(row.action)) return false;
    switch (plan.kind) {
      case 'actions':
        return true;
      case 'targetEquals':
        return row.target === plan.target;
      case 'targetIn':
        return row.target !== null && plan.targets.includes(row.target);
      case 'target': {
        const prefix = plan.prefix ?? '';
        if (row.target === null || !row.target.startsWith(prefix)) return false;
        const length = Array.from(row.target).length;
        return length > prefix.length && length <= prefix.length + 128;
      }
      case 'afterField': {
        const after = row.after as Record<string, unknown> | null;
        if (typeof after !== 'object' || after === null || Array.isArray(after)) return false;
        const value = after[plan.field];
        return typeof value === 'string' && plan.values.includes(value);
      }
    }
  });
}

const ROWS = [
  { action: 'admin.login', target: `admin_users:${USER}`, after: null },
  { action: 'admin.login', target: 'admin_users:', after: null },
  { action: 'admin.login', target: USER, after: null },
  { action: 'user_risk_state_change', target: USER, after: { action: 'ban' } },
  { action: 'user_risk_state_change', target: USER, after: { action: 'unfreeze' } },
  { action: 'user_risk_state_change', target: USER, after: { action: ['ban'] } },
  { action: 'user_risk_state_change', target: USER, after: ['ban'] },
  { action: 'user_risk_state_change', target: 'x'.repeat(129), after: { action: 'ban' } },
  { action: 'user_pii_reveal', target: USER, after: { field: 'phone' } },
  { action: 'config_item_change', target: 'external_page.union_host_block', after: null },
  { action: 'config_item_rollback', target: 'growth.example', after: null },
  { action: 'config_item_change', target: 'broken.example', after: null },
  { action: 'config_item_change', target: 'external_page.unregistered', after: null },
  { action: 'kill_switch_change', target: 'withdraw.enabled', after: null },
  { action: 'export_unmasked', target: `export_tasks:${USER}`, after: { resource: 'users' } },
  { action: 'export_unmasked', target: `export_tasks:${USER}`, after: { resource: 'orders' } },
  { action: 'export_create', target: `export_tasks:${USER}`, after: null },
  { action: 'claim_item_reject', target: `claim_items:${USER}`, after: null },
  { action: 'union.account.register', target: `union_accounts:${USER}`, after: null },
  { action: 'union_binding_enable', target: USER, after: null },
  { action: 'legacy.no_object', target: null, after: 7 },
  { action: 'legacy.no_object', target: `admin_users:${USER}`, after: null },
];

it('[AC-B1-34a] derives target and permission from the action table; the rest is null', () => {
  const derive = (index: number) => deriveAudit(ROWS[index]!, CONFIG);
  expect(derive(0)).toEqual({ targetType: 'admin_user', targetId: USER, permission: null });
  expect(derive(1)).toEqual({ targetType: null, targetId: null, permission: null });
  expect(derive(2)).toEqual({ targetType: null, targetId: null, permission: null });
  expect(derive(3)).toEqual({ targetType: 'user', targetId: USER, permission: 'risk.ban' });
  expect(derive(4).permission).toBe('risk.freeze');
  expect(derive(5).permission).toBeNull();
  expect(derive(6).permission).toBeNull();
  expect(derive(7)).toEqual({ targetType: null, targetId: null, permission: 'risk.ban' });
  expect(derive(8).permission).toBe('pii.reveal_phone');
  expect(derive(9)).toMatchObject({ targetType: 'config_item', permission: 'config.risk' });
  expect(derive(10).permission).toBe('config.business');
  expect(derive(11).permission).toBeNull();
  expect(derive(12).permission).toBeNull();
  expect(derive(13)).toMatchObject({ targetType: 'switch', permission: null });
  expect(derive(14)).toMatchObject({ targetType: 'export_task', permission: 'pii.reveal_phone' });
  expect(derive(15).permission).toBeNull();
  expect(derive(16).permission).toBe('export');
  expect(derive(17)).toMatchObject({ targetType: 'claim_item', permission: 'order.claim' });
  expect(derive(18)).toMatchObject({ targetType: 'union_account', permission: null });
  expect(derive(19)).toMatchObject({ targetType: 'user', permission: 'union.binding_disable' });
  expect(derive(20)).toEqual({ targetType: null, targetId: null, permission: null });
  expect(derive(21)).toEqual({ targetType: null, targetId: null, permission: null });
});

it('[AC-B1-34a] every filter plan matches exactly the rows whose derived value equals it', () => {
  const derived = ROWS.map((row) => deriveAudit(row, CONFIG));
  const values = (pick: (d: (typeof derived)[number]) => string | null) => [
    ...new Set(derived.map(pick).filter((v): v is string => v !== null)),
  ];
  const check = (
    plansOf: (value: string) => AuditCondition[],
    pick: (d: (typeof derived)[number]) => string | null,
    extra: string[],
  ) => {
    for (const value of [...values(pick), ...extra]) {
      const plans = plansOf(value);
      ROWS.forEach((row, index) => {
        expect([value, index, matches(plans, row)]).toEqual([
          value,
          index,
          pick(derived[index]!) === value,
        ]);
      });
    }
  };
  check(targetTypeMatch, (d) => d.targetType, ['use', 'User', 'nothing']);
  check(targetIdMatch, (d) => d.targetId, ['null', USER.slice(0, -1), 'x'.repeat(129)]);
  check(
    (p) => permissionMatch(p, CONFIG),
    (d) => d.permission,
    ['switch.all', 'switch.payout', 'config.general', 'audit.view_all'],
  );
  expect(permissionMatch('invented.permission', CONFIG)).toEqual([]);
  expect(permissionMatch('not.a.point', CONFIG)).toEqual([]);
});

it('[AC-B1-34p] order_auto_hold derives the order and no point; order_hold stays underived', () => {
  const record = { action: 'order_auto_hold', target: `orders:${USER}`, after: null };
  expect(deriveAudit(record, CONFIG)).toEqual({
    targetType: 'order',
    targetId: USER,
    permission: null,
  });
  expect(matches(targetTypeMatch('order'), record)).toBe(true);
  expect(matches(targetIdMatch(USER), record)).toBe(true);
  expect(deriveAudit({ ...record, action: 'order_hold' }, CONFIG)).toEqual({
    targetType: null,
    targetId: null,
    permission: null,
  });
});

it('[AC-B1-34p] the enum names a system identity; anything else has no name', () => {
  expect(systemActorName('system:risk')).toBe('系统（风控）');
  expect(systemActorName('system:new_engine')).toBeNull();
  expect(systemActorName('toString')).toBeNull();
});
