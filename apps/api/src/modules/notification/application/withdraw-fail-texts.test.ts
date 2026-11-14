import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withdrawFailReasonText } from './withdraw-fail-texts.ts';

const texts = (
  JSON.parse(
    readFileSync(
      new URL('../../../../../../contracts/texts.default.json', import.meta.url),
      'utf8',
    ),
  ) as { texts: Record<string, string> }
).texts;

const CODES = [
  'PAYEE_NOT_EXIST',
  'PAYEE_USER_INFO_ERROR',
  'PAYEE_ACCOUNT_STATUS_ERROR',
  'USER_CONFIRM_TIMEOUT',
  'USER_REQUEST_CANCEL',
];

describe('withdrawFailReasonText', () => {
  it.each(CODES)('[AC-CT-26zp] %s reads withdraw_fail_reason.<CODE>.title', (code) => {
    const expected = texts[`withdraw_fail_reason.${code}.title`];
    expect(expected).toEqual(expect.any(String));
    expect(withdrawFailReasonText(code)).toBe(expected);
  });

  it.each([
    'NOPE',
    '',
    'default',
    'hasOwnProperty',
    'valueOf',
    '__proto__',
    'payee_not_exist',
    null,
  ])('[AC-CT-26zp] %s falls back to withdraw_fail_reason.default.title', (code) => {
    const expected = texts['withdraw_fail_reason.default.title'];
    expect(expected).toEqual(expect.any(String));
    expect(withdrawFailReasonText(code)).toBe(expected);
  });
});
