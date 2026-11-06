// B1-05zh (S-19, D10-713, BR-PROD-04, BR-AI-24): the Agent search card (agent/tools/search/card.ts)
// copies the catalog card's price_spec_hint unchanged. It is not derived from match_tag (match_tag is
// the per-card condition mark; 「标记不改变本条的价格限定语」), not recomputed, and survives the guest
// login_to_view mask. Read loosely: the Agent card type gains the field with CT-26v.
import { expect, it } from 'vitest';
import type { UnlinkedCard } from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  maskLoginToView,
  normalizeCard,
  type NormalizeOptions,
} from '../../../../apps/api/src/modules/agent/tools/search/card.ts';
import { EXPECTED, NOW, SHAPES, assembler, expectHint, requestOf, type Shape } from './kit.ts';

const NOW_MS = Date.parse(NOW);

function options(card: UnlinkedCard, overrides: Partial<NormalizeOptions> = {}): NormalizeOptions {
  // Prepared catalog cards always carry a product_key; a null one cannot match, so normalizeCard
  // returns null and the test's not.toBeNull() assertion fails loudly instead of passing silently.
  return {
    productKey: card.product_key ?? '',
    nowMs: NOW_MS,
    maxAgeSec: 3600,
    loginToView: false,
    ...overrides,
  };
}

/** A real prepared catalog card, then its hint / match_tag set as a given catalog would carry. */
async function catalogCard(
  shape: Shape,
  patch: Readonly<Record<string, unknown>>,
): Promise<UnlinkedCard> {
  const f = assembler();
  const prepared = await f.service.prepare(requestOf(shape, { entrySource: 'agent' }));
  const card: Record<string, unknown> = { ...prepared.card };
  delete card['price_spec_hint'];
  delete card['match_tag'];
  return { ...card, ...patch } as unknown as UnlinkedCard;
}

const HINTS = ['spec_uncertain', null, 'price_from'] as const;
const MATCH_TAGS = ['matched', 'relaxed', 'spec_unconfirmed', undefined] as const;

for (const hint of HINTS) {
  it.each(MATCH_TAGS)(
    `[AC-B1-05zh#17][BR-PROD-04][BR-AI-24] Agent 搜索卡照抄 ${String(hint)}，与条件标记 %s 无关`,
    async (match) => {
      const patch =
        match === undefined
          ? { price_spec_hint: hint }
          : { price_spec_hint: hint, match_tag: match };
      const card = await catalogCard('taobao', patch);
      const out = normalizeCard(card, options(card));
      expect(out).not.toBeNull();
      if (out === null) return;
      expect(out.match_tag).toBe(match ?? 'matched');
      expectHint(out as unknown as Record<string, unknown>, hint);
    },
  );

  it(`[AC-B1-05zh#18][BR-AI-11][BR-PROD-04] 游客 login_to_view 遮罩后仍照抄 ${String(hint)}`, async () => {
    const card = await catalogCard('jd_sku', {
      price_spec_hint: hint,
      match_tag: 'spec_unconfirmed',
    });
    const out = normalizeCard(card, options(card, { loginToView: true }));
    expect(out).not.toBeNull();
    if (out === null) return;
    const masked = maskLoginToView(out);
    expect(masked.rebate_basis).toBe('login_required');
    expectHint(masked as unknown as Record<string, unknown>, hint);
  });
}

it('[AC-B1-05zh#19][BR-PROD-04] 目录卡缺 price_spec_hint（按契约读作 null）时 Agent 卡给 null，不自行改成 spec_uncertain', async () => {
  const card = await catalogCard('taobao', { match_tag: 'spec_unconfirmed' });
  expect(card).not.toHaveProperty('price_spec_hint');
  const out = normalizeCard(card, options(card));
  expect(out).not.toBeNull();
  if (out === null) return;
  expectHint(out as unknown as Record<string, unknown>, null);
});

it.each(SHAPES)(
  '[AC-B1-05zh#20][BR-PROD-04] %s：目录出卡器的判定原样到 Agent 搜索卡（同一判定）',
  async (shape) => {
    const f = assembler();
    const prepared = await f.service.prepare(requestOf(shape, { entrySource: 'agent' }));
    const out = normalizeCard(prepared.card, options(prepared.card));
    expect(out).not.toBeNull();
    if (out === null) return;
    expectHint(out as unknown as Record<string, unknown>, EXPECTED[shape]);
    expectHint(maskLoginToView(out) as unknown as Record<string, unknown>, EXPECTED[shape]);
  },
);
