// B1-09n · 生产装配（不连库）：createRebatePort 的生产实例只建一份，由 app.module 的工厂给出，worker 用的
// 就是它（编排 13:21；后续 B1-10n 的 rights 端口共用这一份）；黑名单第 ③ 步拿到的是 risk 的
// createOrderBlocklistPorts，用入口的 FIELD_CRYPTO。这里没有自注入：端口都取自真实的 AppModule 装配。
// 工厂在 app.module.ts（带装饰器，不能放骨架），所以骨架上这里红在断言。
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import * as pipeline from '../../../../apps/api/src/modules/orders/application/pipeline-port.ts';
import * as update from '../../../../apps/api/src/modules/orders/application/update-step.ts';
import type {
  OrderRebatePortFactory,
  OrdersWorkerOptions,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import * as blocklist from '../../../../apps/api/src/modules/risk/application/order-blocklist.ts';
import * as rebate from '../../../../apps/api/src/modules/settlement/rebate/application/rebate.ts';
import { compileOnlyDb, contextOf, runtime } from '../wiring/context-kit.ts';
import { built } from '../wiring/db-kit.ts';
import { keyedWorker } from './kit.ts';

const NOW = '2026-10-22T03:00:00.000Z';
const APP_MODULE = new URL('../../../../apps/api/src/app.module.ts', import.meta.url);

async function factoryExport() {
  const app = (await import(APP_MODULE.href)) as {
    rebatePortFactory?: () => OrderRebatePortFactory;
  };
  expect(typeof app.rebatePortFactory, 'app.module exports rebatePortFactory').toBe('function');
  return app.rebatePortFactory!;
}

/** What AppModule hands OrdersModule.forWorker on the worker entry. */
async function workerOptionsSpy() {
  const { OrdersModule } = (await import(
    new URL('../../../../apps/api/src/modules/orders/index.ts', import.meta.url).href
  )) as { OrdersModule: { forWorker(options: OrdersWorkerOptions): unknown } };
  return vi.spyOn(OrdersModule, 'forWorker');
}

function assembly() {
  return {
    db: compileOnlyDb([]),
    clock: new FixedClock(NOW),
    logger: createRootLogger(
      { level: 'silent', entry: 'worker', appEnv: 'test' },
      { write: () => undefined },
    ),
    events: { publish: vi.fn() },
  };
}

it('[AC-B1-09n#1] 工厂一次构建：同一工厂再要给同一个实例，createRebatePort 只调一次，造端口不查库', async () => {
  const make = await factoryExport();
  const created = vi.spyOn(rebate, 'createRebatePort');
  const queries: string[] = [];
  const factory = make();
  const deps = { ...assembly(), db: compileOnlyDb(queries) };
  const first = factory(deps);
  expect(factory(deps)).toBe(first);
  expect(factory(assembly())).toBe(first);
  expect(created).toHaveBeenCalledTimes(1);
  expect(queries).toEqual([]);
  expect(first).toMatchObject({
    onImported: expect.any(Function),
    onUpdated: expect.any(Function),
    onUnmappedStatus: expect.any(Function),
    onBlacklistHit: expect.any(Function),
  });
});

it('[AC-B1-09n#2] worker 用的就是工厂给的实例：流水线与更新步骤拿到同一个对象，整个入口只造一份', async () => {
  const created = vi.spyOn(rebate, 'createRebatePort');
  const makePipeline = vi.spyOn(pipeline, 'createOrderPipeline');
  const makeUpdate = vi.spyOn(update, 'createOrderUpdateStep');
  const forWorker = await workerOptionsSpy();
  const f = await built(() => contextOf('worker', true));
  try {
    await runtime(f.context);
    expect(forWorker).toHaveBeenCalledTimes(1);
    expect(makePipeline).toHaveBeenCalledTimes(1);
    expect(makeUpdate).toHaveBeenCalledTimes(1);
    const options = forWorker.mock.calls[0]![0];
    expect(typeof options.rebate, 'orderSyncPorts gives the rebate factory').toBe('function');
    const given = options.rebate!(assembly());
    expect(created).toHaveBeenCalledTimes(1);
    expect(makePipeline.mock.calls[0]![0].rebate).toBe(given);
    expect(makeUpdate.mock.calls[0]![0].rebate).toBe(given);
  } finally {
    await f.context.close();
  }
});

it('[AC-B1-09n#3] 黑名单第 ③ 步：有字段密钥时流水线与更新步骤共用 risk 的 createOrderBlocklistPorts，用入口的 FIELD_CRYPTO', async () => {
  const ports = vi.spyOn(blocklist, 'createOrderBlocklistPorts');
  const makePipeline = vi.spyOn(pipeline, 'createOrderPipeline');
  const makeUpdate = vi.spyOn(update, 'createOrderUpdateStep');
  const f = await built(() => keyedWorker());
  try {
    await runtime(f.context);
    expect(ports).toHaveBeenCalledTimes(1);
    const crypto = f.context.get(f.platform.FIELD_CRYPTO, { strict: false });
    expect(ports.mock.calls[0]![0].crypto).toBe(crypto);
    expect(ports.mock.calls[0]![0].clock).toBe(f.clock);
    const blacklist = makePipeline.mock.calls[0]![0].blacklist;
    expect(blacklist?.blocklist).toBe(ports.mock.results[0]!.value);
    expect(makeUpdate.mock.calls[0]![0].blacklist).toBe(blacklist);
  } finally {
    await f.close();
  }
});

it('[AC-B1-09n#4] app.module 里只有工厂这一处 new：createRebatePort 的调用恰好一处', () => {
  const source = readFileSync(APP_MODULE, 'utf8');
  expect(source.match(/\bcreateRebatePort\s*\(/gu) ?? []).toHaveLength(1);
});
