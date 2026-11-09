// B1-20c (B1-02zp FU-MERGE-REVERIFY): the merge judges the phone account for re-verification before
// the third-party identity moves (规划/08 BR-WDR-01 细则「旧手机号被二次放号时的提现加验」并号一句:
// 「手机号账号被并入时，在迁移第三方身份之前对手机号账号做上一项判定；本次并号迁入的第三方身份不进入可信
// 身份」), and a flagged phone account takes no new third-party identity on a device that is not one of
// its re-verified devices (BR-ID-06 细则「待加验账号」: 未加验设备上新绑第三方身份返回待加验码).
// Orchestrator D10-1103 (replaces D10-1099 T-2): judge first, then stop — 10010 with data.method as
// BR-WDR-01 细则「位置与返回码」 gives it; nothing moves, the source is not tombstoned, its sessions are
// not revoked and the ticket is not consumed, so once this device is re-verified the same ticket
// merges. Whether a flag set by the refused merge's own judgement is kept is not pinned here.
// The session the merge creates is a login of the phone account on this device: the activity values
// are overwritten as at a login (reverify-activity.ts recordLoginActivity).
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeKit, openKit, type Kit } from '../bind-phone/http-kit.ts';
import type { Response } from '../sms-codes/http-kit.ts';
import {
  answer,
  apartFromActivity,
  merged,
  scene,
  usable,
  type Scene,
  type Snapshot,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

const DAY_MS = 86_400_000;
/** BR-WDR-01 细则「加验依据」: five consecutive failures (data.fail_limit). */
const FAIL_LIMIT = 5;
/** 10010's data (contracts/error-codes.yaml), exactly these keys per method. */
const MANUAL = { method: 'manual' };
const byOauth = (providers: string[]) => ({ method: 'oauth', providers, fail_limit: FAIL_LIMIT });

/** The target last active `days` ago on another device. */
async function lastSeen(s: Scene, days: number) {
  const at = new Date(kit.clock.now().getTime() - days * DAY_MS);
  const elsewhere = randomBytes(32).toString('hex');
  await sql`UPDATE app.users SET last_active_at = ${at}, last_login_device_hash = ${elsewhere}
    WHERE app_id = ${s.appId} AND id = ${s.target}`.execute(s.db);
}

/** 10010 with exactly `data`. */
function pending(response: Response, data: object): void {
  expect(answer(kit, response, 10010).data).toEqual(data);
}

/**
 * Nothing of the merge happened: identities, sessions, bindings, registrations, login records,
 * push tokens, consents and the source's users row as before (the target's activity columns and
 * flag aside); the source's session still works and the ticket is not consumed.
 */
async function nothingMerged(s: Scene, ticket: string, before: Snapshot): Promise<void> {
  expect(apartFromActivity(await s.snapshot(), s.target)).toEqual(
    apartFromActivity(before, s.target),
  );
  expect(await s.user(s.source)).toMatchObject({ status: 'normal', deleted_reason: null });
  expect(await s.rows.oauth(s.source)).toHaveLength(1);
  await usable(s, s.session.access_token);
  await s.ticketKept(ticket);
}

it('[AC-B1-20c#32] D10-1103 目标满足待加验（开关 90 天，100 天未活跃、换设备）→ 先判定后拦：10010 oauth，providers 只有 apple（迁入的微信不算）；不迁移、ticket 不核销；本设备加验后同一张票并号成功，可信身份仍不含微信', async () => {
  const s = await scene(kit, { provider: 'wechat' });
  await s.oauth(s.target, 'apple');
  await s.dormantDays(90);
  await lastSeen(s, 100);
  const ticket = await s.offer();
  const before = await s.snapshot();

  pending(await s.merge(ticket), byOauth(['apple']));

  await nothingMerged(s, ticket, before);
  expect((await s.rows.oauth(s.target)).map((row) => row.provider)).toEqual(['apple']);

  await s.reverified(s.target);
  merged(kit, await s.merge(ticket), s.target);

  const target = await s.user(s.target);
  expect(target.reverify_flagged_at).toEqual(kit.clock.now());
  expect(target.reverify_trusted).toEqual({ realname: false, providers: ['apple'] });
  // The wechat identity did move; it is only not trusted for the re-verification.
  expect((await s.rows.oauth(s.target)).map((row) => row.provider).sort()).toEqual([
    'apple',
    'wechat',
  ]);
});

it('[AC-B1-20c#33] D10-1103 目标只有手机号、满足待加验 → 10010 manual（迁入的 Apple 不算可信身份）；本设备加验后同一张票并号成功，可信身份为空', async () => {
  const s = await scene(kit, { provider: 'apple' });
  await s.dormantDays(90);
  await lastSeen(s, 100);
  const ticket = await s.offer();
  const before = await s.snapshot();

  pending(await s.merge(ticket), MANUAL);

  await nothingMerged(s, ticket, before);
  await s.reverified(s.target);
  merged(kit, await s.merge(ticket), s.target);

  const target = await s.user(s.target);
  expect(target.reverify_flagged_at).toEqual(kit.clock.now());
  expect(target.reverify_trusted).toEqual({ realname: false, providers: [] });
  expect((await s.rows.oauth(s.target)).map((row) => row.id)).toEqual([s.sourceOauth]);
});

it('[AC-B1-20c#34] 目标不满足待加验（10 天前活跃）→ 不打标、照常并号；本设备记为目标最近一次登录', async () => {
  const s = await scene(kit);
  await s.dormantDays(90);
  await lastSeen(s, 10);
  const ticket = await s.offer();

  merged(kit, await s.merge(ticket), s.target);

  expect(await s.user(s.target)).toMatchObject({
    reverify_flagged_at: null,
    reverify_trusted: null,
    last_active_at: kit.clock.now(),
    last_login_device_hash: s.device.hash,
  });
});

it('[AC-B1-20c#35] D10-1103 目标早已待加验、本设备未加验 → 10010 manual，什么都不迁、源不置墓碑、会话不吊销、ticket 不核销，原标记不变；本设备加验后同一张票并号成功', async () => {
  const s = await scene(kit);
  const flaggedAt = new Date(kit.clock.now().getTime() - 3 * DAY_MS);
  const trusted = { realname: false, providers: [] };
  await s.flag(s.target, trusted, flaggedAt);
  const ticket = await s.offer();
  const before = await s.snapshot();

  pending(await s.merge(ticket), MANUAL);

  await nothingMerged(s, ticket, before);
  expect(await s.user(s.target)).toMatchObject({
    reverify_flagged_at: flaggedAt,
    reverify_trusted: trusted,
  });
  expect(await s.rows.oauth(s.target)).toEqual([]);

  await s.reverified(s.target);
  merged(kit, await s.merge(ticket), s.target);

  expect(await s.user(s.source)).toMatchObject({ status: 'deleted', deleted_reason: 'merged' });
  expect((await s.rows.oauth(s.target)).map((row) => row.id)).toEqual([s.sourceOauth]);
  // A flag already on the account is not judged again: instant and trusted identities stay.
  expect(await s.user(s.target)).toMatchObject({
    reverify_flagged_at: flaggedAt,
    reverify_trusted: trusted,
  });
});

it('[AC-B1-20c#52] D10-1103 只看目标在本设备是否已加验：目标只在别的设备加验过、或本设备只是源的已加验设备 → 仍 10010（oauth，可信身份里的 apple）；什么都不迁', async () => {
  const s = await scene(kit, { provider: 'wechat' });
  await s.oauth(s.target, 'apple');
  await s.flag(s.target, { realname: false, providers: ['apple'] });
  await s.reverified(s.target, await s.newDevice());
  await s.reverified(s.source);
  const ticket = await s.offer();
  const before = await s.snapshot();

  pending(await s.merge(ticket), byOauth(['apple']));

  await nothingMerged(s, ticket, before);
  expect((await s.rows.oauth(s.target)).map((row) => row.provider)).toEqual(['apple']);
});
