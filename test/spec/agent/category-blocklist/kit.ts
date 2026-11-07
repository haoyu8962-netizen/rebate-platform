// B1-04zzy (D10-860, FU-CATEGORY-BLOCKLIST step 3 part B): the production stream assembly
// (createProductionStreamAssembly) over synthetic provided ports. Only the observation seam of the
// B3-03j regression kit is used: createAgentStreamAssembly is spied on (the original still runs) to
// read the search port's categoryAllowed that the production assembly hands in. The catalog port is
// a synthetic one that judges with catalog's own rule function (filterByRules), per app, and records
// what it was asked. No database: the handle is inert and fails any query. Synthetic values only.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import type { CategoryCandidate } from '../../../../apps/api/src/modules/catalog/index.ts';
import type { CategoryRule } from '../../../../apps/api/src/modules/catalog/domain/types.ts';
import { filterByRules } from '../../../../apps/api/src/modules/catalog/domain/rules.ts';
import {
  FixedClock,
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import * as businessAssembly from '../../../../apps/api/src/modules/agent/stream/mount/assembly.ts';
import {
  createProductionStreamAssembly,
  type AgentStreamAssemblyDeps,
  type AgentStreamProvidedPorts,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import type { AgentSearchCandidate } from '../../../../apps/api/src/modules/agent/tools/search/index.ts';

/** The provided ports' optional catalog port (B1-04zzy). */
export type AgentCategoryPort = NonNullable<AgentStreamProvidedPorts['categories']>;

export const NOW = '2031-03-04T05:06:07+08:00';
export const APP_A = 'synthetic-blk-app-a';
export const APP_B = 'synthetic-blk-app-b';

export type Platform = AgentSearchCandidate['item']['platform'];
export type CategoryAllowed = AgentStreamAssemblyDeps['ports']['search']['categoryAllowed'];

/** A normalized search candidate; every identifying value carries `key`. */
export function candidate(
  key: string,
  options: { platform?: Platform; categoryId?: string; title?: string } = {},
): AgentSearchCandidate {
  const platform = options.platform ?? 'taobao';
  const title = options.title ?? `合成商品 ${key}`;
  return {
    item: {
      platform,
      item_id: `synthetic-item-${key}`,
      title,
      price_fen: 1000n,
      coupon_fen: 0n,
      final_price_fen: 1000n,
      commission_rate_bp: 1000n,
      quoted_at: NOW,
    },
    ref: {
      appId: APP_A,
      platform,
      productKey: `synthetic-key-${key}`,
      rawItemId: `synthetic-raw-${key}`,
      rawFetchedAt: NOW,
      receivedAt: NOW,
      canonicalUrl: null,
      title,
      shopId: null,
      shopType: null,
      source: 'search',
    },
    categoryId: options.categoryId ?? 'synthetic-cat-plain',
    sales: 1,
  };
}

export interface CategoryCall {
  readonly appId: string;
  readonly items: readonly CategoryCandidate[];
}

/**
 * Catalog's port: the rules of each app (mutable between calls), judged by catalog's filterByRules;
 * `fail` makes every call reject. Every call is recorded with a copy of what it was given.
 */
export function categoryPort() {
  const rules = new Map<string, CategoryRule[]>();
  const calls: CategoryCall[] = [];
  const state = { fail: false };
  const port: AgentCategoryPort = {
    async filterCategories<T extends CategoryCandidate>(
      appId: string,
      items: readonly T[],
    ): Promise<T[]> {
      calls.push({
        appId,
        items: items.map((item) => ({
          platform: item.platform,
          categoryId: item.categoryId,
          title: item.title,
        })),
      });
      if (state.fail) throw new Error('synthetic blocklist read failure');
      return filterByRules(items, rules.get(appId) ?? []);
    },
  };
  return { port, rules, calls, state };
}

/** JSON lines of a trace-level root logger, in memory. */
export class Logs {
  readonly lines: string[] = [];
  readonly logger: RootLogger = createRootLogger(
    { level: 'trace', entry: 'stream', appEnv: 'test' },
    { write: (line: string) => void this.lines.push(line) },
  );
  warnings(): string[] {
    return this.lines.filter((line) => (JSON.parse(line) as { level?: unknown }).level === 40);
  }
}

/** A database handle the assembly may scope but never query. */
function inertDb(): Kysely<DB> {
  const handle: object = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') return undefined;
        if (property === 'withSchema') return () => handle;
        return () => {
          throw new Error(`synthetic db: ${String(property)} is not used by these tests`);
        };
      },
    },
  );
  return handle as Kysely<DB>;
}

/**
 * Builds createProductionStreamAssembly (inside the test body) with or without the catalog port
 * and returns the categoryAllowed it handed to createAgentStreamAssembly.
 */
export function productionCategoryAllowed(categories?: AgentCategoryPort): {
  readonly allowed: CategoryAllowed;
  readonly logs: Logs;
} {
  const logs = new Logs();
  const captured: AgentStreamAssemblyDeps[] = [];
  const original = businessAssembly.createAgentStreamAssembly;
  const spy = vi.spyOn(businessAssembly, 'createAgentStreamAssembly').mockImplementation((deps) => {
    captured.push(deps);
    return original(deps);
  });
  const ports: AgentStreamProvidedPorts = {
    platforms: ['taobao', 'jd'],
    searchProducts: async () => [],
    readProduct: async () => {
      throw new Error('synthetic: readProduct is not used by these tests');
    },
    parsing: {} as AgentStreamProvidedPorts['parsing'],
    cards: () => {
      throw new Error('synthetic: cards are not used by these tests');
    },
    ...(categories === undefined ? {} : { categories }),
  };
  try {
    createProductionStreamAssembly({
      db: inertDb(),
      clock: new FixedClock(NOW),
      logger: logs.logger,
      contentReader: { configValue: async () => null },
      ports,
    });
  } finally {
    spy.mockRestore();
  }
  expect(captured, 'the production assembly builds one business assembly').toHaveLength(1);
  return { allowed: captured[0]!.ports.search.categoryAllowed, logs };
}

/** A rejection counts as not allowed (the search pipeline drops such a candidate as well). */
export async function verdict(
  allowed: CategoryAllowed,
  appId: string,
  row: AgentSearchCandidate,
): Promise<boolean> {
  try {
    return (await allowed(appId, row)) === true;
  } catch {
    return false;
  }
}
