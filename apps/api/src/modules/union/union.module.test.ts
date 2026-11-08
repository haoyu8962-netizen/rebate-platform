import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { APP_CONFIG, type AppConfig, type RootLogger } from '../platform/index.ts';
import { UnionError, type UnionEndpoint } from './domain/types.ts';
import {
  logTaobaoPriceWarning,
  logTaobaoWarning,
  UNION_ENDPOINTS,
  UNION_ENDPOINTS_DIR,
  UnionModule,
} from './union.module.ts';

interface FactoryProvider {
  readonly provide: unknown;
  readonly inject: readonly unknown[];
  readonly useFactory: (config: AppConfig) => Promise<readonly UnionEndpoint[]>;
}

function endpointsFactory(directory?: string): FactoryProvider {
  const providers: readonly unknown[] = UnionModule.forRoot(directory).providers ?? [];
  const provider = providers.find(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      'provide' in value &&
      value.provide === UNION_ENDPOINTS,
  );
  if (provider === undefined) throw new Error('UNION_ENDPOINTS provider missing');
  return provider as FactoryProvider;
}

function config(appEnv: AppConfig['appEnv'], unionEndpointOverrideDir?: string | null): AppConfig {
  return {
    appEnv,
    logLevel: 'silent',
    clockNow: undefined,
    exitAfterInit: false,
    apiHost: '127.0.0.1',
    apiPort: 3100,
    streamPort: 3101,
    adminPort: 3102,
    keyring: null,
    jwt: null,
    ...(unionEndpointOverrideDir === undefined ? {} : { unionEndpointOverrideDir }),
  };
}

async function settle(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return error;
  }
}

it('[AC-B1-04y-UNIT#4] UNION_ENDPOINTS 只注入 APP_CONFIG；未设覆盖目录时读镜像目录', async () => {
  const provider = endpointsFactory();
  expect(provider.inject).toEqual([APP_CONFIG]);
  for (const absent of [undefined, null, '']) {
    const endpoints = await provider.useFactory(config('staging', absent));
    expect(endpoints.map((endpoint) => endpoint.platform).sort()).toEqual(['jd', 'pdd', 'taobao']);
  }
  expect(UNION_ENDPOINTS_DIR.endsWith(join('config', 'union-endpoints') + '/')).toBe(true);
});

it('[AC-B1-04y-UNIT#5] staging 覆盖目录缺失时启动失败，不退回镜像目录', async () => {
  const absent = join(UNION_ENDPOINTS_DIR, 'unit-absent-override');
  const result = await settle(() => endpointsFactory().useFactory(config('staging', absent)));
  expect(result).toBeInstanceOf(UnionError);
  expect(result).toMatchObject({ code: 'invalid_endpoint' });
});

it('[AC-B1-04y-UNIT#6] 手工构造的非 staging 配置带覆盖目录即拒绝，不读该目录', async () => {
  for (const appEnv of ['local', 'test', 'prod'] as const) {
    const result = await settle(() =>
      endpointsFactory().useFactory(config(appEnv, UNION_ENDPOINTS_DIR)),
    );
    expect(result).toBeInstanceOf(UnionError);
    expect(result).toMatchObject({ code: 'invalid_endpoint' });
  }
});

/** The flat fields of every logger.warn call made by `run`. */
function warnFields(run: (logger: RootLogger) => void): unknown[] {
  const warn = vi.fn();
  run({ warn } as unknown as RootLogger);
  return warn.mock.calls.map((call) => call[0]);
}

it('[AC-B1-04zzzzg-UNIT#4] logTaobaoWarning 按码分事件：code 11 记权限事件（字段照旧），价格类 / 行校验类 / 其他码各记自己的事件且只有 event / method / code，图片主机照旧', () => {
  const method = 'unit.method';
  expect(
    warnFields((logger) => {
      logTaobaoWarning(logger, { method, code: '11', sub_code: 'unit.sub' });
      logTaobaoWarning(logger, { method, code: '11' });
    }),
  ).toEqual([
    { event: 'TAOBAO_API_PERMISSION_DENIED', method, code: '11', sub_code: 'unit.sub' },
    { event: 'TAOBAO_API_PERMISSION_DENIED', method, code: '11' },
  ]);
  for (const code of ['PRICE_ANOMALY', 'PRICE_CALC_DIFF', 'PRICE_PROMO_UNKNOWN']) {
    expect(warnFields((logger) => logTaobaoWarning(logger, { method, code }))).toEqual([
      { event: 'TAOBAO_PRICE_WARNING', method, code },
    ]);
  }
  for (const code of ['invalid_item', 'invalid_commission']) {
    expect(warnFields((logger) => logTaobaoWarning(logger, { method, code }))).toEqual([
      { event: 'TAOBAO_SEARCH_ROW_INVALID', method, code },
    ]);
  }
  expect(
    warnFields((logger) => logTaobaoWarning(logger, { method, code: '7', sub_code: 'unit.sub' })),
  ).toEqual([{ event: 'TAOBAO_WARNING_UNKNOWN', method, code: '7' }]);
  const imageHost = { method, code: 'dataoke_image_host_dropped', host: 'img.unit', count: 3 };
  expect(warnFields((logger) => logTaobaoWarning(logger, imageHost))).toEqual([
    { event: 'DATAOKE_IMAGE_HOST_DROPPED', method, host: 'img.unit', count: 3 },
  ]);
});

it('[AC-B1-04zzzzg-UNIT#5] logTaobaoPriceWarning 记 TAOBAO_PRICE_WARNING：只有 event / method / code，未知优惠另带 promotion_title', () => {
  const method = 'unit.method';
  expect(
    warnFields((logger) => {
      logTaobaoPriceWarning(logger, { method, code: 'PRICE_CALC_DIFF' });
      logTaobaoPriceWarning(logger, {
        method,
        code: 'PRICE_PROMO_UNKNOWN',
        promotion_title: '单元优惠',
      });
    }),
  ).toEqual([
    { event: 'TAOBAO_PRICE_WARNING', method, code: 'PRICE_CALC_DIFF' },
    {
      event: 'TAOBAO_PRICE_WARNING',
      method,
      code: 'PRICE_PROMO_UNKNOWN',
      promotion_title: '单元优惠',
    },
  ]);
});
