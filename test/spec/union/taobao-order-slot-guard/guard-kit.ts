// B1-04zzh（D10-692，union 复核 S1-B）：淘宝订单推广位守卫的共用夹具。真实 TaobaoUnionAdapter + 真实
// DataokeClient + 假传输（冻结的 taobao-orders/kit.ts 只读复用），报文全部合成，值都是自拟的。
// Task-local AC labels ([AC-B1-04zzh#n]) identify this task's acceptance points, not business rules.
import { expect } from 'vitest';
import type {
  CallCtx,
  OrderPage,
  RejectedOrderRow,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import type { TaobaoOrderWarning } from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import { ctx, pageData, reply, rowOf, setup, type SetupOptions } from '../taobao-orders/kit.ts';

/** listOrders without the switch: a bad row is skipped with a warning (frozen AC-B1-04f#34). */
export const PLAIN: CallCtx = ctx;
/** listOrders as the order sync calls it (B1-04zv): refused rows go to `rejected`. */
export const COLLECT: CallCtx = { ...ctx, rowErrors: 'collect' };

export const MODES: readonly { readonly mode: string; readonly call: CallCtx }[] = [
  { mode: '不开 collect', call: PLAIN },
  { mode: 'collect', call: COLLECT },
];

/**
 * A good settled row of our active slot. The kit's default row has no settlement commission; a
 * settled row needs it under collect (B1-04zz): 7.66 − 结算服务费 1.00 = 666.
 */
export function good(index: number): Record<string, unknown> {
  return { ...rowOf(index), pub_share_fee_for_commission: '7.66' };
}

/** The trade_id (sub-order number) of `good(index)`. */
export function idOf(index: number): string {
  return String(rowOf(index).trade_id);
}

export interface GuardPage {
  /** What the archiving transport leaves on the response. */
  readonly payloadId?: string;
  /** Another upstream page follows this one (has_next true with a fresh position_index). */
  readonly more?: boolean;
  readonly slots?: SetupOptions['slots'];
}

/** A wired adapter whose order source answers every request with one page holding `rows`. */
export function guarded(rows: readonly unknown[], page: GuardPage = {}) {
  return setup(
    () =>
      reply(
        pageData(rows, { hasNext: page.more ?? false, position: 'sg-position-1|sg-position-2' }),
        page.payloadId,
      ),
    page.slots === undefined ? {} : { slots: page.slots },
  );
}

/** True for the NotImplemented a skeleton throws: it must stay a red of its own. */
function isSkeleton(error: unknown): boolean {
  return error instanceof Error && /\bNotImplemented\b/.test(`${error.name} ${error.message}`);
}

/** The page a listOrders call resolves to; a rejection fails the test as an assertion. */
export async function resolvedPage(run: () => Promise<OrderPage>): Promise<OrderPage> {
  let page: OrderPage | undefined;
  let failure: unknown;
  try {
    page = await run();
  } catch (error) {
    if (isSkeleton(error)) throw error;
    failure = error;
  }
  expect(failure, 'listOrders must resolve').toBeUndefined();
  expect(page).toBeDefined();
  return page!;
}

/** What a listOrders call rejects with; resolving (an empty page included) fails as an assertion. */
export async function refusal(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (isSkeleton(error)) throw error;
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  expect.fail('listOrders must reject, not resolve a page');
}

export function rejectedOf(page: OrderPage): readonly RejectedOrderRow[] {
  return page.rejected ?? [];
}

/** Every warning the adapter's orderWarn hook received, in order. */
export function warned(hook: {
  readonly mock: { readonly calls: readonly (readonly [TaobaoOrderWarning])[] };
}): readonly TaobaoOrderWarning[] {
  return hook.mock.calls.map(([event]) => event);
}

/** The counts of the taobao_order_foreign_slot warnings (one per page with foreign rows). */
export function foreignCounts(hook: Parameters<typeof warned>[0]): readonly (number | undefined)[] {
  return warned(hook)
    .filter((event) => event.event === 'taobao_order_foreign_slot')
    .map((event) => event.count);
}

/**
 * `field` as a whole name in a text: taobao's pub_share_fee must not pass on pub_share_pre_fee,
 * and adzone_id must not pass on tk_adzone_id.
 */
export function fieldNamed(field: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${field}(?![A-Za-z0-9_])`);
}
