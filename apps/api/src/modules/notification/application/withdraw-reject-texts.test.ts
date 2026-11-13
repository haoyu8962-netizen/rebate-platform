import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withdrawRejectReasonText } from './withdraw-reject-texts.ts';

const texts = (
  JSON.parse(
    readFileSync(
      new URL('../../../../../../contracts/texts.default.json', import.meta.url),
      'utf8',
    ),
  ) as { texts: Record<string, string> }
).texts;

const CODES = [
  'RISK_SUSPECT',
  'ORDER_ABNORMAL',
  'PAYEE_INFO_INVALID',
  'USER_REQUEST',
  'OTHER',
  'NEGATIVE_BALANCE',
];

describe('withdrawRejectReasonText', () => {
  it.each(CODES)('[AC-CT-26zo] %s reads withdraw_reject_reason.<CODE>.title', (code) => {
    const expected = texts[`withdraw_reject_reason.${code}.title`];
    expect(expected).toEqual(expect.any(String));
    expect(withdrawRejectReasonText(code)).toBe(expected);
  });

  it.each(['NOPE', '', 'hasOwnProperty', 'valueOf', '__proto__', 'other', null])(
    '[AC-CT-26zo] %s falls back to OTHER',
    (code) => {
      expect(withdrawRejectReasonText(code)).toBe(texts['withdraw_reject_reason.OTHER.title']);
    },
  );
});
