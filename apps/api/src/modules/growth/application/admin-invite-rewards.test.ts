import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  createAdminInviteRewardsReader,
  inviteRewardBudgetView,
  inviteRewardView,
  isInviteRewardUserId,
  qualifiedWindow,
  type InviteRewardRow,
} from './admin-invite-rewards.ts';

const INVITEE = '019c0000-0000-7000-8000-000000000002';
const INVITER = '019c0000-0000-7000-8000-000000000001';

const row: InviteRewardRow = {
  invitee_id: INVITEE,
  inviter_id: INVITER,
  amount_fen: 1000n,
  eligibility_days: 30,
  bind_source: 'landing',
  qualified_at: new Date('2026-10-20T02:00:00.000Z'),
  trigger_order_id: '019c0000-0000-7000-8000-0000000000a1',
  triggered_at: new Date('2026-11-25T01:00:00.000Z'),
  status: 'processed',
  inviter_result: 'skipped',
  invitee_result: 'granted',
  inviter_skip_reason: 'risk_restricted',
  invitee_skip_reason: null,
  void_reason: null,
  granted_at: new Date('2026-11-25T01:00:05.000Z'),
};

/** A database handle that must never be used. */
const noDb = new Proxy(
  {},
  {
    get() {
      throw new Error('database touched');
    },
  },
) as unknown as Kysely<DB>;

const phones = {
  async maskedPhones() {
    throw new Error('phones read');
  },
};

it('[AC-B2-16d#u1] 资格日窗口：+08:00 当日 00:00 起、次日 00:00 止；from > to 拒两字段，相等可以', () => {
  expect(qualifiedWindow('2026-10-20', '2026-10-20')).toEqual({
    start: '2026-10-20T00:00:00+08:00',
    end: '2026-10-21T00:00:00+08:00',
  });
  expect(qualifiedWindow(undefined, '2026-12-31')).toEqual({
    end: '2027-01-01T00:00:00+08:00',
  });
  expect(qualifiedWindow('2026-10-20', undefined)).toEqual({
    start: '2026-10-20T00:00:00+08:00',
  });
  expect(qualifiedWindow(undefined, undefined)).toEqual({});
  expect(qualifiedWindow('2026-10-21', '2026-10-20')).toEqual({
    kind: 'invalid',
    fields: ['qualified_from', 'qualified_to'],
  });
  expect(qualifiedWindow('2026-02-30', '2026-13-01')).toEqual({
    kind: 'invalid',
    fields: ['qualified_from', 'qualified_to'],
  });
  expect(qualifiedWindow('2026-02-30', undefined)).toEqual({
    kind: 'invalid',
    fields: ['qualified_from'],
  });
});

it('[AC-B2-16d#u2] 记录视图：字段齐、金额为数、时刻为 ISO、手机号取脱敏值（无则 null），不出 IP 摘要与凭证号', () => {
  const view = inviteRewardView(row, new Map([[INVITER, '138****5678']]));
  expect(view).toEqual({
    invitee_id: INVITEE,
    inviter_id: INVITER,
    invitee_phone_masked: null,
    inviter_phone_masked: '138****5678',
    amount_fen: 1000,
    eligibility_days: 30,
    bind_source: 'landing',
    qualified_at: '2026-10-20T02:00:00.000Z',
    trigger_order_id: '019c0000-0000-7000-8000-0000000000a1',
    triggered_at: '2026-11-25T01:00:00.000Z',
    status: 'processed',
    inviter_result: 'skipped',
    invitee_result: 'granted',
    inviter_skip_reason: 'risk_restricted',
    invitee_skip_reason: null,
    void_reason: null,
    granted_at: '2026-11-25T01:00:05.000Z',
  });
  const blank = inviteRewardView(
    { ...row, trigger_order_id: null, triggered_at: null, granted_at: null },
    new Map(),
  );
  expect(blank).toMatchObject({ trigger_order_id: null, triggered_at: null, granted_at: null });
});

it('[AC-B2-16d#u3] 预算视图：当日行与 total 行，缺行为 0；别的日子的行不算', () => {
  expect(inviteRewardBudgetView('2026-11-25', [])).toEqual({
    today: { date: '2026-11-25', granted_fen: 0 },
    total: { reserved_fen: 0, granted_fen: 0 },
  });
  expect(
    inviteRewardBudgetView('2026-11-25', [
      { period: '2026-11-24', reserved_fen: 0n, granted_fen: 7000n },
      { period: '2026-11-25', reserved_fen: 0n, granted_fen: 3000n },
      { period: 'total', reserved_fen: 6000n, granted_fen: 9_000_000_000n },
    ]),
  ).toEqual({
    today: { date: '2026-11-25', granted_fen: 3000 },
    total: { reserved_fen: 6000, granted_fen: 9_000_000_000 },
  });
});

it('[AC-B2-16d#u4] 不是 UUID 的受邀人不查库：详情为 null；资格日 from > to 也在查库前拒绝', async () => {
  expect(isInviteRewardUserId(INVITEE)).toBe(true);
  expect(isInviteRewardUserId(INVITEE.toUpperCase())).toBe(true);
  expect(isInviteRewardUserId('not-a-uuid')).toBe(false);
  expect(isInviteRewardUserId('a'.repeat(64))).toBe(false);
  const reader = createAdminInviteRewardsReader({
    db: noDb,
    clock: new FixedClock('2026-11-25T02:00:00.000Z'),
    phones,
  });
  expect(await reader.get('app', 'not-a-uuid')).toBeNull();
  expect(
    await reader.list('app', {
      page: 1,
      page_size: 20,
      qualified_from: '2026-10-21',
      qualified_to: '2026-10-20',
    }),
  ).toEqual({ kind: 'invalid', fields: ['qualified_from', 'qualified_to'] });
});
