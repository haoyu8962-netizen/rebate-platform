// B1-02zq §9 #7: POST /admin/v1/users/{user_id}/realname-correction on the real admin entry (the
// fixtures of ../admin-realname/kit.ts): a flagged account → 30419 reverify_pending, no vendor call,
// nothing changed, one audit record (08 BR-ID-25 细则「实名更正」; contract adminCorrectUserRealname).
// The flag is the account's: a re-verified device does not lift it, nothing here has a device.
//
// reverify_pending answers before identity_blacklisted, as the rule and the contract list them
// ("first hit wins"; D10-580; #46), although the TODO the task points at stands after the blacklist
// check.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  NEW,
  OLD,
  OTHER,
  REASON,
  added,
  audits,
  blacklisted,
  body,
  correct,
  deletion,
  ok,
  plaintexts,
  priorWritten,
  rejected,
  rowText,
  setup,
  snapshot,
  user,
  verified,
  withdrawal,
  wrongCheckDigit,
  type Setup,
  type User,
} from '../admin-realname/kit.ts';

const h = useHarness();

const PENDING = { reason: 'reverify_pending' };

const flag = (s: Setup, target: User) =>
  sql`UPDATE app.users SET reverify_flagged_at = ${s.clock.now()},
      reverify_trusted = ${JSON.stringify({ realname: true, providers: [] })}::jsonb
    WHERE app_id = ${target.appId} AND id = ${target.id}`.execute(h.db);

/** A verified, flagged user under another identity: the gate is judged at all. */
async function flaggedControl(s: Setup) {
  const target = await user(h, s.appId);
  await verified(h, target, OTHER);
  await flag(s, target);
  return target;
}

it('[AC-B1-02zq#34] 带标记 → 30419 reverify_pending，不调供应商、什么都不改，记一条审计', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  await flag(s, target);
  const before = { data: await snapshot(h, s.appId), audits: await audits(h, s.appId) };
  await rejected(await correct(s, target.id, body()), 30419, PENDING);
  expect(s.vendor).not.toHaveBeenCalled();
  expect(await snapshot(h, s.appId)).toEqual(before.data);
  expect(priorWritten(s)).toEqual([]);
  const rows = added(before.audits, await audits(h, s.appId));
  expect(rows).toHaveLength(1);
  const text = rowText(rows[0]!);
  expect(rows[0]).toMatchObject({ app_id: s.appId, admin_id: s.actor.id });
  expect(text).toContain(REASON);
  expect(text).toContain('30419');
  for (const secret of plaintexts(OLD, NEW)) expect(text).not.toContain(secret);
});

it.each([
  {
    case: '未实名',
    data: { reason: 'realname_not_verified' },
    arrange: async (s: Setup) => user(h, s.appId),
  },
  {
    case: '注销冷静期',
    data: { reason: 'account_deleting', stage: 'cooling' },
    arrange: async (s: Setup) => {
      const target = await user(h, s.appId);
      await verified(h, target);
      await deletion(h, target, 'cooling');
      return target;
    },
  },
  {
    case: '已注销',
    data: { reason: 'account_deleted' },
    arrange: async (s: Setup) => {
      const target = await user(h, s.appId, 'deleted');
      await verified(h, target);
      await deletion(h, target, 'done');
      return target;
    },
  },
  {
    case: '在途提现',
    data: { reason: 'withdrawal_in_progress' },
    arrange: async (s: Setup) => {
      const target = await user(h, s.appId);
      await verified(h, target);
      await withdrawal(h.db, s.clock, target, 'PENDING_REVIEW');
      return target;
    },
  },
])('[AC-B1-02zq#35] 既带标记又$case → 前面的不受理情形在先', async ({ arrange, data }) => {
  const s = await setup(h);
  await rejected(await correct(s, (await flaggedControl(s)).id, body()), 30419, PENDING);
  const target = await arrange(s);
  await flag(s, target);
  await rejected(await correct(s, target.id, body()), 30419, data);
  expect(s.vendor).not.toHaveBeenCalled();
});

it.each([
  { case: '新号校验位错', payload: body(NEW, { id_no: wrongCheckDigit(NEW.idNo) }), block: false },
  { case: '新号在黑名单', payload: body(NEW), block: true },
])('[AC-B1-02zq#36] 不受理在格式校验与 44001 之前：带标记 + $case → 30419', async (input) => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  await flag(s, target);
  if (input.block) await blacklisted(h, s.appId, NEW.idNo);
  await rejected(await correct(s, target.id, input.payload), 30419, PENDING);
  expect(s.vendor).not.toHaveBeenCalled();
});

it('[AC-B1-02zq#37] 看标记不看设备：账号有已加验设备也不受理，标记清除后才受理', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  await flag(s, target);
  await sql`INSERT INTO app.reverified_devices (id, app_id, user_id, device_hash, source)
    VALUES (${randomUUID()}, ${target.appId}, ${target.id}, ${'d'.repeat(64)}, 'self')`.execute(
    h.db,
  );
  await rejected(await correct(s, target.id, body()), 30419, PENDING);
  expect(s.vendor).not.toHaveBeenCalled();

  await sql`UPDATE app.users SET reverify_flagged_at = NULL, reverify_trusted = NULL
    WHERE app_id = ${target.appId} AND id = ${target.id}`.execute(h.db);
  const corrected = await ok(await correct(s, target.id, body()));
  expect(corrected).toMatchObject({ user_id: target.id, realname_status: 'verified' });
  expect(s.vendor).toHaveBeenCalledTimes(1);
});

it('[AC-B1-02zq#46] 带标记且原实名在黑名单 → reverify_pending 在先，标记清除后才是 identity_blacklisted', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  await flag(s, target);
  await blacklisted(h, s.appId, OLD.idNo);
  await rejected(await correct(s, target.id, body()), 30419, PENDING);

  await sql`UPDATE app.users SET reverify_flagged_at = NULL, reverify_trusted = NULL
    WHERE app_id = ${target.appId} AND id = ${target.id}`.execute(h.db);
  await rejected(await correct(s, target.id, body()), 30419, { reason: 'identity_blacklisted' });
  expect(s.vendor).not.toHaveBeenCalled();
});
