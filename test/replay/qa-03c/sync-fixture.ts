// QA-03a's initial-sync driver uses the base rebate port (no credited-order clawback).
// Capture the worker's complete production factory, including rebate → clawback.onUpdated,
// then use those same ports with the explicit synthetic status map and demo input stream.
import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import {
  createOrderPipeline,
  createOrderUpdateStep,
} from '../../../apps/api/src/modules/orders/index.ts';
import type { CommissionSnapshotPort } from '../../../apps/api/src/modules/orders/application/commission-snapshot-step.ts';
import type { OrderPipelineDeps } from '../../../apps/api/src/modules/orders/application/pipeline-types.ts';
import type { OrderSyncReadPorts } from '../../../apps/api/src/modules/orders/worker-runtime.ts';
import { loadStatusMap } from '../../../apps/api/src/modules/orders/domain/status-map.ts';
import { createSyncCursorStore } from '../../../apps/api/src/modules/orders/infra/sync-cursors.ts';
import { handleOrderSyncWindow } from '../../../apps/api/src/modules/orders/jobs/order-sync.ts';
import type { EventBus } from '../../../apps/api/src/modules/platform/index.ts';
import {
  createUnionOrderReaders,
  createUnionSyncAccess,
} from '../../../apps/api/src/modules/union/index.ts';
import type { DemoOrderSeed } from '../../../apps/api/src/modules/union/infra/demo/demo-order-stream.ts';
import type { startReplay } from '../qa-03a/driver.ts';
import { demoStream } from '../qa-03a/stream-fixture.ts';
import { logger } from '../qa-03b/worker.ts';

type Replay = Awaited<ReturnType<typeof startReplay>>;
type Ports = OrderSyncReadPorts & {
  snapshots(db: Replay['db'], clock: Replay['clock'], log: typeof logger): CommissionSnapshotPort;
};

export async function captureOrderSync() {
  const { OrdersModule } = (await import(
    new URL('../../../apps/api/src/modules/orders/index.ts', import.meta.url).href
  )) as { OrdersModule: { forWorker(options: Ports): unknown } };
  const original = OrdersModule.forWorker.bind(OrdersModule);
  let captured: Ports | undefined;
  const spy = vi.spyOn(OrdersModule, 'forWorker').mockImplementation((options) => {
    captured = options;
    return original(options);
  });
  return {
    restore: () => spy.mockRestore(),
    driver(h: Replay, seeds: readonly DemoOrderSeed[], events: EventBus) {
      expect(captured?.rebate, 'production worker rebate + clawback factory').toBeDefined();
      const ports = captured!;
      const { db, clock, appId, accountId } = h;
      const map = loadStatusMap(
        'pdd',
        'raw_code,event,source,verified,note\ndemo:refunded,PLATFORM_INVALID,synthetic,false,synthetic\n',
      );
      const sources = ports.sources?.(db, clock, logger);
      const deps = {
        db,
        clock,
        logger,
        events,
        ...createUnionOrderReaders(db),
        users: ports.users(db),
        bindings: ports.bindings(db),
        statusMaps: () => map,
        snapshots: ports.snapshots(db, clock, logger),
        rebate: ports.rebate!({ db, clock, logger, events }),
        ...(sources === undefined ? {} : { sources }),
      } satisfies OrderPipelineDeps;
      const pipeline = createOrderPipeline({ ...deps, updateStep: createOrderUpdateStep(deps) });
      const adapters = {
        pdd: demoStream(clock, seeds),
        jd: demoStream(clock, [], undefined, 'jd'),
        taobao: demoStream(clock, [], undefined, 'taobao'),
      };
      const access = createUnionSyncAccess({
        db,
        clock,
        logger,
        endpoints: [],
        breaker: () => 'closed',
      });
      const cursors = createSyncCursorStore(db, clock);
      return async (from: string, to: string) => {
        await handleOrderSyncWindow(
          {
            id: randomUUID(),
            queue: 'order-sync',
            name: 'window',
            attempt: 1,
            payload: {
              app_id: appId,
              platform: 'pdd',
              union_account_id: accountId,
              query_kind: 'increment',
              scene: '-',
              window_start: from,
              window_end: to,
            },
          },
          {
            access: { ...access, queryableAccount: async () => accountId },
            cursors,
            registry: { get: (platform) => adapters[platform] },
            pipeline,
            logger,
          },
        );
      };
    },
  };
}
