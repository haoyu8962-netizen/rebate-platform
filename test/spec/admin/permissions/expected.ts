import { readFileSync } from 'node:fs';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import type { AdminPermissionDefinition } from '../../../../apps/api/src/modules/admin/domain/permission-catalog.ts';

export const ROOT = new URL('../../../../', import.meta.url);

// Independent oracle: F1-06l §9.1, not the implementation's YAML or generated snapshot.
export const TOTP = [
  'pii.reveal_phone',
  'pii.reveal_identity',
  'content.agreement',
  'content.fund_terms',
  'config.risk',
  'config.business',
  'switch.all',
  'switch.payout',
  'switch.pay',
  'risk.freeze',
  'risk.ban',
  'risk.blocklist',
  'union.binding_reset',
  'union.binding_disable',
  'union.account_auth',
  'union.pid',
  'user.level',
  'user.inviter',
  'user.realname_fix',
  'user.phone_change',
  'user.data_export',
  'order.assign',
  'order.restore',
  'withdraw.review',
  'payout.execute',
  'pay.resolve',
  'payout.manual_entry',
  'settle.bill',
  'fund.settle_adjust',
  'fund.cash_entry',
  'tax.export_full',
  // 04 §11.2 notify.channels（动态码，D10-316）：枚举含它才纳入。CT-24t 合并后可去掉该条件。
  ...(enumKeys().includes('notify.channels') ? ['notify.channels'] : []),
];
export const SMS = ['fund.adjust', 'fund.writeoff'];
export const NONE = [
  // 04 §11.1 工作台（step-up「–」）：枚举含 dashboard.view 才纳入。CT-24a 合并后由 CT-24j 去掉该条件。
  ...(enumKeys().includes('dashboard.view') ? ['dashboard.view'] : []),
  'user.list',
  'user.lookup',
  'fund.view',
  'audit.view_all',
  'export',
  'feedback.view',
  'content.page',
  'content.pool',
  'content.article',
  'content.poster',
  'content.platform_icon',
  'config.general',
  'risk.appeal',
  'order.view',
  'order.claim',
  'order.hold',
  'pay.view',
  'pay.refund',
  'settle.statement_upload',
  'agent.trace',
  'agent.report',
];
export const SPECIAL: AdminPermissionDefinition[] = [
  {
    key: 'content.app_version',
    step_up_tier: null,
    operations: [{ operation: 'content.app_version.raise_min_supported_version', tier: 'totp' }],
  },
  {
    key: 'fund.recon',
    step_up_tier: null,
    operations: [{ operation: 'fund.recon.balance_recalc', tier: 'sms' }],
  },
];

export function enumKeys(): string[] {
  const doc = parseYamlLite(readFileSync(new URL('contracts/enums/admin.yaml', ROOT), 'utf8')) as {
    enums: { admin_permission: { values: Record<string, string> } };
  };
  return Object.keys(doc.enums.admin_permission.values);
}

export function expectedCatalog(): AdminPermissionDefinition[] {
  return [
    ...TOTP.map((key) => ({ key, step_up_tier: 'totp' as const, operations: [] })),
    ...SMS.map((key) => ({ key, step_up_tier: 'sms' as const, operations: [] })),
    ...NONE.map((key) => ({ key, step_up_tier: null, operations: [] })),
    ...SPECIAL,
  ];
}

export function expectedGrants(keys: readonly string[]) {
  const wanted = new Set(keys);
  return enumKeys()
    .filter((key) => wanted.has(key))
    .map((key) => {
      const rule = expectedCatalog().find((item) => item.key === key)!;
      return { key, step_up_tier: rule.step_up_tier, step_up_operations: rule.operations };
    });
}

// Do not pull Nest decorators into the erasable-only rule-test TypeScript project.
export async function adminSurface() {
  return (await import(
    new URL('apps/api/src/modules/admin/index.ts', ROOT).href
  )) as typeof import('../../../../apps/api/src/modules/admin/application/permission-guard.ts') &
    typeof import('../../../../apps/api/src/modules/admin/domain/permission-catalog.ts');
}
