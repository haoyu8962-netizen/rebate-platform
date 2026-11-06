// B1-05zh (S-19, D10-713, BR-PROD-04): shared fixtures for the price_spec_hint rule tests.
// Entirely synthetic: no platform recording, real URL, credential or I/O.
//
// How a card's JD mode is visible to the card path: no card-building port reads configuration, so
// the mode is the one the card's own identity was derived under (BR-PROD-03, packages/domain
// deriveProductKey): item mode gives `jd:i_<second segment of itemId>` with raw_item_id = itemId;
// sku mode gives `jd:<skuId>` with raw_item_id = skuId. Both JD union items below carry an itemId
// AND a skuId, so the union item fields alone never tell the mode (B1-05w#34: no guessing from the
// entry); only the derived product_key / raw_item_id differ.
import { expect, vi } from 'vitest';
import {
  createCardAssembler,
  createCatalogCardEntry,
  type CardAssembler,
  type CatalogCardEntry,
  type ProductCard,
  type ProductRef,
  type RebateQuote,
  type RegisterLinkInput,
  type UnlinkedCard,
  type Viewer,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import type {
  AssembleCardInput,
  CardQuoteContext,
} from '../../../../apps/api/src/modules/catalog/application/card-assembler.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionItem } from '../../../../apps/api/src/modules/union/index.ts';

export const APP_ID = 'spec-hint-app';
export const QUOTED_AT = '2026-11-06T10:00:00+08:00';
export const NOW = '2026-11-06T10:01:00+08:00';

/** The card shapes of BR-PROD-04 as this task decides them (D10-713). */
export type Shape = 'taobao' | 'pdd' | 'jd_item' | 'jd_sku';

/** Expected price_spec_hint per shape: null only where the price is known to be that SKU's. */
export const EXPECTED: Readonly<Record<Shape, 'spec_uncertain' | null>> = {
  taobao: 'spec_uncertain',
  pdd: 'spec_uncertain',
  jd_item: 'spec_uncertain',
  jd_sku: null,
};

export const SHAPES: readonly Shape[] = ['taobao', 'pdd', 'jd_item', 'jd_sku'];

const JD_ITEM_ID = 'Synth7Q_100200';
const JD_SKU_ID = '100012043978';

interface Identity {
  readonly item: Partial<UnionItem> & Pick<UnionItem, 'platform'>;
  readonly productKey: string;
  readonly rawItemId: string;
}

function identityOf(shape: Shape): Identity {
  switch (shape) {
    case 'taobao':
      return {
        item: { platform: 'taobao', item_id: 'synthAbc-778899' },
        productKey: 'tb:778899',
        rawItemId: 'synthAbc-778899',
      };
    case 'pdd':
      return {
        item: { platform: 'pdd', goods_id: '556677', goods_sign: 'synth-goods-sign' },
        productKey: 'pdd:556677',
        rawItemId: 'synth-goods-sign',
      };
    case 'jd_item':
      return {
        item: { platform: 'jd', itemId: JD_ITEM_ID, skuId: JD_SKU_ID },
        productKey: 'jd:i_100200',
        rawItemId: JD_ITEM_ID,
      };
    case 'jd_sku':
      return {
        item: { platform: 'jd', itemId: JD_ITEM_ID, skuId: JD_SKU_ID },
        productKey: `jd:${JD_SKU_ID}`,
        rawItemId: JD_SKU_ID,
      };
  }
}

export function itemOf(shape: Shape, overrides: Partial<UnionItem> = {}): UnionItem {
  return {
    title: '合成牛奶 250ml*12 盒',
    price_fen: 5900n,
    coupon_fen: 1000n,
    final_price_fen: 4900n,
    commission_rate_bp: 1000n,
    quoted_at: QUOTED_AT,
    ...identityOf(shape).item,
    ...overrides,
  };
}

export function refOf(shape: Shape, overrides: Partial<ProductRef> = {}): ProductRef {
  const identity = identityOf(shape);
  return {
    appId: APP_ID,
    platform: identity.item.platform,
    productKey: identity.productKey,
    rawItemId: identity.rawItemId,
    rawFetchedAt: QUOTED_AT,
    receivedAt: QUOTED_AT,
    canonicalUrl: null,
    title: '合成牛奶 250ml*12 盒',
    shopId: null,
    shopType: null,
    source: 'search',
    ...overrides,
  };
}

export function requestOf(
  shape: Shape,
  overrides: Partial<AssembleCardInput> = {},
): AssembleCardInput {
  return {
    item: itemOf(shape),
    ref: refOf(shape),
    entrySource: 'search',
    stale: false,
    ...overrides,
  };
}

export function viewer(): Viewer {
  return { appId: APP_ID, userId: 'spec-hint-user', deviceId: 'spec-hint-device' };
}

export function normalQuote(overrides: Partial<RebateQuote> = {}): RebateQuote {
  return {
    rebateMinFen: 245n,
    rebateMaxFen: 245n,
    estNetPriceFen: 4655n,
    rebateBasis: 'normal',
    ...overrides,
  };
}

export function noRebateQuote(): RebateQuote {
  return { rebateMinFen: 0n, rebateMaxFen: 0n, estNetPriceFen: null, rebateBasis: 'no_rebate' };
}

/** The card ports as doubles; the quote double answers one normal amount (D10-641). */
export function ports() {
  const clock = new FixedClock(NOW);
  const quote = vi.fn(
    async (
      _item: UnionItem,
      _viewer: Viewer,
      _context?: CardQuoteContext,
    ): Promise<RebateQuote> => {
      void _item;
      void _viewer;
      void _context;
      return normalQuote();
    },
  );
  const register = vi.fn(async (_input: RegisterLinkInput) => {
    void _input;
    return { linkId: 'spec-hint-link' };
  });
  const entrySource = vi.fn(async (): Promise<string | null> => 'search');
  return {
    clock,
    quote,
    register,
    entrySource,
    options: {
      clock,
      viewerContext: { current: async () => viewer() },
      quoter: { quote },
      registrar: { register },
      sourceLinks: { entrySource },
      itemRefs: { issue: () => 'spec-hint-item-ref' },
    },
  };
}

export function assembler(): { readonly service: CardAssembler } & ReturnType<typeof ports> {
  const p = ports();
  return { ...p, service: createCardAssembler(p.options) };
}

export function cardEntry(): { readonly entry: CatalogCardEntry } & ReturnType<typeof ports> {
  const p = ports();
  return { ...p, entry: createCatalogCardEntry({ ...p.options, logger: { warn: vi.fn() } }) };
}

/** Read loosely: the generated card type may or may not list the field yet. */
export function hintOf(card: ProductCard | UnlinkedCard | Readonly<Record<string, unknown>>) {
  return (card as Readonly<Record<string, unknown>>)['price_spec_hint'];
}

/**
 * The field is present with exactly this value. Absent is not accepted for null: the card path
 * writes the decision on every card (BR-PROD-04 「卡片和详情页的价格旁必须显示」, D10-713).
 */
export function expectHint(
  card: ProductCard | UnlinkedCard | Readonly<Record<string, unknown>>,
  expected: 'spec_uncertain' | 'price_from' | null,
): void {
  expect(card).toHaveProperty('price_spec_hint');
  expect(hintOf(card)).toBe(expected);
  // This phase never produces price_from on its own (D10-713): only copies may carry it.
  if (expected !== 'price_from') expect(hintOf(card)).not.toBe('price_from');
}
