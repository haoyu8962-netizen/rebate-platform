// B1-09y 规则测试共用：08 BR-TEXT-05「子原因 reason_sub」表（父编码 → 子原因）、合成的不合法存量值、
// 捕获 pino 行的 logger（真 createRootLogger，写到内存），以及按订单查 warn 行的小工具。
// 只读复用 ../list-detail/ 的夹具，不改它们。
import type { OrderReasonSub } from '../../../../packages/contracts-ts/src/index.ts';
import { expect } from 'vitest';
import {
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { queries, type Fixture } from '../list-detail/kit.ts';

/** BR-TEXT-05 子原因表：每个子原因只属于一个父编码。 */
export const SUBS = {
  PUNISH: [
    'VIOLATION_PROMO',
    'SHOP_TK',
    'INSITE_PROMO',
    'PROXY_BUY',
    'FAKE_TRADE',
    'INSITE_RESALE',
    'OVER_LIMIT',
    'MARKET_DISRUPT',
    'MULTI_TRADE_ABNORMAL',
    'SINGLE_TRADE_ABNORMAL',
    'RISK_ORDER',
    'PUNISH_ORDER',
  ],
  REFUND: ['IN_SALE', 'AFTER_SETTLE'],
  RIGHTS: ['AFTER_SALE'],
} as const satisfies Record<'PUNISH' | 'REFUND' | 'RIGHTS', readonly OrderReasonSub[]>;

export type SubParent = keyof typeof SUBS;
export const SUB_PARENTS = Object.keys(SUBS) as SubParent[];

/** Every (父编码, 子原因) pair of the table, 15 in all. */
export const VALID_PAIRS: readonly { reason: SubParent; reason_sub: OrderReasonSub }[] =
  SUB_PARENTS.flatMap((reason) =>
    (SUBS[reason] as readonly OrderReasonSub[]).map((reason_sub) => ({ reason, reason_sub })),
  );

/** Parents with no sub-reason of their own (orders_reason_check minus PUNISH / REFUND / RIGHTS). */
export const OTHER_PARENTS = [
  'PRESALE_UNPAID',
  'COMMISSION_ZERO',
  'OTHER',
  'BLACKLIST',
  'PART_REFUND',
  'PRICE_COMPARE',
  'PRICE_PROTECT',
  'SETTLE_DIFF',
] as const;

/** A stored value of another parent: enum order_reason_sub, but not a sub-reason of `reason`. */
export const FOREIGN_PAIRS = [
  { reason: 'REFUND', reason_sub: 'FAKE_TRADE' },
  { reason: 'PUNISH', reason_sub: 'AFTER_SALE' },
  { reason: 'RIGHTS', reason_sub: 'IN_SALE' },
  { reason: 'PUNISH', reason_sub: 'AFTER_SETTLE' },
  { reason: 'REFUND', reason_sub: 'AFTER_SALE' },
] as const;

/** A stored value outside enum order_reason_sub (「无」 is never stored as a value; case matters). */
export const UNKNOWN_PAIRS = [
  { reason: 'PUNISH', reason_sub: 'BOGUS_SUB' },
  { reason: 'REFUND', reason_sub: 'none' },
  { reason: 'RIGHTS', reason_sub: 'after_sale' },
  { reason: 'PUNISH', reason_sub: '' },
] as const;

export const BAD_PAIRS: readonly { reason: string; reason_sub: string }[] = [
  ...FOREIGN_PAIRS,
  ...UNKNOWN_PAIRS,
];

export type LogLine = Record<string, unknown>;

/** A real pino root logger writing to memory, as the queries' logger dependency. */
export function captureLogger() {
  const raw: string[] = [];
  const logger: RootLogger = createRootLogger(
    { entry: 'api', appEnv: 'test', level: 'info' },
    {
      write: (line) => {
        raw.push(line);
      },
    },
  );
  const lines = (): LogLine[] =>
    raw
      .join('')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as LogLine);
  /** Warn lines that carry an alert code (the only kind B1-09y adds). */
  const alerts = (): LogLine[] =>
    lines().filter(
      (line) =>
        (line.level === 40 || line.level === 'warn') &&
        typeof line.alert === 'string' &&
        line.alert !== '',
    );
  return { logger, raw, lines, alerts };
}
export type CapturedLogger = ReturnType<typeof captureLogger>;

/** The fixture's queries with the capturing logger wired in. */
export async function loggedQueries(f: Fixture, log: CapturedLogger) {
  return queries({ ...f.deps, logger: log.logger });
}

/** Alert lines naming this exact parent code and stored sub-reason among their flat values. */
export function alertsFor(log: CapturedLogger, reason: string, reasonSub: string): LogLine[] {
  return log.alerts().filter((line) => {
    const values = Object.values(line);
    return values.includes(reason) && values.includes(reasonSub);
  });
}

/** Flat fields only; no order number, order id, user or amount in any alert line. */
export function expectAlertsPrivate(
  log: CapturedLogger,
  rows: readonly {
    order_id: string;
    user_id: string | null;
    sub_order_id: string;
    parent_order_id?: string | null;
  }[],
) {
  for (const line of log.alerts()) {
    for (const [key, value] of Object.entries(line)) {
      expect(key).not.toMatch(/order_id|order_no|user|uid|fen|amount|buyer|phone/i);
      expect(value === null || typeof value !== 'object', `${key} is flat`).toBe(true);
    }
    const text = JSON.stringify(line);
    for (const row of rows) {
      expect(text).not.toContain(row.order_id);
      if (row.user_id) expect(text).not.toContain(row.user_id);
      expect(text).not.toContain(row.sub_order_id);
      if (row.parent_order_id) expect(text).not.toContain(row.parent_order_id);
    }
  }
}

/** The one item of a list page with this id. */
export function itemOf<T extends { order_id: string }>(items: readonly T[], orderId: string): T {
  const found = items.find((item) => item.order_id === orderId);
  expect(found, `list item ${orderId}`).toBeDefined();
  return found as T;
}

/** A terminal order of `reason` (VOID → INVALID) as the fixture seeds it. */
export function voided(reason: string | null, reasonSub: string | null) {
  return {
    rebate_status: 'VOID',
    platform_status: 'INVALID',
    reason,
    reason_sub: reasonSub,
  } as const;
}
