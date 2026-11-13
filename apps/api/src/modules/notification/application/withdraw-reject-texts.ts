// CT-26zo (BR-TEXT-08 驳回原因表, D10-1523 ②): the user copy of a withdrawal reject reason, read from
// contracts/texts.default.json keys withdraw_reject_reason.<CODE>.title — the one place the six
// sentences live (the App reads the same keys through /v1/dict). Codes follow contracts/enums/fund.yaml.
import { readFileSync } from 'node:fs';

const document = JSON.parse(
  readFileSync(new URL('../../../../../../contracts/texts.default.json', import.meta.url), 'utf8'),
) as { texts: Record<string, unknown> };

/** contracts/enums/fund.yaml withdraw_reject_reason (BR-WDR-10). */
const CODES = [
  'RISK_SUSPECT',
  'ORDER_ABNORMAL',
  'PAYEE_INFO_INVALID',
  'USER_REQUEST',
  'OTHER',
  'NEGATIVE_BALANCE',
] as const;

const FALLBACK_CODE = 'OTHER';

function textOf(code: string): string {
  const key = `withdraw_reject_reason.${code}.title`;
  const value = Object.hasOwn(document.texts, key) ? document.texts[key] : undefined;
  if (typeof value !== 'string' || value === '') throw new Error(`Missing text ${key}`);
  return value;
}

// Read once at load; a missing key fails startup rather than a push.
const TEXTS: ReadonlyMap<string, string> = new Map(CODES.map((code) => [code, textOf(code)]));
const FALLBACK = TEXTS.get(FALLBACK_CODE) as string;

/** The reason sentence of a reject code; an unknown, empty or missing code gets OTHER's sentence. */
export function withdrawRejectReasonText(code: string | null): string {
  return (code !== null ? TEXTS.get(code) : undefined) ?? FALLBACK;
}
