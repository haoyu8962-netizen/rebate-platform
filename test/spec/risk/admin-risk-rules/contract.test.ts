// B1-03zg: the three operations of CT-24f are implemented — no longer planned in the contract or
// in the generated planned list — and keep admin auth.
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/planned-operations.gen.ts';
import { DISABLE, ENABLE, LIST, contract } from './kit.ts';

const OPERATIONS = [
  [LIST, 'get', 'adminListRiskRules'],
  [ENABLE, 'post', 'adminEnableRiskRule'],
  [DISABLE, 'post', 'adminDisableRiskRule'],
] as const;

it.each(OPERATIONS)(
  '[AC-B1-03zg#1] %s %s（%s）去掉 planned，仍是后台鉴权',
  async (path, method, operationId) => {
    const operation = (await contract()).paths[path]?.[method];
    expect(operation).toBeDefined();
    expect(operation).toMatchObject({ operationId, 'x-auth': 'admin' });
    expect(operation?.['x-implementation']).not.toBe('planned');
  },
);

it('[AC-B1-03zg#2] 生成的 planned 清单不再含规则清单三个接口', () => {
  for (const [, , operationId] of OPERATIONS) {
    expect(plannedOperations.has(operationId), operationId).toBe(false);
  }
});
