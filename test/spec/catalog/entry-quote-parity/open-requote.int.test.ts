// B1-05zc (D10-641; BR-PRICE-07, BR-PRICE-13): the open re-check of a taobao search card quotes
// through catalog's card entry like every other pre-order entry, so new_rebate_* is the single
// amount of the union commission field. Linking's open-requote kit keeps registration, ownership,
// idempotency and the database real; only its quote double is replaced by a parity quoter.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  databaseFixture,
  fixture,
  service,
  source,
  success,
} from '../../linking/open-requote/kit.ts';
import { COMPARE_KEY, PRICE, QUOTER_KINDS, quoterOf, readKeys } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each(QUOTER_KINDS)(
  '[AC-B1-05zc#9] BR-PRICE-07 / BR-PRICE-13：淘宝搜索卡打开复核，新返利为接口金额单值 269–269，不读比价系数（%s 报价器）',
  async (kind) => {
    const f = fixture(database());
    const q = quoterOf(kind);
    f.quote.mockImplementation((item, viewer, context) => q.quoter.quote(item, viewer, context));
    // No coupon here: the open kit's source card is coupon-free; 2990 × 20% → N 539 → own 269.
    const original = await source(f, PRICE.final_price_fen, {
      commission_rate_bp: PRICE.commission_rate_bp,
    });
    expect(original.entry_source).toBe('search');
    const result = success(await service(f).open(f.request(original.link_id)));
    expect(result).toMatchObject({
      price_changed: false,
      requote_failed: false,
      new_rebate_min_fen: '269',
      new_rebate_max_fen: '269',
    });
    expect(q.contexts).toEqual([expect.objectContaining({ rebateBasis: 'normal' })]);
    expect(readKeys(q.config)).not.toContain(COMPARE_KEY);
  },
);
