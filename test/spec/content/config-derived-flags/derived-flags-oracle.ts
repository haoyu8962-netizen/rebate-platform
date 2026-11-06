// F1-02zzze: the expected features.flags derivations, written from 04 §10.1 (features.flags row) and
// §10.2 (feedback.enabled, detail.jd_plus_note.enabled) only; never taken from the code under test.

/** One derived flag and the config_items key it is derived from. */
export interface Derivation {
  readonly flag: string;
  readonly source: string;
}

/** 01 F-PROD-15: the product feedback entry. */
export const PRODUCT_FEEDBACK: Derivation = {
  flag: 'product_feedback',
  source: 'feedback.enabled',
};
/** 08 BR-CALC-17: the PLUS note on JD product details. */
export const JD_PLUS_NOTE: Derivation = {
  flag: 'jd_plus_note',
  source: 'detail.jd_plus_note.enabled',
};
/** BR-ATTR-29 (already delivered before this task). */
export const UNION_HOST_BLOCK: Derivation = {
  flag: 'external_page.union_host_block',
  source: 'external_page.union_host_block',
};
/** BR-FUND-25 (already delivered before this task). */
export const DASHBOARD_VISIBLE: Derivation = {
  flag: 'earnings.dashboard.visible',
  source: 'earnings.dashboard.enabled',
};

/** The two derivations this task adds. */
export const NEW_DERIVED: readonly Derivation[] = [PRODUCT_FEEDBACK, JD_PLUS_NOTE];
/** Every derived flag of 04 §10.1, in the row's order. */
export const ALL_DERIVED: readonly Derivation[] = [
  UNION_HOST_BLOCK,
  DASHBOARD_VISIBLE,
  PRODUCT_FEEDBACK,
  JD_PLUS_NOTE,
];

/** Only a present JSON false turns a derived flag off; absent and every other value leave it on. */
export function derivedValue(sources: Readonly<Record<string, unknown>>, source: string): boolean {
  return !(Object.hasOwn(sources, source) && sources[source] === false);
}

/** The four derived flags for the given source rows (a key not in `sources` has no row). */
export function derivedFlags(sources: Readonly<Record<string, unknown>>): Record<string, boolean> {
  return Object.fromEntries(
    ALL_DERIVED.map(({ flag, source }) => [flag, derivedValue(sources, source)]),
  );
}

/** The base dictionary entries, then every derived flag over them (derived wins). */
export function expectedFlags(
  base: Readonly<Record<string, boolean>>,
  sources: Readonly<Record<string, unknown>>,
): Record<string, boolean> {
  return { ...base, ...derivedFlags(sources) };
}
