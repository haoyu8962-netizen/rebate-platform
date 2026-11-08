// B1-02zzk (BR-ID-26 细则「配置」, D10-1034 ①): helpers of the rule tests of the age line of the
// admin real-name correction, read from minor.min_realname_age the same way as the App-side
// submission (B1-02zzg): no row, a failing read, or anything but an integer 14..18 → 14, never
// lower. Built on the frozen B1-27a kit (../admin-realname/kit.ts), only imported here: real admin
// entry, PG and Redis, only the two-element vendor is replaced.
//
// Readings fixed by this kit:
// - the configuration is the app's app.config_items row of minor.min_realname_age, written as a raw
//   row (no registry check), so dirty values can be stored as they could be by hand or by an older
//   writer; it is written before the app's first correction and never changed within a test
//   (content caches configuration per (app, key));
// - "refused on age" is 30407 with no vendor call, every row of the app as it was (the user's
//   realname row included: the new identity is neither written over the old one nor kept) and no
//   insert into the prior identity store; "passes" is 200 with the realname row holding the new
//   number (vendor match);
// - correct() moves the admin Clock by 30 s for a fresh step-up (one TOTP step each). For an exact
//   instant, `ready` signs in again ahead of it and takes one step-up token per correction in
//   advance (each younger than the 5-minute token TTL at that instant); a refusal leaves its token
//   usable, a success consumes it, so every correction is given its own.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { expect } from 'vitest';
import { seed } from '../../admin/accounts/kit.ts';
import { NOW, signedIn, type Harness } from '../../admin/auth/kit.ts';
import {
  body,
  correct,
  decrypted,
  identity,
  ok,
  priorWritten,
  REALNAME,
  realnameOf,
  rejected,
  setup,
  snapshot,
  stepUp,
  user,
  verified,
  type CorrectOptions,
  type Identity,
  type Member,
  type Setup,
  type User,
} from '../admin-realname/kit.ts';

export const KEY = 'minor.min_realname_age';

/** No config row for the app (the key is unset). */
export const NO_ROW = Symbol('no minor.min_realname_age row');

/**
 * 2026-10-10 00:00 +08:00, the day after the birthday: born 2012-10-09 reaches 14 and born
 * 2010-10-09 reaches 16 at this instant. The admin kit's NOW is 2026-10-09 10:00 +08:00.
 */
export const MIDNIGHT = '2026-10-09T16:00:00.000Z';
/** One millisecond before MIDNIGHT. */
export const JUST_BEFORE = '2026-10-09T15:59:59.999Z';

/** Values the registry would refuse (B1-02zzf: integer, 14..18), written as raw rows. */
export const DIRTY: [string, unknown][] = [
  ['低于下限 10', 10],
  ['低于下限 13', 13],
  ['零', 0],
  ['负数 -16', -16],
  ['非整数 16.5', 16.5],
  ['非整数 13.5', 13.5],
  ['字符串 "16"', '16'],
  ['字符串 "10"', '10'],
  ['字符串 "abc"', 'abc'],
  ['高于上限 19', 19],
  ['高于上限 100', 100],
  ['JSON null', null],
  ['布尔 true', true],
  ['数组 [16]', [16]],
  ['对象 {"value":16}', { value: 16 }],
];

/** Writes the raw current-value row of the key for the app (any JSON value). */
export async function putAge(h: Harness, appId: string, value: unknown): Promise<void> {
  const at = new Date(NOW);
  await sql`INSERT INTO app.config_items (app_id, key, value, version, updated_by, created_at, updated_at)
    VALUES (${appId}, ${KEY}, ${JSON.stringify(value)}::jsonb, 1, 'b1-02zzk', ${at}, ${at})`.execute(
    h.db,
  );
}

/** One app on the admin entry: the user whose real name is corrected and who corrects it. */
export interface Line {
  readonly s: Setup;
  readonly appId: string;
  readonly target: User;
  /** The admin of this app when it is not the super admin of `s`. */
  readonly as?: Member;
}

/** A new admin entry and app whose age line is `age` (NO_ROW: no config row); a verified user. */
export async function corrector(h: Harness, age: unknown): Promise<Line> {
  const s = await setup(h);
  if (age !== NO_ROW) await putAge(h, s.appId, age);
  const target = await user(h, s.appId);
  await verified(h, target);
  return { s, appId: s.appId, target };
}

/** Another app on the same admin entry: its own super admin (signed in), verified user and line. */
export async function otherApp(s: Setup, age: unknown): Promise<Line> {
  const appId = `${s.appId}-${randomBytes(4).toString('hex')}`;
  if (age !== NO_ROW) await putAge(s.h, appId, age);
  const who = await seed(s.h, appId, { isSuper: true });
  const session = await signedIn(s, who);
  const target = await user(s.h, appId);
  await verified(s.h, target);
  return { s, appId, target, as: { who, token: session.admin_token } };
}

/** Someone born on `birth`; distinct serials give distinct ID numbers. */
export function born(birth: string, serial: string): Identity {
  return identity('林小禾', '440305', birth, serial);
}

function optionsOf(line: Line, token?: string): CorrectOptions {
  const options: CorrectOptions = {};
  if (line.as !== undefined) options.as = line.as;
  if (token !== undefined) options.stepUp = token;
  return options;
}

/** The correction of the user to `who`, whatever it answers. */
export function attempt(line: Line, who: Identity, token?: string) {
  return correct(line.s, line.target.id, body(who), optionsOf(line, token));
}

/** The correction to `who` is refused on age: 30407, nothing written, no vendor call. */
export async function refused(line: Line, who: Identity, token?: string) {
  const { s } = line;
  const before = await snapshot(s.h, line.appId);
  const calls = s.vendor.mock.calls.length;
  const kept = priorWritten(s).length;
  const response = await attempt(line, who, token);
  expect(response.json<{ code?: unknown }>().code, `born ${who.birth}: 30407`).toBe(30407);
  await rejected(response, 30407);
  expect(s.vendor.mock.calls.length, `born ${who.birth}: no vendor call`).toBe(calls);
  expect(await snapshot(s.h, line.appId), `born ${who.birth}: nothing written`).toEqual(before);
  expect(priorWritten(s).length, `born ${who.birth}: no prior identity kept`).toBe(kept);
  return response;
}

/** The correction to `who` passes the age line: 200, the realname row holds the new number. */
export async function passes(line: Line, who: Identity, token?: string) {
  const { s } = line;
  const response = await attempt(line, who, token);
  expect(response.json<{ code?: unknown }>().code, `born ${who.birth}: corrected`).toBe(0);
  const data = await ok(response);
  const row = await realnameOf(s.h, line.target);
  expect(row, `born ${who.birth}: realname row`).toBeDefined();
  expect(row!.status).toBe('verified');
  expect(decrypted(s.h, row!.id_no_cipher, REALNAME.idNo)).toBe(who.idNo);
  return data;
}

/**
 * Signs the admin of `line` in again shortly before `first` and takes `count` step-up tokens
 * (30 s apart: one TOTP step each), then sets the Clock to `first`. Correct with the returned
 * line and one token each; the Clock then moves only when the test sets it.
 */
export async function ready(line: Line, first: string, count: number) {
  expect(count, 'every token younger than 5 minutes at `first`').toBeLessThanOrEqual(8);
  const { s } = line;
  const who = line.as?.who ?? s.actor;
  s.clock.set(new Date(Date.parse(first) - 30_000 * (count + 2)));
  const session = await signedIn(s, who);
  const as: Member = { who, token: session.admin_token };
  const tokens: string[] = [];
  for (let i = 0; i < count; i += 1) tokens.push(await stepUp(s, who, as.token));
  s.clock.set(first);
  return { line: { ...line, as }, tokens };
}
