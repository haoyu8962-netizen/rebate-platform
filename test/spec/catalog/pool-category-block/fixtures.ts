// B1-05zo (FU-POOL-CATEGORY-BLOCK; D10-1045 ② / D10-1058 / D10-1059): the console's product pool
// refuses a product whose category the app blocks. The frozen pool kit
// (test/spec/catalog/product-pool-admin/kit.ts) is reused read-only: real admin routes, real tables,
// the demo union adapter's normalized DTO stubbed on its prototype. Rows of app.category_blocklist
// are seeded directly (catalog reads them on every call). CT-26zf (30147 category_blocked) is not
// merged yet, so the refusal is asserted by its HTTP answer only, no generated constant.
// All values are synthetic.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
  contract,
  product,
  ROUTES,
  type Harness,
  type Sent,
  type Setup,
} from '../product-pool-admin/kit.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type { UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';

/** CT-26zf: the pool refuses a product of a blocked category (http 422). */
export const CATEGORY_BLOCKED = 30147;
export const MISSING_EVENT = 'catalog_category_missing';
export const BLOCKED_EVENT = 'catalog_category_blocked';
/** The message prefix of this use case's alerts (search uses `search:`). */
export const POOL_PREFIX = 'pool_admin:';

/** Synthetic decimal level-one category ids. */
export const BLOCKED = '9000501';
export const OPEN = '9000502';
/** A literal keyword of a rule; product() titles never contain it. */
export const KEYWORD = '合成禁词';

export interface Rule {
  readonly category: string;
  readonly keyword?: string | null;
  readonly platform?: string;
  readonly status?: string;
  /** Defaults to the setup's app. */
  readonly appId?: string;
}

/** One category_blocklist row; returns its id. */
export async function blockRule(
  h: Harness,
  f: Pick<Setup, 'appId' | 'clock'>,
  rule: Rule,
): Promise<string> {
  const id = randomUUID();
  await h.db
    .insertInto('category_blocklist')
    .values({
      id,
      app_id: rule.appId ?? f.appId,
      platform: rule.platform ?? 'taobao',
      category_id: rule.category,
      keyword: rule.keyword ?? null,
      reason: '合成禁售原因',
      status: rule.status ?? 'active',
      updated_by: 'synthetic-b1-05zo',
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .execute();
  return id;
}

export async function setRuleStatus(
  h: Harness,
  f: Pick<Setup, 'clock'>,
  id: string,
  status: string,
): Promise<void> {
  await h.db
    .updateTable('category_blocklist')
    .set({ status, updated_at: f.clock.now() })
    .where('id', '=', id)
    .execute();
}

/**
 * The kit's product with a level-one category: null leaves category_l1_id absent, '' sets an empty
 * string (both count as no category).
 */
export function goods(
  f: Pick<Setup, 'clock'>,
  stable: string,
  category: string | null,
  extra: Partial<UnionItemDetail> = {},
): UnionItemDetail {
  return product(f, stable, {
    ...(category === null ? {} : { category_l1_id: category }),
    ...extra,
  });
}

/** The union answered with details but flags the price (price_status=anomaly). */
export function anomalous(f: Pick<Setup, 'clock'>, item: UnionItemDetail): UnionItemDetail {
  return {
    ...item,
    price_fen: 5000n,
    coupon_fen: 500n,
    final_price_fen: 4500n,
    quoted_at: f.clock.now().toISOString(),
    price_status: 'anomaly',
    price_anomaly_reason: 'unknown_promo',
  };
}

type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
const errorValidators = new Map<string, Promise<Validator>>();

function errorValidator(op: Sent['op']): Promise<Validator> {
  const cached = errorValidators.get(op);
  if (cached !== undefined) return cached;
  const made = (async () => {
    const doc = await contract();
    const route = ROUTES[op];
    const schema: JsonSchema =
      doc.paths[route.path]![route.method.toLowerCase()]!.responses['4XX']!.content[
        'application/json'
      ]!.schema;
    return createValidatorCompiler()({ schema, httpPart: 'body' });
  })();
  errorValidators.set(op, made);
  return made;
}

/** 422 code 30147 with this request's trace id, in the operation's 4XX envelope. */
export async function categoryBlocked(sent: Sent): Promise<void> {
  expect(sent.response.statusCode, JSON.stringify(sent.response.json())).toBe(422);
  expect(sent.response.json()).toMatchObject({ code: CATEGORY_BLOCKED, trace_id: sent.trace });
  const check = await errorValidator(sent.op);
  expect(check(sent.response.json()), JSON.stringify(check.errors)).toBe(true);
}

export type LogRecord = Readonly<Record<string, unknown>>;

/** Records of `event` whose message carries the pool prefix, among the given log lines. */
export function poolAlerts(lines: readonly string[], event: string): LogRecord[] {
  const out: LogRecord[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as LogRecord;
    const msg = record['msg'];
    if (record['event'] === event && typeof msg === 'string' && msg.startsWith(POOL_PREFIX)) {
      out.push(record);
    }
  }
  return out;
}

/**
 * Exactly one pool-prefixed warn of `event` for one taobao item (platform and count), which shows
 * none of `hidden` (titles, keys, raw IDs, the operator).
 */
export function expectPoolAlert(
  lines: readonly string[],
  event: string,
  hidden: readonly string[],
): void {
  const found = poolAlerts(lines, event);
  expect(found, event).toEqual([
    expect.objectContaining({ level: 40, event, platform: 'taobao', count: 1 }),
  ]);
  const text = JSON.stringify(found);
  for (const value of hidden) expect(text, event).not.toContain(value);
}
