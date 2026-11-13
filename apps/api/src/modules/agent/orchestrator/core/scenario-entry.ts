// B3-05q · BR-AI-01 细则「情境入口」: which entry a run's context names. No imports: the core reads
// it (run.ts) without depending on the entry path's data side (../entry/index.ts, tools/*).

/** The entry a message's context names (context.text is never an entry). */
export type ScenarioEntry =
  | { readonly kind: 'product'; readonly productKey: string }
  | { readonly kind: 'order'; readonly orderId: string };

/**
 * BR-PROD-02 format step (the pattern tools/quote applies to a product_key): prefix 2–3 lower-case
 * letters, stable_id 1–124 printable ASCII without `#`, `/`, `?`.
 */
const PRODUCT_KEY = /^[a-z]{2,3}:[\x21\x22\x24-\x2E\x30-\x3E\x40-\x7E]{1,124}$/u;
/** 04 Id (uuid). */
const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a well-formed product_key (BR-PROD-02 format only; the catalog checks the rest). */
export function isEntryProductKey(value: unknown): value is string {
  return typeof value === 'string' && PRODUCT_KEY.test(value);
}

/**
 * The entry of a run's context: product_key alone (well formed) or order_id alone (an Id). No
 * context, text, both keys or a malformed value: null — the message is handled as one without an
 * entry (the HTTP layer already refuses malformed shapes with 20001; BR-AI-05: a malformed
 * product_key reads no catalog and makes no card).
 */
export function scenarioEntryOf(
  context: Readonly<Record<string, unknown>> | undefined,
): ScenarioEntry | null {
  if (!isRecord(context)) return null;
  const productKey = context['product_key'];
  const orderId = context['order_id'];
  if (productKey !== undefined && orderId === undefined) {
    return isEntryProductKey(productKey) ? { kind: 'product', productKey } : null;
  }
  if (orderId !== undefined && productKey === undefined) {
    return typeof orderId === 'string' && ORDER_ID.test(orderId)
      ? { kind: 'order', orderId }
      : null;
  }
  return null;
}
