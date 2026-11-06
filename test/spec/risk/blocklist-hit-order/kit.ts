// B1-03zj rule-test kit (BR-WDR-29 ⑨, BR-WDR-03 ③a, BR-ID-36; ruling D10-731 ①). One dimension
// order for both blocklist checks: phone → id_no → device (any device of the member for ⑨, the
// request's device for ③a) → payee account. Members, devices, sessions, logins and withdrawals come
// from test/spec/risk/blocklist-device-scope/kit.ts (real registration and SMS login on the api
// entry, devices.user_id never written); ⑨ runs on the real worker entry of
// test/spec/payout/risk-rule-toggle/chain-kit.ts. What is read back is the risk_hits row each check
// leaves: ref_type withdrawal for ⑨ (manual_review), blocked_request for ③a (block). All values are
// synthetic.
import { sql } from 'kysely';
import { expect } from 'vitest';
import type { Kit } from '../../identity/payout-account/kit.ts';
import type { Worker } from '../../payout/risk-rule-toggle/chain-kit.ts';
import { RULE_OF } from '../../payout/risk-rule-toggle/kit.ts';
import {
  apply,
  blockDevice,
  blockMember,
  decide,
  deviceRow,
  expectHit,
  member,
  registerDevice,
  withdrawalRow,
  type Device,
  type Member,
} from '../blocklist-device-scope/kit.ts';

export type HitDimension = 'phone' | 'id_no' | 'device' | 'alipay';

export interface Target {
  readonly dimension: HitDimension;
  readonly value_hmac: string;
  readonly rule_id: string;
}

/** What a hit row must name: the dimension, its digest and the rule of that dimension. */
export function target(dimension: HitDimension, valueHmac: string): Target {
  return { dimension, value_hmac: valueHmac, rule_id: RULE_OF[dimension] };
}

/** The stored hash of the device, the digest a device hit names. */
export async function deviceDigest(kit: Kit, device: Device): Promise<string> {
  return (await deviceRow(kit, device)).device_hash;
}

/** The member's own digest of a non-device dimension, as the blocklist rows of blockMember hold it. */
export async function memberDigest(
  kit: Kit,
  m: Member,
  dimension: 'phone' | 'id_no' | 'alipay',
): Promise<string> {
  if (dimension === 'alipay') return m.payeeDigest;
  if (dimension === 'phone') {
    const { rows } = await sql<{ digest: string }>`SELECT phone_hmac AS digest FROM app.users
      WHERE app_id = ${m.appId} AND id = ${m.userId}`.execute(kit.db);
    expect(rows).toHaveLength(1);
    return rows[0]!.digest;
  }
  const { rows } = await sql<{ digest: string }>`SELECT id_no_hmac AS digest FROM app.realname
    WHERE app_id = ${m.appId} AND user_id = ${m.userId} AND status = 'verified'`.execute(kit.db);
  expect(rows).toHaveLength(1);
  return rows[0]!.digest;
}

/** The blocklist hit rows ⑨ left on the withdrawal. */
export async function reviewHits(kit: Kit, appId: string, withdrawalId: string) {
  const { rows } = await sql<{
    dimension: string;
    value_hmac: string;
    rule_id: string;
    risk_action: string;
    ref_type: string;
    ref_id: string;
  }>`SELECT dimension, value_hmac, rule_id, risk_action, ref_type, ref_id FROM app.risk_hits
    WHERE app_id = ${appId} AND ref_type = 'withdrawal' AND ref_id = ${withdrawalId}
      AND left(rule_id, 10) = 'BLACKLIST_'
    ORDER BY id`.execute(kit.db);
  return rows;
}

/** The blocklist hit rows ③a left on the app's refused withdrawal requests, oldest first. */
export async function blockedHits(kit: Kit, appId: string) {
  const { rows } = await sql<{
    dimension: string;
    value_hmac: string;
    rule_id: string;
    risk_action: string;
    request_type: string | null;
  }>`SELECT dimension, value_hmac, rule_id, risk_action, request_type FROM app.risk_hits
    WHERE app_id = ${appId} AND ref_type = 'blocked_request' AND left(rule_id, 10) = 'BLACKLIST_'
    ORDER BY id`.execute(kit.db);
  return rows;
}

/** ⑨ left exactly one hit on the withdrawal, and it names `expected`. */
export async function expectReviewHit(
  kit: Kit,
  appId: string,
  withdrawalId: string,
  expected: Target,
): Promise<void> {
  expect(await reviewHits(kit, appId, withdrawalId)).toEqual([
    { ...expected, risk_action: 'manual_review', ref_type: 'withdrawal', ref_id: withdrawalId },
  ]);
}

/** ③a left exactly one hit on the app so far, and it names `expected`. */
export async function expectBlockedHit(kit: Kit, appId: string, expected: Target): Promise<void> {
  expect(await blockedHits(kit, appId)).toEqual([
    { ...expected, risk_action: 'block', request_type: 'withdraw' },
  ]);
}

/** ⑨ sent the withdrawal to manual review (the conclusion this task keeps). */
export async function expectManual(
  kit: Kit,
  appId: string,
  withdrawalId: string,
  decision: unknown,
): Promise<void> {
  expectHit(decision);
  expect(await withdrawalRow(kit, appId, withdrawalId)).toMatchObject({
    status: 'PENDING_REVIEW',
    review_mode: 'manual',
  });
}

/**
 * The case D10-731 ① fixes, in `appId` (fresh, its rule states already set): the member signs in
 * on X, then on Y, applies from Y; X's device hash and the member's payee account are then both
 * listed. ⑨ goes to manual review and names the device X, not the payee account.
 */
export async function expectDeviceBeforePayee(
  kit: Kit,
  worker: Worker,
  appId: string,
): Promise<void> {
  const x = await registerDevice(kit, appId);
  const y = await registerDevice(kit, appId);
  const m = await member(kit, appId, x);
  const id = await apply(kit, await m.login(y));
  await blockDevice(kit, x, 'malicious_rights');
  await blockMember(kit, m, 'alipay', 'fraud_invite');
  await expectManual(kit, appId, id, await decide(kit, worker, m, id));
  await expectReviewHit(kit, appId, id, target('device', await deviceDigest(kit, x)));
}
