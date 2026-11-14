// CT-26zp (BR-TEXT-08 失败原因映射, BR-WDR-33 ⑥, D10-1525): the user copy of a withdrawal fail code,
// read from contracts/texts.default.json keys withdraw_fail_reason.<CODE>.title, with
// withdraw_fail_reason.default.title for an unmapped code (D10-228: the fallback without an amount,
// used as {reason}). The one place the sentences live; the App reads the same keys through /v1/dict.
import { readFileSync } from 'node:fs';

const document = JSON.parse(
  readFileSync(new URL('../../../../../../contracts/texts.default.json', import.meta.url), 'utf8'),
) as { texts: Record<string, unknown> };

/** BR-TEXT-08 细则「失败原因映射」 codes and the WeChat fail_code items (BR-WDR-33 ⑥). */
const CODES = [
  'PAYEE_NOT_EXIST',
  'PAYEE_USER_INFO_ERROR',
  'PAYEE_ACCOUNT_STATUS_ERROR',
  'USER_CONFIRM_TIMEOUT',
  'USER_REQUEST_CANCEL',
] as const;

const FALLBACK_KEY = 'default';

function textOf(code: string): string {
  const key = `withdraw_fail_reason.${code}.title`;
  const value = Object.hasOwn(document.texts, key) ? document.texts[key] : undefined;
  if (typeof value !== 'string' || value === '') throw new Error(`Missing text ${key}`);
  return value;
}

// Read once at load; a missing key fails startup rather than a push.
const TEXTS: ReadonlyMap<string, string> = new Map(CODES.map((code) => [code, textOf(code)]));
const FALLBACK = textOf(FALLBACK_KEY);

/** The reason sentence of a fail code; an unknown, empty or missing code gets the fallback. */
export function withdrawFailReasonText(code: string | null): string {
  return (code !== null ? TEXTS.get(code) : undefined) ?? FALLBACK;
}
