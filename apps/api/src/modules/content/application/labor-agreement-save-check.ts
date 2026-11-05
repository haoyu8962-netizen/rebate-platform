// B2-03x (D10-646): the save-time check of the six labor agreement keys (config.business) that
// identity's labor agreement reads (identity/domain/labor-agreement.ts: parseLaborAgreementConfig,
// parseOperatorEntity). There a value outside its shape is a configuration fault and
// GET /v1/withdrawals/rules answers 50001; here a write (single update, batch or rollback) that
// sets such a value is refused with 20001 fields=[that key]. Each test below is copied from
// identity line for line (identity exports none of them through its index.ts) and says which
// line it is aligned with. When both versions have a value, resign_from_version must not exceed
// version (identity faults on resign_from_version otherwise): each is taken from the same write
// when it sets it, else from the stored row (as the bridge_origins check takes h5_base_url). The
// refused key is the written one: resign_from_version when the write sets it, else version.
// ContentAdminModule combines it with the bridge_origins and default avatar checks and the
// assembler's checks; it runs only for writes of its own keys.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { ConfigItemSaveCheck } from './config-item-admin.ts';

export const LABOR_VERSION_KEY = 'legal.labor_agreement.version';
export const LABOR_TEXT_URL_KEY = 'legal.labor_agreement.text_url';
export const LABOR_TEXT_SHA256_KEY = 'legal.labor_agreement.text_sha256';
export const LABOR_RESIGN_FROM_VERSION_KEY = 'legal.labor_agreement.resign_from_version';
export const OPERATOR_NAME_KEY = 'legal.operator_entity.name';
export const OPERATOR_CREDIT_CODE_KEY = 'legal.operator_entity.credit_code';

/** The six keys, in registry order. */
export const LABOR_AGREEMENT_SAVE_KEYS: readonly string[] = Object.freeze([
  LABOR_VERSION_KEY,
  LABOR_TEXT_URL_KEY,
  LABOR_TEXT_SHA256_KEY,
  LABOR_RESIGN_FROM_VERSION_KEY,
  OPERATOR_NAME_KEY,
  OPERATOR_CREDIT_CODE_KEY,
]);

/** Aligned with identity/domain/labor-agreement.ts MAX_VERSION (consent_records.version, int32). */
const MAX_VERSION = 2_147_483_647;
/** Aligned with identity/domain/labor-agreement.ts SHA256. */
const SHA256 = /^[0-9a-f]{64}$/;
/** Aligned with identity/domain/labor-agreement.ts CREDIT_CODE (GB 32100-2015). */
const CREDIT_CODE = /^[0-9A-HJ-NPQRTUWXY]{18}$/;
/** Aligned with identity/domain/labor-agreement.ts MAX_ENTITY_NAME_LENGTH. */
const MAX_ENTITY_NAME_LENGTH = 200;

/** Aligned with identity/domain/labor-agreement.ts isVersion. */
export function laborVersionValid(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_VERSION
  );
}

/** Aligned with identity/domain/labor-agreement.ts isTextUrl. */
export function laborTextUrlValid(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value === '') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Aligned with the text_sha256 test of identity/domain/labor-agreement.ts parseLaborAgreementConfig. */
export function laborTextSha256Valid(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

/** Aligned with identity/domain/labor-agreement.ts isEntityName. */
export function operatorNameValid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.trim() === value &&
    [...value].length <= MAX_ENTITY_NAME_LENGTH
  );
}

/** Aligned with the credit_code test of identity/domain/labor-agreement.ts parseOperatorEntity. */
export function operatorCreditCodeValid(value: unknown): value is string {
  return typeof value === 'string' && CREDIT_CODE.test(value);
}

const SHAPES: ReadonlyArray<readonly [string, (value: unknown) => boolean]> = [
  [LABOR_VERSION_KEY, laborVersionValid],
  [LABOR_TEXT_URL_KEY, laborTextUrlValid],
  [LABOR_TEXT_SHA256_KEY, laborTextSha256Valid],
  [LABOR_RESIGN_FROM_VERSION_KEY, laborVersionValid],
  [OPERATOR_NAME_KEY, operatorNameValid],
  [OPERATOR_CREDIT_CODE_KEY, operatorCreditCodeValid],
];

export function laborAgreementSaveCheck(): ConfigItemSaveCheck {
  return {
    keys: LABOR_AGREEMENT_SAVE_KEYS,
    refusals(stored, written) {
      const refused: string[] = [];
      for (const [key, valid] of SHAPES) {
        if (written.has(key) && !valid(written.get(key))) refused.push(key);
      }
      const writesVersion = written.has(LABOR_VERSION_KEY);
      const writesResign = written.has(LABOR_RESIGN_FROM_VERSION_KEY);
      if (!writesVersion && !writesResign) return refused;
      // Aligned with identity/domain/labor-agreement.ts parseLaborAgreementConfig `resign > version`.
      const version = writesVersion
        ? written.get(LABOR_VERSION_KEY)
        : stored.get(LABOR_VERSION_KEY);
      const resign = writesResign
        ? written.get(LABOR_RESIGN_FROM_VERSION_KEY)
        : stored.get(LABOR_RESIGN_FROM_VERSION_KEY);
      if (laborVersionValid(version) && laborVersionValid(resign) && resign > version) {
        const key = writesResign ? LABOR_RESIGN_FROM_VERSION_KEY : LABOR_VERSION_KEY;
        if (!refused.includes(key)) refused.push(key);
      }
      return refused;
    },
  };
}
