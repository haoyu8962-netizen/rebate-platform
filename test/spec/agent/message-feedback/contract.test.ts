import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import {
  routeSchemaOf,
  type ContractOperation,
  type ContractParameter,
  type RouteSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { at, contract, endpoints, operation } from '../../contracts/agent-history/kit.ts';

it.each(endpoints)(
  '[AC-B3-08zf#19] %s %s（%s）去未实现标记并同步生成路由校验',
  async (method, path, id) => {
    const doc = await contract();
    const op = operation(doc, method, path);
    expect(op).not.toHaveProperty('x-implementation');
    expect(plannedOperations.has(id)).toBe(false);
    const generated: Readonly<Record<string, RouteSchema>> = CONTRACT_ROUTE_SCHEMAS;
    expect(Object.hasOwn(generated, id)).toBe(true);
    const parameters = at(doc, 'paths', path)['parameters'] as
      readonly ContractParameter[] | undefined;
    expect(generated[id]).toEqual(routeSchemaOf(op as unknown as ContractOperation, parameters));
  },
);
