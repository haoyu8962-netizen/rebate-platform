import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RootLogger } from '../../../platform/index.ts';
import { UnionError } from '../../../union/index.ts';
import type { CatalogSearchService } from '../../application/search-service.ts';
import { CatalogError } from '../../domain/rules.ts';
import type { SearchProductsQuery } from '../../search.ts';
import { SearchController } from './search.controller.ts';

function controller(error: unknown) {
  const warn = vi.fn();
  const service = { search: vi.fn().mockRejectedValue(error) } as unknown as CatalogSearchService;
  const logger = { warn } as unknown as RootLogger;
  return { warn, controller: new SearchController(service, logger) };
}

const query = { platform: 'jd', q: '纸巾' } as SearchProductsQuery;

async function thrown(c: SearchController): Promise<unknown> {
  try {
    await c.search({ id: 'trace-1' }, query);
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('SearchController error mapping', () => {
  it('[AC-B1-05z#1] maps a UnionError to 503 / 50304 { platform } and logs code only', async () => {
    const { controller: c, warn } = controller(
      new UnionError('upstream_rejected', 'secret payload', null),
    );
    const error = await thrown(c);
    expect(error).toBeInstanceOf(HttpException);
    const http = error as HttpException;
    expect(http.getStatus()).toBe(503);
    expect(http.getResponse()).toEqual({
      code: 50304,
      msg: '搜索暂不可用，请稍后再试',
      data: { platform: 'jd' },
      trace_id: 'trace-1',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({
      event: 'search_union_rejected',
      platform: 'jd',
      union_code: 'upstream_rejected',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret payload');
  });

  it('[AC-B1-05z#3] keeps CatalogError 30131 and passes unknown errors through', async () => {
    const catalog = await thrown(controller(new CatalogError(30131, 'x')).controller);
    expect((catalog as HttpException).getStatus()).toBe(422);
    const unknown = new TypeError('boom');
    const { controller: c, warn } = controller(unknown);
    expect(await thrown(c)).toBe(unknown);
    expect(warn).not.toHaveBeenCalled();
  });
});
