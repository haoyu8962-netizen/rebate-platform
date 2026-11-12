import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { clockFromConfig } from '../../../apps/api/src/modules/platform/clock/clock.ts';
import type { Clock } from '../../../apps/api/src/modules/platform/clock/clock.ts';
import { DemoUnionAdapter } from '../../../apps/api/src/modules/union/infra/demo/demo-adapter.ts';
import { UnionError } from '../../../apps/api/src/modules/union/domain/types.ts';
import type { DemoUnionOptions } from '../../../apps/api/src/modules/union/infra/demo/demo-adapter.ts';
import type {
  DemoOrderSeed,
  DemoOrderStreamOptions,
} from '../../../apps/api/src/modules/union/infra/demo/demo-order-stream.ts';
import type {
  RegisteredPlatform,
  TimeWindow,
  UnionOrder,
} from '../../../apps/api/src/modules/union/domain/types.ts';

export const START = '2026-10-01T00:00:00+08:00';
export const PAID = '2026-10-05T10:00:00+08:00';
export const RECEIVED = '2026-10-08T20:00:00+08:00';
export const REFUNDED = '2026-10-20T11:00:00+08:00';
export const SEED = 'QA-03a-synthetic-v1';

/** October's 31 days fit in one replay day. Stages jump; no wall-clock wait or fake timers. */
export function replayClock() {
  let elapsed = 0;
  const clock = clockFromConfig({ clockNow: START }, () => elapsed);
  return {
    clock,
    moveTo(instant: string) {
      const next = Date.parse(instant) - Date.parse(START);
      expect(next).toBeGreaterThanOrEqual(elapsed);
      elapsed = next;
    },
    advanceReplayMs(ms: number) {
      elapsed += ms * 31;
    },
  };
}

export function demoStream(
  clock: Clock,
  orders: readonly DemoOrderSeed[],
  seed = SEED,
  platform: RegisteredPlatform = 'pdd',
) {
  // Intersection deliberately specifies the new optional constructor contract without changing
  // existing implementation in the red phase. The implementation must consume orderStream.
  const options: DemoUnionOptions & DemoOrderStreamOptions = {
    platform,
    environment: 'test',
    seed,
    clock,
    orderStream: orders,
  };
  return new DemoUnionAdapter(options);
}

export function syntheticOrder(key = 'one', appId = 'qa03a-stream'): DemoOrderSeed {
  return {
    key,
    appId,
    item: { platform: 'pdd', goods_sign: 'synthetic-product' },
    promotionSlot: 'synthetic-slot',
    attrParams: {
      relation_id: null,
      sub_union_id: null,
      custom_parameters: '{"app":"n","uid":"demo0001"}',
    },
    paidAt: PAID,
    receivedAt: RECEIVED,
    refundedAt: REFUNDED,
  };
}

export async function streamRows(
  adapter: DemoUnionAdapter,
  win: TimeWindow,
  appId = 'qa03a-stream',
) {
  const rows: UnionOrder[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    // adapter_unimplemented is deliberately turned into an assertion failure for red-check.
    const result = await adapter
      .listOrders(win, cursor === undefined ? {} : { cursor }, {
        appId,
        requestId: randomUUID(),
        purpose: 'order_sync',
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => {
          if (error instanceof UnionError && error.code === 'adapter_unimplemented') {
            return { ok: false as const, error };
          }
          throw error;
        },
      );
    expect(result, 'listOrders must supply the synthetic stream').toMatchObject({ ok: true });
    if (!result.ok) throw result.error;
    rows.push(...result.value.items);
    if (result.value.nextCursor === null) return rows;
    expect(result.value.items.length).toBeGreaterThan(0);
    expect(cursors.has(result.value.nextCursor)).toBe(false);
    cursors.add(result.value.nextCursor);
    cursor = result.value.nextCursor;
  }
  throw new Error('synthetic stream exceeded 100 pages');
}
