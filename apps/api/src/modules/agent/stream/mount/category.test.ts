// B1-04zzy (D10-860): the production categoryAllowed over catalog's filterCategories port.
import { expect, it, vi } from 'vitest';
import type { AgentSearchCandidate } from '../../tools/search/index.ts';
import type { AgentStreamAssemblyContext, AgentStreamProvidedPorts } from './assembly.ts';
import { createCategoryAllowed } from './production.ts';

type Port = NonNullable<AgentStreamProvidedPorts['categories']>;

const NOW = '2031-01-02T03:04:05+08:00';

function row(categoryId: string): AgentSearchCandidate {
  return {
    item: {
      platform: 'jd',
      item_id: 'unit-item-1',
      title: '单测商品',
      price_fen: 100n,
      coupon_fen: 0n,
      final_price_fen: 100n,
      commission_rate_bp: 100n,
      quoted_at: NOW,
    },
    ref: {
      appId: 'unit-app',
      platform: 'jd',
      productKey: 'unit-key-1',
      rawItemId: 'unit-raw-1',
      rawFetchedAt: NOW,
      receivedAt: NOW,
      canonicalUrl: null,
      title: '单测商品',
      shopId: null,
      shopType: null,
      source: 'search',
    },
    categoryId,
    sales: null,
  };
}

function logger() {
  const warn = vi.fn();
  return { warn, logger: { warn } as unknown as AgentStreamAssemblyContext['logger'] };
}

function port(impl: Port['filterCategories']): Port & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    filterCategories: (async (appId: string, items: readonly unknown[]) => {
      calls.push([appId, items]);
      return impl(appId, items as never);
    }) as Port['filterCategories'],
  };
}

it('[B1-04zzy#unit-1] 端口留下候选即放行，传入应用、平台、类目与标题', async () => {
  const p = port(async (_appId, items) => [...items]);
  const { warn, logger: log } = logger();
  const allowed = createCategoryAllowed(p, log);
  expect(await allowed('unit-app', row('16'))).toBe(true);
  expect(p.calls).toEqual([
    ['unit-app', [{ platform: 'jd', categoryId: '16', title: '单测商品' }]],
  ]);
  expect(warn).not.toHaveBeenCalled();
});

it('[B1-04zzy#unit-2] 端口滤掉候选即判禁；无类目时传空串', async () => {
  const p = port(async () => []);
  const allowed = createCategoryAllowed(p, logger().logger);
  expect(await allowed('unit-app', row(''))).toBe(false);
  expect(p.calls[0]?.[1]).toEqual([{ platform: 'jd', categoryId: '', title: '单测商品' }]);
});

it('[B1-04zzy#unit-3] 端口抛错从严判禁，记一条 warn，只带事件码与平台', async () => {
  const p = port(async () => {
    throw new Error('unit failure');
  });
  const { warn, logger: log } = logger();
  const allowed = createCategoryAllowed(p, log);
  expect(await allowed('unit-app', row('16'))).toBe(false);
  expect(warn).toHaveBeenCalledTimes(1);
  const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
  expect(fields).toMatchObject({ event: 'agent_category_blocklist_failed', platform: 'jd' });
  const text = JSON.stringify(fields) + message;
  for (const secret of ['unit-item-1', 'unit-key-1', 'unit-raw-1', '单测商品']) {
    expect(text).not.toContain(secret);
  }
});

it('[B1-04zzy#unit-4] 未装配端口时放行', async () => {
  const { warn, logger: log } = logger();
  const allowed = createCategoryAllowed(undefined, log);
  expect(await allowed('unit-app', row('16'))).toBe(true);
  expect(warn).not.toHaveBeenCalled();
});
