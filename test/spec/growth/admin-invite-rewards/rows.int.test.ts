// B2-16d §10 #3 · what a record shows (contract AdminInviteReward; 08 BR-INV-24 细则「资格记录与状态」,
// BR-ID-33): every field exactly as stored, the locked amount and eligibility days, both parties'
// results with their reason codes as they are, phone numbers masked 3 + 4 (null without a phone);
// never the client IP or its HMAC, the voucher ids, a full phone number or a row internal, and no
// full phone number in the logs either.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  normal,
  noSecrets,
  pageOf,
  list,
  listed,
  person,
  quietLogs,
  reward,
  setup,
  view,
  type Seeded,
  type SkipReason,
  type VoidReason,
} from './kit.ts';

const h = useHarness();

/** The record of `seeded` in `items`, with its times as instants. */
function found(items: Parameters<typeof normal>[0][], seeded: Seeded) {
  const item = items.find((entry) => entry.invitee_id === seeded.invitee.id);
  expect(item, seeded.invitee.id).toBeDefined();
  return normal(item!);
}

it('[AC-B2-16d#21] 每种状态的记录逐字段与存储一致：锁定金额与有效期天数、渠道、触发单、两方结果与原因码、发放时刻', async () => {
  const s = await setup(h);
  const inviter = await person(s, { phone: '13800005678' });
  const seeded = [
    await reward(s, {
      inviter,
      status: 'qualified',
      bindSource: 'register',
      amountFen: 1000n,
      eligibilityDays: 30,
      qualifiedAt: '2026-10-19T12:30:00.000Z',
    }),
    await reward(s, {
      inviter,
      status: 'deferred',
      bindSource: 'landing',
      amountFen: 1500n,
      eligibilityDays: 45,
      qualifiedAt: '2026-10-20T02:00:00.000Z',
    }),
    await reward(s, {
      inviter,
      status: 'processed',
      bindSource: 'backfill',
      amountFen: 800n,
      eligibilityDays: 7,
      inviterSkip: 'risk_restricted',
      qualifiedAt: '2026-10-21T00:15:00.000Z',
    }),
    await reward(s, {
      status: 'processed',
      inviteeSkip: 'minor',
      qualifiedAt: '2026-10-21T01:00:00.000Z',
    }),
    await reward(s, {
      status: 'processed',
      qualifiedAt: '2026-10-21T02:00:00.000Z',
    }),
    await reward(s, {
      status: 'processed',
      inviterSkip: 'same_device',
      inviteeSkip: 'same_device',
      qualifiedAt: '2026-10-21T03:00:00.000Z',
    }),
    await reward(s, {
      status: 'voided',
      voidReason: 'relation_changed',
      qualifiedAt: '2026-10-22T03:00:00.000Z',
    }),
    await reward(s, {
      status: 'expired',
      eligibilityDays: 1,
      qualifiedAt: '2026-10-23T03:00:00.000Z',
    }),
  ];
  const response = await list(s);
  const page = await listed(response);
  expect(page.total).toBe(seeded.length);
  for (const entry of seeded) expect(found(page.items, entry)).toEqual(view(entry));
  // A record paid to nobody has no grant time; one paid to either party has it.
  const nobody = found(page.items, seeded[5]!);
  expect(nobody).toMatchObject({ inviter_result: 'skipped', invitee_result: 'skipped' });
  expect(nobody.granted_at).toBeNull();
  expect(found(page.items, seeded[2]!).granted_at).not.toBeNull();
  noSecrets(response, seeded);
  quietLogs(s, seeded);
});

it('[AC-B2-16d#22] 手机号 3+4 脱敏（138****5678 形状），没有手机号的一方为 null；明文不出现在答复与日志里', async () => {
  const s = await setup(h);
  const inviter = await person(s, { phone: '13800005678' });
  const invitee = await person(s, { phone: '13900000000' });
  const phoneless = await person(s, { phone: null });
  const both = await reward(s, { inviter, invitee, qualifiedAt: '2026-10-21T02:00:00.000Z' });
  const noInvitee = await reward(s, {
    inviter,
    invitee: phoneless,
    qualifiedAt: '2026-10-20T02:00:00.000Z',
  });
  const response = await list(s);
  const page = await listed(response);
  expect(found(page.items, both)).toMatchObject({
    inviter_phone_masked: '138****5678',
    invitee_phone_masked: '139****0000',
  });
  expect(found(page.items, noInvitee)).toMatchObject({
    inviter_phone_masked: '138****5678',
    invitee_phone_masked: null,
  });
  for (const item of page.items) {
    for (const value of [item.inviter_phone_masked, item.invitee_phone_masked]) {
      if (value !== null) expect(value).toMatch(/^1[0-9]{2}\*{4}[0-9]{4}$/);
    }
  }
  noSecrets(response, [both, noInvitee]);
  quietLogs(s, [both, noInvitee]);
});

it.each<{ inviterSkip?: SkipReason; inviteeSkip?: SkipReason }>([
  { inviterSkip: 'same_ip', inviteeSkip: 'same_ip' },
  { inviterSkip: 'deleted_phone_retained', inviteeSkip: 'deleted_phone_retained' },
  { inviterSkip: 'multi_account' },
  { inviteeSkip: 'deleting' },
  { inviterSkip: 'risk_restricted', inviteeSkip: 'minor' },
])(
  '[AC-B2-16d#23] 不发原因码原样给出（$inviterSkip / $inviteeSkip），照发的一方结果 granted、原因 null',
  async (skips) => {
    const s = await setup(h);
    const seeded = await reward(s, { status: 'processed', ...skips });
    const [item] = (await pageOf(s)).items;
    expect(normal(item!)).toEqual(view(seeded));
    expect(item!.inviter_result).toBe(skips.inviterSkip === undefined ? 'granted' : 'skipped');
    expect(item!.invitee_result).toBe(skips.inviteeSkip === undefined ? 'granted' : 'skipped');
    expect(item!.inviter_skip_reason).toBe(skips.inviterSkip ?? null);
    expect(item!.invitee_skip_reason).toBe(skips.inviteeSkip ?? null);
  },
);

it.each<{ reason: VoidReason }>([
  { reason: 'relation_changed' },
  { reason: 'order_clawed_back' },
  { reason: 'order_rights' },
])('[AC-B2-16d#24] 作废原因码原样给出（$reason），两方结果为 null', async ({ reason }) => {
  const s = await setup(h);
  const seeded = await reward(s, { status: 'voided', voidReason: reason });
  const [item] = (await pageOf(s)).items;
  expect(normal(item!)).toEqual(view(seeded));
  expect(item).toMatchObject({
    status: 'voided',
    void_reason: reason,
    inviter_result: null,
    invitee_result: null,
    granted_at: null,
  });
});

it('[AC-B2-16d#25] 金额按 int64 分原样给出（超过 int32 也不截断、不换算成元）', async () => {
  const s = await setup(h);
  const seeded = await reward(s, { amountFen: 3_000_000_000n, status: 'processed' });
  const [item] = (await pageOf(s)).items;
  expect(item!.amount_fen).toBe(3_000_000_000);
  expect(normal(item!)).toEqual(view(seeded));
});
