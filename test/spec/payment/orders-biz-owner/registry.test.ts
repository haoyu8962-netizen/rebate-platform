// B2-15z rule tests of the business type registry (claude-independent, SPEC_REF deaba4fb; ruling
// D10-1030 ②, D10-1155 ①): every registered type has the ownership hook; the non-production test
// type has no real business objects, so its hook is true for any input. Top-level it() only
// (规划/11 §4.3).
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  createBizRegistry,
  type BizPriceInput,
  type BizTypeEntry,
} from '../../../../apps/api/src/modules/payment/application/biz-registry.ts';

type OwnedBy = (input: BizPriceInput) => Promise<boolean>;

/** The hook of an entry, asserted to be a function first (read as unknown: no call on undefined). */
function ownedByOf(entry: BizTypeEntry): OwnedBy {
  const hook: unknown = entry.ownedBy;
  expect(typeof hook, `${entry.code}.ownedBy`).toBe('function');
  return hook as OwnedBy;
}

it('[AC-B2-15z#8] 注册表完整性：local / test / staging / prod 的 list() 里，每个业务类型都登记了 ownedBy 函数', () => {
  for (const env of ['local', 'test', 'staging', 'prod'] as const) {
    for (const entry of createBizRegistry(env).list()) ownedByOf(entry);
  }
  expect(createBizRegistry('prod').list()).toEqual([]);
});

it('[AC-B2-15z#10] test_item 没有真实业务对象：非生产环境下它的 ownedBy 对任意 appId、userId、bizRef 都是 true', async () => {
  for (const env of ['local', 'test', 'staging'] as const) {
    const entry = createBizRegistry(env).get('test_item');
    expect(entry, env).toBeDefined();
    const ownedBy = ownedByOf(entry!);
    const details = await fc.check(
      fc.asyncProperty(fc.string(), fc.string(), fc.string(), async (appId, userId, bizRef) => {
        expect(await ownedBy({ appId, userId, bizRef })).toBe(true);
        return true;
      }),
      propParams(),
    );
    expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
  }
}, 900_000);
