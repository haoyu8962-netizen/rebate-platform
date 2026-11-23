// B1-13n rule-test helpers (D10-2636 ②; precedent B1-02zza). Every user_id is a synthetic UUID
// drawn per run. Names start with 「测试」 and every ID number uses the non-existent region code
// 990101 with a valid birth date and check digit (D10-2637): no fixture can belong to a real person.
// No real node value appears here (the node gives the list).
import { randomBytes, randomInt } from 'node:crypto';
import { expect } from 'vitest';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import type {
  RealnameVerificationInput,
  RealnameVerificationResult,
  RealnameVerifierPort,
} from '../../../../apps/api/src/modules/identity/ports/realname-verifier.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const USER_IDS_ENV = 'STAGING_TEST_REALNAME_USER_IDS';
export const PROVIDER = 'staging-test-identity';
export const AUDIT_EVENT = 'staging_test_realname_verified';
/** Most user_ids the list may hold. */
export const MAX_IDS = 10;
/** Synthetic names of the tests (「测试」 first). */
export const NAME = '测试实名甲';
export const OTHER_NAME = '测试实名乙';
/** Environments that are not staging: prod and the fakes, plus look-alikes a factory may get. */
export const NOT_STAGING = [
  'prod',
  'local',
  'test',
  'production',
  'Staging',
  'STAGING',
  ' staging',
  'staging ',
  '',
] as const;
/**
 * Fields every pino line carries whatever was logged: pino's own (level, time, pid, hostname, msg,
 * v), the root logger's base (entry, env, deployVersion) and the `module` binding of a child logger.
 * The rest of a line are its business fields.
 */
const PINO_META = new Set([
  'level',
  'time',
  'pid',
  'hostname',
  'msg',
  'v',
  'entry',
  'env',
  'deployVersion',
  'module',
]);
/** A staging node that loadConfig accepts (B1-01zd: local field keyring by absolute paths). */
export const STAGING_NODE: Readonly<Record<string, string>> = {
  APP_ENV: 'staging',
  FIELD_KEY_PROVIDER: 'local',
  FIELD_KEYRING_FILE: '/srv/couli/keys/keyring.json',
  FIELD_MASTER_KEY_FILE: '/srv/couli/keys/master.hex',
  PRIOR_IDENTITY_KEY_PROVIDER: 'local',
  PRIOR_IDENTITY_KEYRING_FILE: '/srv/couli/keys/prior-identity-keyring.json',
  PRIOR_IDENTITY_MASTER_KEY_FILE: '/srv/couli/keys/prior-identity-master.hex',
};

/** The list an AppConfig keeps (null when absent). */
export function listOf(config: unknown): readonly string[] | null {
  const value = (config as Record<string, unknown> | undefined)?.['stagingTestRealnameUserIds'];
  return (value ?? null) as readonly string[] | null;
}

/** The staging node with `listed` as the api entry reads it (bootstrap.ts: loadConfig(env, 'api')). */
export function stagingApiConfig(listed: readonly string[]) {
  return loadConfig({ ...STAGING_NODE, [USER_IDS_ENV]: listed.join(',') }, 'api');
}

/** A synthetic lowercase UUID of version 7 (valid for any reading of «a user_id»). */
export function userId(): string {
  const hex = randomBytes(16).toString('hex').split('');
  hex[12] = '7';
  hex[16] = '89ab'.charAt(randomInt(4));
  return hex.join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

/** `count` different synthetic user_ids. */
export function userIds(count: number): string[] {
  const ids = new Set<string>();
  while (ids.size < count) ids.add(userId());
  return [...ids];
}

/** An 18-character resident ID number of region 990101 (does not exist) with a valid check digit. */
export function residentId(birth: string, serial = '011'): string {
  const prefix = `990101${birth.replaceAll('-', '')}${serial}`;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = [...prefix].reduce((n, char, i) => n + Number(char) * weights[i]!, 0);
  return prefix + '10X98765432'.charAt(sum % 11);
}

/** The same number with a check digit that is wrong. */
export function wrongCheckDigit(id: string): string {
  return id.slice(0, 17) + (id.endsWith('0') ? '1' : '0');
}

/** A trace-level root logger whose pino lines are kept in `lines`. */
export function memoryLogger() {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  return { logger, lines };
}

/** Every parsed pino line of `lines`. */
export function entries(lines: readonly string[]): Record<string, unknown>[] {
  return lines
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The audit lines of a staging test identity. */
export function auditLines(lines: readonly string[]): Record<string, unknown>[] {
  return entries(lines).filter((entry) => entry['event'] === AUDIT_EVENT);
}

/** The lines that are not audit lines (they may not name a listed user_id). */
export function otherLines(lines: readonly string[]): string {
  return JSON.stringify(entries(lines).filter((entry) => entry['event'] !== AUDIT_EVENT));
}

/** The business fields of a pino line (every field but PINO_META). */
export function businessFields(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !PINO_META.has(key)));
}

function holds(entry: Record<string, unknown>, count: number): boolean {
  return Object.values(businessFields(entry)).some((value) => value === count);
}

/** The warn lines whose business fields hold `count` (the number of listed user_ids). */
function countWarnings(lines: readonly string[], count: number): Record<string, unknown>[] {
  return entries(lines).filter((entry) => entry['level'] === 40 && holds(entry, count));
}

/**
 * Enabled: a warn whose business fields are exactly one, the number of listed user_ids (`count`);
 * no warn carrying the count has anything else.
 */
export function expectCountWarning(lines: readonly string[], count: number): void {
  const warnings = countWarnings(lines, count);
  expect(warnings.length, 'a warn with the number of listed user_ids').toBeGreaterThan(0);
  for (const warning of warnings) {
    const fields = businessFields(warning);
    expect(Object.values(fields), JSON.stringify(Object.keys(fields))).toEqual([count]);
  }
}

/** One audit line of a match: exactly event, app_id, user_id and provider as business fields. */
export function expectAudit(
  entry: Record<string, unknown> | undefined,
  appId: string,
  uid: string,
): void {
  expect(entry).toBeDefined();
  expect(businessFields(entry!)).toEqual({
    event: AUDIT_EVENT,
    app_id: appId,
    user_id: uid,
    provider: PROVIDER,
  });
}

/** None of `secrets` is in `text`. */
export function expectNoLeak(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    expect(text.includes(secret), 'leaked a submitted value').toBe(false);
  }
}

export function verification(appId: string, uid: string, idNo: string): RealnameVerificationInput {
  return { app_id: appId, user_id: uid, name: NAME, id_no: idNo };
}

/**
 * Hard off: building throws (without the user_id, the name or the ID number), gives null, or gives a
 * verifier that never answers the staging test identity — and, outside local / test, never a match.
 */
export async function expectHardOff(
  appEnv: string,
  build: () => RealnameVerifierPort | null | Promise<RealnameVerifierPort | null>,
  input: RealnameVerificationInput,
): Promise<void> {
  let verifier: RealnameVerifierPort | null;
  try {
    verifier = await build();
  } catch (error) {
    const text = `${String(error)} ${error instanceof Error ? error.message : ''}`;
    expectNoLeak(text, [input.user_id, input.name, input.id_no]);
    return;
  }
  if (verifier === null) return;
  let result: RealnameVerificationResult;
  try {
    result = await verifier.verify(input);
  } catch {
    result = { outcome: 'unavailable' };
  }
  expect(result, JSON.stringify(appEnv)).not.toMatchObject({ provider: PROVIDER });
  if (appEnv !== 'local' && appEnv !== 'test') {
    expect(result.outcome, JSON.stringify(appEnv)).not.toBe('match');
  }
}
