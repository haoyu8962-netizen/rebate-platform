import { expect, vi } from 'vitest';
import {
  CatalogModule,
  type SearchProductsData,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { CatalogSearchService } from '../../../../apps/api/src/modules/catalog/application/search-service.ts';
import type { SearchProductsQuery } from '../../../../apps/api/src/modules/catalog/search.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError, type UnionErrorCode } from '../../../../apps/api/src/modules/union/index.ts';
import { assertContract, headers, type HttpApp, type Response } from '../search-route/http-kit.ts';

const root = new URL('../../../../', import.meta.url);

export type SearchPlatform = 'taobao' | 'jd' | 'pdd';
export const PLATFORMS: readonly SearchPlatform[] = ['taobao', 'jd', 'pdd'];

/** Every UnionErrorCode (types.ts); the type check below fails if a code is added and not listed. */
export const UNION_CODES = [
  'adapter_unimplemented',
  'invalid_endpoint',
  'unsafe_mode',
  'invalid_dto',
  'invalid_identity',
  'item_unavailable',
  'link_unrecognized',
  'upstream_rejected',
  'upstream_unavailable',
  'rate_limited',
] as const satisfies readonly UnionErrorCode[];
type MissingCode = Exclude<UnionErrorCode, (typeof UNION_CODES)[number]>;
export const ALL_CODES_LISTED: [MissingCode] extends [never] ? true : false = true;

/** The searchProducts 50304 fallback text of SearchController (unchanged by this task). */
export const MSG_50304 = '搜索暂不可用，请稍后再试';

/** Fragments of the synthetic upstream message / payload that must never reach a client or log. */
export const SECRETS = [
  'synthetic-union-secret',
  '无访问权限',
  'jd_union_open_goods_query_responce',
  'synthetic-app-key',
] as const;

/** A UnionError whose message carries an upstream-looking payload (JD inner code 403). */
export function unionError(
  code: UnionErrorCode,
  platform: SearchPlatform | null = null,
): UnionError {
  return new UnionError(
    code,
    `synthetic-union-secret jd.union.open.goods.query inner code 无访问权限 ` +
      `{"jd_union_open_goods_query_responce":{"queryResult":"{\\"code\\":\\"forbidden\\"}"},"app_key":"synthetic-app-key"}`,
    platform,
  );
}

export interface LogRecord {
  readonly level: number;
  readonly [key: string]: unknown;
}

/**
 * The real AppModule and SearchController behind real HTTP; only the use-case port
 * CatalogSearchService is replaced by a spy, so a test decides what the use case throws.
 * Every log line is captured (level info and above).
 */
export async function controllerFixture() {
  const search = vi.fn<(query: SearchProductsQuery) => Promise<SearchProductsData>>();
  const original = CatalogModule.forRoot;
  vi.spyOn(CatalogModule, 'forRoot').mockImplementationOnce((configReader, ports) => {
    const module = original(configReader, ports);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []).filter(
          (provider) =>
            provider !== CatalogSearchService &&
            !(typeof provider === 'object' && provider.provide === CatalogSearchService),
        ),
        { provide: CatalogSearchService, useValue: { search } },
      ],
    };
  });
  const lines: string[] = [];
  const options = {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-11-04T07:11:00.000Z'),
    logger: createRootLogger(
      { level: 'info', entry: 'api', appEnv: 'test' },
      {
        write: (line: string) => {
          lines.push(line);
        },
      },
    ),
  };
  // Dynamic URL keeps Nest's decorated controllers out of the spec project's TS compilation.
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp(entry: 'api', overrides: typeof options): Promise<HttpApp>;
  };
  const app = await createHttpApp('api', options);
  try {
    await app.init();
  } catch (error) {
    await app.close();
    throw error;
  }
  return {
    app,
    search,
    lines,
    records(): LogRecord[] {
      return lines
        .flatMap((chunk) => chunk.split('\n'))
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as LogRecord);
    },
    request(platform: SearchPlatform, params: Readonly<Record<string, string>> = {}) {
      const query = new URLSearchParams({ platform, q: '合成纸巾', ...params });
      return app.inject({ method: 'GET', url: `/v1/products/search?${query}`, headers });
    },
  };
}

interface Envelope {
  readonly code: number;
  readonly msg: string;
  readonly data?: unknown;
  readonly trace_id: string;
}

/** The 503 / 50304 { platform } answer, contract-valid, without any trace of the UnionError. */
export async function expectUnion50304(
  response: Response,
  platform: SearchPlatform,
): Promise<void> {
  expect(response.statusCode).toBe(503);
  await assertContract(response, false);
  const body = response.json<Envelope>();
  expect(body.code).not.toBe(50001);
  expect(body).toEqual({
    code: 50304,
    msg: MSG_50304,
    data: { platform },
    trace_id: response.headers['x-trace-id'],
  });
  const raw = JSON.stringify(body);
  for (const secret of SECRETS) expect(raw).not.toContain(secret);
  expect(raw).not.toContain('UnionError');
}
