// B1-10w contract rule test (claude-independent, SPEC_REF 00959234): once implemented,
// adminGetDashboard (GET /admin/v1/dashboard) is no longer planned — the operation in
// contracts/openapi.yaml carries no `x-implementation`, and the generated planned list
// (packages/contracts-ts/src/planned-operations.gen.ts) does not hold it (task brief §9 item 8).
// Static: reads the contract and the generated file only. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/planned-operations.gen.ts';
import { contract, op } from '../../contracts/admin-order-actions/kit.ts';

it('[AC-B1-10w#12] 契约去 planned：GET /admin/v1/dashboard（adminGetDashboard）不再带 x-implementation，生成的 planned 清单不含 adminGetDashboard', () => {
  const operation = op(contract(), '/admin/v1/dashboard', 'get');
  expect(operation['operationId']).toBe('adminGetDashboard');
  expect(operation['x-implementation']).not.toBe('planned');
  expect(operation).not.toHaveProperty('x-implementation');
  expect(plannedOperations.has('adminGetDashboard')).toBe(false);
});
