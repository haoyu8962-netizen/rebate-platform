// B2-15b: business types registered for payment (08 BR-PAY-01 ① and 细则「业务类型登记的内容」; task
// §9.2). Registration is code: a new type needs its own BR entry, not just configuration. prod
// registers nothing; local / test / staging register only the test type `test_item` (1 fen,
// title 测试商品, sellable on the three apps, no user-side refund), used for 联调与验收 only.
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { AppEnv } from '../../platform/index.ts';
import { PAY_PLATFORMS } from '../domain/sellability.ts';
import type { PayPlatform } from '../domain/types.ts';

/** The server-side price of one business object (BR-PAY-01 ①: the client never sends an amount). */
export interface BizPrice {
  /** Positive integer fen. */
  readonly amountFen: bigint;
  /** Order title sent to the channel as the description. */
  readonly title: string;
}

export interface BizPriceInput {
  readonly appId: string;
  readonly userId: string;
  readonly bizRef: string;
}

/** What the fulfilment handler recomputes from (BR-PAY-01 细则「业务类型的接入要求」). */
export interface BizReconcileInput {
  readonly appId: string;
  readonly bizType: string;
  readonly bizRef: string;
  /** The business object currently has a PAID order. */
  readonly paid: boolean;
  /** Refunded fen of that order so far. */
  readonly refundedFen: bigint;
}

/**
 * Grant / revoke of one business object, run serially per object (pay_fulfillments, D10-168):
 * every run recomputes the entitlement from the current payment facts and sets it, never «add on
 * grant, subtract on revoke». Registered here, executed from B2-15c on.
 */
export interface BizFulfillmentHandler {
  reconcile(trx: Transaction<DB>, input: BizReconcileInput): Promise<void>;
}

/** One registered business type. */
export interface BizTypeEntry {
  /** biz_type code (contract PayBizType: ^[a-z][a-z0-9_]*$). */
  readonly code: string;
  /**
   * Whether the business object belongs to the caller (D10-1030 ②, the user's authorization
   * boundary): required, so no type can be registered without it. Asked before the price and before
   * anything is written; false for an object that does not exist as well as for someone else's.
   */
  ownedBy(input: BizPriceInput): Promise<boolean>;
  price(input: BizPriceInput): Promise<BizPrice>;
  /** Default sellable platforms; config `pay.biz.<biz_type>.platforms` replaces them. */
  readonly platforms: readonly PayPlatform[];
  readonly fulfillment: BizFulfillmentHandler;
  /** Whether the user side may ask for a refund (false for every type so far). */
  readonly userRefundAllowed: boolean;
}

export interface BizTypeRegistry {
  /** The registered type, or undefined (→ 30901 biz_not_sellable). */
  get(code: string): BizTypeEntry | undefined;
  list(): readonly BizTypeEntry[];
}

/** The non-production test business type (BR-PAY-01 细则「非生产环境有一个测试业务类型」). */
export const TEST_ITEM_BIZ_TYPE = 'test_item';
const TEST_ITEM_AMOUNT_FEN = 1n;
const TEST_ITEM_TITLE = '测试商品';

/**
 * The test type grants no entitlement: its reconcile recomputes nothing and writes nothing (it
 * exists so that 联调与验收 can exercise the order, notification, query, close and refund flows).
 */
const testItemFulfillment: BizFulfillmentHandler = {
  reconcile(): Promise<void> {
    return Promise.resolve();
  },
};

const testItem: BizTypeEntry = Object.freeze({
  code: TEST_ITEM_BIZ_TYPE,
  // The test type has no real business object: every biz_ref is the caller's.
  ownedBy(): Promise<boolean> {
    return Promise.resolve(true);
  },
  price(): Promise<BizPrice> {
    return Promise.resolve({ amountFen: TEST_ITEM_AMOUNT_FEN, title: TEST_ITEM_TITLE });
  },
  platforms: PAY_PLATFORMS,
  fulfillment: testItemFulfillment,
  userRefundAllowed: false,
});

function registryOf(entries: readonly BizTypeEntry[]): BizTypeRegistry {
  const byCode = new Map(entries.map((entry) => [entry.code, entry]));
  return {
    get(code) {
      return typeof code === 'string' ? byCode.get(code) : undefined;
    },
    list() {
      return [...entries];
    },
  };
}

/** The registry of an APP_ENV: empty in prod; `test_item` only in local / test / staging. */
export function createBizRegistry(appEnv: AppEnv): BizTypeRegistry {
  return registryOf(appEnv === 'prod' ? [] : [testItem]);
}
