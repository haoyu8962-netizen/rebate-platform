// B1-04zzzv (D10-946, FU-AGENT-CATEGORY-BATCH): fixtures for the batched category judgement of
// the production stream assembly. The production categoryAllowed is still taken through the
// frozen B1-04zzy kit (productionCategoryAllowed, read-only reuse); this kit adds a plain-object
// catalog port (no vi.fn, so property runs keep no mock registrations) that records every call
// (app, the field names and values of each item) and can fail per app, either by throwing
// synchronously or by rejecting. It judges with catalog's own rule function (filterByRules), which
// returns the kept item objects themselves. Synthetic values only.
import type { CategoryCandidate } from '../../../../apps/api/src/modules/catalog/index.ts';
import type { CategoryRule } from '../../../../apps/api/src/modules/catalog/domain/types.ts';
import { filterByRules } from '../../../../apps/api/src/modules/catalog/domain/rules.ts';
import type { AgentSearchCandidate } from '../../../../apps/api/src/modules/agent/tools/search/index.ts';
import {
  verdict,
  type AgentCategoryPort,
  type CategoryAllowed,
  type Logs,
} from '../category-blocklist/kit.ts';

export const BLOCKLIST_EVENT = 'agent_category_blocklist_failed';
export const ERROR_NAME = 'SyntheticBlocklistError';
/** The only fields an item handed to the port may carry, sorted. */
export const ITEM_FIELDS: readonly string[] = ['categoryId', 'platform', 'title'];

export class SyntheticBlocklistError extends Error {
  constructor() {
    super('synthetic blocklist read failure');
    this.name = ERROR_NAME;
  }
}

export type FailMode = 'throw' | 'reject';

export interface BatchCall {
  readonly appId: string;
  /** Own field names of each item, sorted. */
  readonly fields: readonly (readonly string[])[];
  /** Each item's values; a null category is recorded as '' (both mean "no category"). */
  readonly items: readonly CategoryCandidate[];
}

/** Catalog's port as a plain object: rules per app, failures per app, every call recorded. */
export function batchPort() {
  const rules = new Map<string, CategoryRule[]>();
  const failing = new Map<string, FailMode>();
  const calls: BatchCall[] = [];
  const port: AgentCategoryPort = {
    filterCategories<T extends CategoryCandidate>(
      appId: string,
      items: readonly T[],
    ): Promise<T[]> {
      calls.push({
        appId,
        fields: items.map((item) => Object.keys(item).sort()),
        items: items.map((item) => ({
          platform: item.platform,
          categoryId: item.categoryId ?? '',
          title: item.title,
        })),
      });
      const mode = failing.get(appId);
      if (mode === 'throw') throw new SyntheticBlocklistError();
      if (mode === 'reject') return Promise.reject(new SyntheticBlocklistError());
      return Promise.resolve(filterByRules(items, rules.get(appId) ?? []));
    },
  };
  return { port, rules, failing, calls };
}

/** What the port should receive for one candidate. */
export function sent(row: AgentSearchCandidate): CategoryCandidate {
  return { platform: row.item.platform, categoryId: row.categoryId, title: row.item.title };
}

/** The candidate judged alone by catalog's rule function: true when it is kept. */
export function judgedAlone(rules: readonly CategoryRule[], row: AgentSearchCandidate): boolean {
  return filterByRules([sent(row)], rules).length === 1;
}

/** One categoryAllowed request: the app and the candidate. */
export type Judgement = readonly [appId: string, row: AgentSearchCandidate];

/** All requests started in one synchronous run (one round of the search pipeline). */
export function together(
  allowed: CategoryAllowed,
  requests: readonly Judgement[],
): Promise<boolean[]> {
  return Promise.all(requests.map(([appId, row]) => verdict(allowed, appId, row)));
}

/** The same requests one at a time, each awaited before the next starts. */
export async function oneByOne(
  allowed: CategoryAllowed,
  requests: readonly Judgement[],
): Promise<boolean[]> {
  const verdicts: boolean[] = [];
  for (const [appId, row] of requests) verdicts.push(await verdict(allowed, appId, row));
  return verdicts;
}

/** Pino's envelope of every line (root logger base, time, level, message). */
const ENVELOPE = new Set([
  'level',
  'time',
  'entry',
  'env',
  'deployVersion',
  'pid',
  'hostname',
  'msg',
]);

/** A warn line's own fields (the envelope removed). */
export function warnFields(line: string): Record<string, unknown> {
  const record = JSON.parse(line) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !ENVELOPE.has(key)));
}

/** Warn lines written since `from` warn lines had been written. */
export function warningsSince(logs: Logs, from: number): string[] {
  return logs.warnings().slice(from);
}

/** Every value that identifies the product: none may appear in a warn line. */
export function productValues(row: AgentSearchCandidate): string[] {
  return [row.item.item_id, row.ref.productKey, row.ref.rawItemId, row.item.title].filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
}

/** Platforms of a batch as the warn names them: distinct, sorted, comma-joined. */
export function platformsOf(rows: readonly AgentSearchCandidate[]): string {
  return [...new Set(rows.map((row) => row.item.platform))].sort().join(',');
}
