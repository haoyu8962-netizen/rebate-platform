// B1-02zza rule-test helpers. Every number is a synthetic 199 number drawn per test and the fixed
// code is a synthetic value: no real node value appears here (D10-611: the node gives them).
import { randomInt } from 'node:crypto';
import { expect } from 'vitest';
import type { SmsCodeOptions } from '../../../../apps/api/src/modules/identity/application/sms-codes.ts';

export const PHONES_ENV = 'STAGING_TEST_PHONES';
export const CODE_FILE_ENV = 'STAGING_TEST_SMS_CODE_FILE';
/** Synthetic fixed code of the tests. */
export const FIXED = '246813';
export const AUDIT_EVENT = 'staging_test_phone_login';

/** A synthetic 199 number. */
export function testPhone(): string {
  return `199${Array.from({ length: 8 }, () => randomInt(10)).join('')}`;
}

/** `count` different synthetic 199 numbers. */
export function distinctPhones(count: number): string[] {
  const phones = new Set<string>();
  while (phones.size < count) phones.add(testPhone());
  return [...phones];
}

/** BR-ID-33 default mask of an 11-digit mainland number (199****1234). */
export function masked(phone: string): string {
  return `${phone.slice(0, 3)}****${phone.slice(7)}`;
}

/** Six-digit codes that are not the fixed code. */
export function wrongCodes(count: number): string[] {
  return ['000000', '111111', '222222', '333333', '444444', '555555', '666666']
    .filter((code) => code !== FIXED)
    .slice(0, count);
}

/** Overrides of the SMS code fixture for a staging service with these test phones. */
export function staging(
  phones: readonly string[],
  extra: Partial<SmsCodeOptions> = {},
): Partial<SmsCodeOptions> {
  return { appEnv: 'staging', stagingTestPhones: { phones, code: FIXED }, ...extra };
}

/** The parsed pino lines of the audit event. */
export function auditLines(lines: readonly string[]): Record<string, unknown>[] {
  return lines
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry['event'] === AUDIT_EVENT);
}

/** Neither the full number (in any of the written forms) nor the fixed code is in `text`. */
export function expectNoLeak(text: string, phone: string, code = FIXED): void {
  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toContain(phone);
  expect(text).not.toContain(`+86 ${phone}`);
  expect(text).not.toMatch(new RegExp(`(?<!\\d)${code}(?!\\d)`));
}
