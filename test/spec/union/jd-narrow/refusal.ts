// B1-04zt: the refusal the real jd adapter raises for an inner code, over a fake transport. The rule
// tests never build the flag themselves: how UnionError takes it, and where the adapter sets it, are
// the implementation's to choose. Fake adapters on the orders side throw what this returns.
import { expect } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { ctx, inner, num, reply, win, wire } from '../jd-orders/kit.ts';

/**
 * windowTooLarge is not declared before the implementation, and the rule tests must compile and fail
 * on an assertion then: reading it through this type is what keeps the missing field a red, not a
 * type error.
 */
export type Flagged = UnionError & { readonly windowTooLarge?: boolean };

export async function jdRefusal(code: string): Promise<Flagged> {
  const { adapter } = wire(() => reply(inner([], false, num(code))));
  const outcome: unknown = await adapter.listOrders(win, {}, ctx).catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(UnionError);
  return outcome as Flagged;
}
