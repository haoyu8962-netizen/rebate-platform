import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import type { AppConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import * as http from '../../../../apps/api/src/modules/union/infra/http-transport.ts';
import * as pdd from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';
import type { PddWarning } from '../../../../apps/api/src/modules/union/infra/pdd/response.ts';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { search } from '../pdd-goods/kit.ts';
import { clock, configured, endpoints } from '../pdd-live-wiring/kit.ts';
import { CUSTOM, outcome } from '../pdd-query-identity/kit.ts';

// [AC-B1-04zgd#n] are task-local acceptance labels (D10-1096, D10-1069): the two Pinduoduo order
// alerts reach the production log as flat pino fields, never an order number, amount or user.
// All values are synthetic; no network, database, credential file or port is used.

// Credentials are an already-tested startup boundary (B1-04t). Never open a credential file.
vi.mock('../../../../apps/api/src/modules/platform/config/pdd-startup.ts', async (original) => ({
  ...(await original<
    typeof import('../../../../apps/api/src/modules/platform/config/pdd-startup.ts')
  >()),
  openPddCredentials: vi.fn(async () => async () => ({
    clientId: 'synthetic-client',
    clientSecret: 'fake-key',
  })),
}));

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => expect.fail('network access is forbidden')),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** The Pinduoduo order list method the order alerts are raised under (synthetic page). */
const ORDERS = 'pdd.ddk.order.list.increment.get';
const UNMAPPED = 'order_reason_sub_unmapped';
const INVALID = 'pdd_invalid_with_commission';
const PRICE_MESSAGE = 'pinduoduo goods price anomaly';
const UNKNOWN_MESSAGE = 'unknown pinduoduo error code';

/** Order data a careless hook would leak; none of it may reach any logged value. */
const LEAK = {
  order_sn: 'synthetic-order-sn-261109-7788990011',
  order_id: 'synthetic-order-id-5544332211',
  promotion_amount: 4321987,
  order_amount: 9876543,
  custom_parameters: CUSTOM,
  p_id: 'synthetic-order-pid-0099',
  goods_id: 7345678901234,
} as const;
const LEAKED = new RegExp(
  [
    'synthetic-order-sn',
    'synthetic-order-id',
    '4321987',
    '9876543',
    'synthetic-query-user',
    'synthetic-order-pid',
    '7345678901234',
  ].join('|'),
);

type Leaky = PddWarning & typeof LEAK;

interface FactoryProvider {
  provide: unknown;
  inject?: readonly unknown[];
  useFactory?: (...args: unknown[]) => unknown;
}
interface ModuleMetadata {
  module: unknown;
  providers: FactoryProvider[];
  exports?: unknown[];
}
interface ModuleExports {
  UNION_ENDPOINTS: unknown;
  UNION_REGISTRY: unknown;
  UnionModule: { forRoot(): ModuleMetadata };
}
interface TestContext {
  init(): Promise<unknown>;
  close(): Promise<void>;
}
interface NestTesting {
  Test: {
    createTestingModule(metadata: { imports: unknown[] }): {
      compile(): Promise<TestContext>;
    };
  };
}

function configuration(): AppConfig {
  return { ...configured('synthetic-unused-file'), pddQueryCustomParameters: CUSTOM };
}

/**
 * Nest assembles the union module (pdd live, staging) with a spy root logger; the real
 * PddUnionAdapter is observed, not replaced, and its warn hook is handed back. Nothing is listened
 * on and the HTTPS transport refuses to be called.
 */
async function assemble(): Promise<{
  context: TestContext;
  hook: (warning: PddWarning) => void;
  warn: Mock;
}> {
  const Original = pdd.PddUnionAdapter;
  const observed = vi.spyOn(pdd, 'PddUnionAdapter').mockImplementation(class extends Original {});
  const transport = vi.fn<UnionTransport>(() => expect.fail('no upstream request is expected'));
  vi.spyOn(http, 'createUnionHttpTransport').mockReturnValue(transport);
  const union = (await import(
    new URL('../../../../apps/api/src/modules/union/union.module.ts', import.meta.url).href
  )) as ModuleExports;
  const platform = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as Record<string, unknown>;
  const requireApi = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const testing = (await import(
    pathToFileURL(requireApi.resolve('@nestjs/testing')).href
  )) as NestTesting;
  const warn = vi.fn();
  const logger = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
  const values = new Map<unknown, unknown>([
    [platform['APP_CONFIG'], configuration()],
    [platform['CLOCK'], clock],
    [platform['ROOT_LOGGER'], logger],
  ]);
  class FixtureGlobals {}
  const metadata = union.UnionModule.forRoot();
  const result = await outcome(() =>
    testing.Test.createTestingModule({
      imports: [
        {
          module: FixtureGlobals,
          global: true,
          providers: [...values].map(([provide, useValue]) => ({ provide, useValue })),
          exports: [...values.keys()],
        },
        {
          ...metadata,
          providers: metadata.providers.map((provider) =>
            provider.provide === union.UNION_ENDPOINTS
              ? { provide: provider.provide, useValue: endpoints() }
              : provider,
          ),
        },
      ],
    }).compile(),
  );
  expect(result).not.toBeInstanceOf(Error);
  const context = result as TestContext;
  const initialized = await outcome(() => context.init());
  expect(initialized).not.toBeInstanceOf(Error);
  expect(observed).toHaveBeenCalledTimes(1);
  const hook = observed.mock.calls[0]?.[0].warn;
  expect(hook).toBeTypeOf('function');
  // Startup itself logs nothing (custom parameters configured, taobao / jd unconfigured).
  expect(warn).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
  return { context, hook: hook!, warn };
}

/** One pino call: exactly (flat fields, message). */
function call(warn: Mock, index: number): { fields: Record<string, unknown>; message: unknown } {
  const args = warn.mock.calls[index] as unknown[];
  expect(args).toHaveLength(2);
  expect(args[0]).toBeTypeOf('object');
  expect(args[0]).not.toBeNull();
  return { fields: args[0] as Record<string, unknown>, message: args[1] };
}

/** The two existing outputs, unchanged: PRICE_ANOMALY and an unknown error code. */
function existingOutputs(hook: (warning: PddWarning) => void, warn: Mock): void {
  const price: Leaky = {
    event: 'PRICE_ANOMALY',
    error_code: 'PRICE_ANOMALY',
    type: search,
    ...LEAK,
  };
  hook(price);
  hook({ error_code: 'synthetic-unknown-code', type: search });
  expect(warn).toHaveBeenCalledTimes(2);
  expect(call(warn, 0)).toEqual({
    fields: { event: 'PRICE_ANOMALY', method: search },
    message: PRICE_MESSAGE,
  });
  expect(call(warn, 1)).toEqual({
    fields: {
      event: 'PDD_ERROR_CODE_UNKNOWN',
      error_code: 'synthetic-unknown-code',
      method: search,
    },
    message: UNKNOWN_MESSAGE,
  });
  warn.mockClear();
}

function unmapped(failReason: { readonly fail_reason?: string | null }): Leaky {
  return {
    event: UNMAPPED,
    error_code: UNMAPPED,
    type: ORDERS,
    alert: UNMAPPED,
    platform: 'pdd',
    ...failReason,
    ...LEAK,
  };
}

function invalid(): Leaky {
  return {
    event: INVALID,
    error_code: INVALID,
    type: ORDERS,
    alert: INVALID,
    platform: 'pdd',
    ...LEAK,
  };
}

/** A truthful message of its own: not the price anomaly or unknown error code text. */
function expectOwnMessage(message: unknown): void {
  expect(message).toBeTypeOf('string');
  expect((message as string).trim()).not.toBe('');
  expect(message).not.toBe(PRICE_MESSAGE);
  expect(message).not.toBe(UNKNOWN_MESSAGE);
  expect(message as string).not.toMatch(LEAKED);
}

it('[AC-B1-04zgd#1] order_reason_sub_unmapped：平铺字段恰为 event、alert、platform=pdd、method、fail_reason 原值，消息如实（不是价格异常）；不带单号、金额、用户；价格异常与未知错误码两条既有输出不变', async () => {
  const { context, hook, warn } = await assemble();
  try {
    existingOutputs(hook, warn);
    hook(unmapped({ fail_reason: '合成失效原因：违规' }));
    expect(warn).toHaveBeenCalledTimes(1);
    const { fields, message } = call(warn, 0);
    expect(fields).toEqual({
      event: UNMAPPED,
      alert: UNMAPPED,
      platform: 'pdd',
      method: ORDERS,
      fail_reason: '合成失效原因：违规',
    });
    expectOwnMessage(message);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(LEAKED);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PDD_ERROR_CODE_UNKNOWN');
  } finally {
    await context.close();
  }
});

it.each([
  { label: '空串原样', failReason: { fail_reason: '' }, expected: '' },
  { label: 'null 记为 null', failReason: { fail_reason: null }, expected: null },
  { label: '缺失记为 null', failReason: {}, expected: null },
] as const)(
  '[AC-B1-04zgd#2] order_reason_sub_unmapped 的 fail_reason（$label）：字段集合不变、值如实，不带单号、金额、用户',
  async ({ failReason, expected }) => {
    const { context, hook, warn } = await assemble();
    try {
      existingOutputs(hook, warn);
      hook(unmapped(failReason));
      expect(warn).toHaveBeenCalledTimes(1);
      const { fields, message } = call(warn, 0);
      expect(fields).toEqual({
        event: UNMAPPED,
        alert: UNMAPPED,
        platform: 'pdd',
        method: ORDERS,
        fail_reason: expected,
      });
      expect(Object.hasOwn(fields, 'fail_reason')).toBe(true);
      expectOwnMessage(message);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(LEAKED);
    } finally {
      await context.close();
    }
  },
);

it('[AC-B1-04zgd#3] pdd_invalid_with_commission：平铺字段恰为 event、alert、platform=pdd、method（无 fail_reason），消息如实且与 order_reason_sub_unmapped 不同；不带单号、金额、用户；既有两条输出不变', async () => {
  const { context, hook, warn } = await assemble();
  try {
    existingOutputs(hook, warn);
    hook(invalid());
    expect(warn).toHaveBeenCalledTimes(1);
    const first = call(warn, 0);
    expect(first.fields).toEqual({
      event: INVALID,
      alert: INVALID,
      platform: 'pdd',
      method: ORDERS,
    });
    expect(Object.hasOwn(first.fields, 'fail_reason')).toBe(false);
    expectOwnMessage(first.message);
    hook(unmapped({ fail_reason: '合成失效原因' }));
    expect(warn).toHaveBeenCalledTimes(2);
    const second = call(warn, 1);
    expect(second.fields).toMatchObject({ event: UNMAPPED, alert: UNMAPPED, platform: 'pdd' });
    expectOwnMessage(second.message);
    expect(second.message).not.toBe(first.message);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(LEAKED);
  } finally {
    await context.close();
  }
});

it('[AC-B1-04zgd#4] 两种订单告警各只记一条 warn，platform 恒 pdd、alert 与 event 同值，每个字段值都只来自 event / alert / platform / method / fail_reason', async () => {
  const { context, hook, warn } = await assemble();
  try {
    existingOutputs(hook, warn);
    hook(invalid());
    hook(unmapped({ fail_reason: '合成原因' }));
    expect(warn).toHaveBeenCalledTimes(2);
    const allowed = new Set<unknown>([UNMAPPED, INVALID, 'pdd', ORDERS, '合成原因', null]);
    for (const index of [0, 1]) {
      const { fields } = call(warn, index);
      expect(fields).toMatchObject({ platform: 'pdd', method: ORDERS });
      expect(fields['alert']).toBe(fields['event']);
      for (const value of Object.values(fields)) expect(allowed.has(value)).toBe(true);
    }
  } finally {
    await context.close();
  }
});
