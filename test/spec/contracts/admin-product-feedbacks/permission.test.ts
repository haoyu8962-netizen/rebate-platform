// CT-26x 权限点 feedback.view 的登记：枚举、step-up 清单与生成物（任务书第 9 节第 1、7 项）。
// 静态读 contracts、specs 与生成物，不连库、不 listen。
import { expect, it } from 'vitest';
import { ADMIN_PERMISSIONS } from '../../../../apps/api/src/modules/admin/domain/permissions.gen.ts';
import { plannedOperations } from '../../../../packages/contracts-ts/src/planned-operations.gen.ts';
import { text, yaml } from '../admin-order-actions/kit.ts';
import { adminPermissionValues, operationId, permission, permissionEntries } from './kit.ts';

// 主干上的 specs/permissions.yaml 版本号；新增权限点后须递增。
const baseVersion = 4;

type GeneratedCatalog = {
  version: string;
  permissions: readonly {
    key: string;
    step_up_tier: string | null;
    operations: readonly unknown[];
  }[];
};

// 权限点的键带点号：不经 at()（toHaveProperty 会把点号当路径），取键名再比较。
it('[AC-CT-26x#1] 枚举 admin_permission 登记 feedback.view，中文说明为商品反馈只读查看、不标 step-up', () => {
  const values = adminPermissionValues();
  expect(Object.keys(values)).toContain(permission);
  const label = text(values[permission]);
  expect(label).toContain('商品反馈');
  expect(label).toContain('只读');
  expect(label).not.toMatch(/step-up|二次验证|动态码|短信/i);
});

it('[AC-CT-26x#2] specs/permissions.yaml 恰有一条 feedback.view（无 step-up、无例外操作），键序与枚举一致，版本号递增', () => {
  const entries = permissionEntries();
  expect(entries.filter((entry) => entry['key'] === permission)).toEqual([
    { key: permission, step_up_tier: null, operations: [] },
  ]);
  expect(entries.map((entry) => entry['key'])).toEqual(Object.keys(adminPermissionValues()));
  const version = Number(text(yaml('specs/permissions.yaml')['version']));
  expect(Number.isInteger(version)).toBe(true);
  expect(version).toBeGreaterThan(baseVersion);
});

it('[AC-CT-26x#3] 生成的权限快照 permissions.gen.ts 含 feedback.view（无 step-up），版本与 YAML 一致', () => {
  const generated: GeneratedCatalog = ADMIN_PERMISSIONS;
  expect(generated.permissions.filter((entry) => entry.key === permission)).toEqual([
    { key: permission, step_up_tier: null, operations: [] },
  ]);
  expect(generated.version).toBe(text(yaml('specs/permissions.yaml')['version']));
});

it('[AC-CT-26x#4] 生成的 planned 清单不含 adminListProductFeedbacks（已实现，不再 planned）', () => {
  expect(plannedOperations.has(operationId)).toBe(false);
});
