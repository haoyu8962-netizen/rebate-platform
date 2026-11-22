import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { AdminAccountWrites } from '../infra/admin-account-writes.ts';
import type { AdminDirectoryRow } from '../infra/admin-directory.ts';
import {
  createAdminAccountsWriter,
  normalizeDisplayName,
  permissionsOk,
  reasonOk,
} from './admin-accounts-write.ts';
import { isOutcomeUnknown } from './step-up-outcome.ts';

const APP = 'couli';
const ACTOR = { appId: APP, adminId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b00', ip: '127.0.0.1' };
const TARGET = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01';

function row(patch: Partial<AdminDirectoryRow> = {}): AdminDirectoryRow {
  return {
    id: TARGET,
    appId: APP,
    loginName: 'cs',
    displayName: '客服',
    isSuper: false,
    status: 'active',
    totpBoundAt: null,
    verifyPhoneCipher: null,
    lockedUntil: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    rowVersion: 1,
    permissionKeys: [],
    ...patch,
  };
}

function setup(writes: Partial<AdminAccountWrites> = {}) {
  const all: AdminAccountWrites = {
    create: vi.fn(async () => ({ kind: 'written' as const, row: row({ rowVersion: 0 }) })),
    regenerate: vi.fn(async () => ({ kind: 'written' as const, row: row() })),
    disable: vi.fn(async () => ({ kind: 'written' as const, row: row({ status: 'disabled' }) })),
    enable: vi.fn(async () => ({ kind: 'written' as const, row: row() })),
    resetTotp: vi.fn(async () => ({ kind: 'written' as const, row: row() })),
    rename: vi.fn(async () => ({ kind: 'written' as const, row: row() })),
    savePermissions: vi.fn(async () => ({ kind: 'written' as const, row: row() })),
    ...writes,
  };
  const hashPassword = vi.fn(async (password: string) => `hash(${password.length})`);
  const writer = createAdminAccountsWriter({
    clock: new FixedClock('2026-10-09T02:00:00.000Z'),
    writes: all,
    crypto: { decrypt: () => '' },
    hashPassword,
    generatePassword: () => 'Generated2Password',
  });
  return { writer, writes: all, hashPassword };
}

it('[AC-B1-34h] display names are trimmed and 1–32 characters; whitespace-only reasons are refused', () => {
  expect(normalizeDisplayName('  客服小狸  ')).toBe('客服小狸');
  expect(normalizeDisplayName('   ')).toBeNull();
  expect(normalizeDisplayName('名'.repeat(32))).toBe('名'.repeat(32));
  expect(normalizeDisplayName('名'.repeat(33))).toBeNull();
  expect(reasonOk('已核对')).toBe(true);
  expect(reasonOk('  ')).toBe(false);
});

it('[AC-B1-34h] create hands only the hash to the writes and answers the clear password once', async () => {
  const { writer, writes, hashPassword } = setup();
  const answer = await writer.create(ACTOR, { username: 'cs', display_name: ' 客服 ' });
  expect(answer).toMatchObject({ kind: 'ok', initialPassword: 'Generated2Password' });
  expect(hashPassword).toHaveBeenCalledWith('Generated2Password');
  const call = vi.mocked(writes.create).mock.calls[0]![0];
  expect(call).toMatchObject({
    appId: APP,
    actor: ACTOR.adminId,
    loginName: 'cs',
    displayName: '客服',
    passwordHash: 'hash(18)',
  });
  expect(JSON.stringify(call)).not.toContain('Generated2Password');
});

it('[AC-B1-34h] refusals map to fields, forbidden and conflict without writing', async () => {
  const { writer, writes } = setup({
    create: vi.fn(async () => ({ kind: 'username_taken' as const })),
    disable: vi.fn(async () => ({ kind: 'refused' as const, reason: 'conflict' as const })),
    enable: vi.fn(async () => ({ kind: 'refused' as const, reason: 'forbidden' as const })),
    rename: vi.fn(async () => ({ kind: 'refused' as const, reason: 'unknown' as const })),
  });
  expect(await writer.create(ACTOR, { username: 'cs', display_name: '客服' })).toEqual({
    kind: 'fields',
    fields: ['username'],
  });
  expect(await writer.create(ACTOR, { username: 'cs', display_name: '  ' })).toEqual({
    kind: 'fields',
    fields: ['display_name'],
  });
  expect(await writer.disable(ACTOR, TARGET, '原因')).toEqual({ kind: 'conflict' });
  expect(await writer.disable(ACTOR, TARGET, ' ')).toEqual({ kind: 'fields', fields: ['reason'] });
  expect(await writer.enable(ACTOR, TARGET)).toEqual({ kind: 'forbidden' });
  expect(await writer.rename(ACTOR, TARGET, '新名')).toEqual({
    kind: 'fields',
    fields: ['admin_id'],
  });
  expect(await writer.resetTotp(ACTOR, 'not-a-uuid', '原因')).toEqual({
    kind: 'fields',
    fields: ['admin_id'],
  });
  expect(writes.resetTotp).not.toHaveBeenCalled();
  expect(vi.mocked(writes.disable).mock.calls).toHaveLength(1);
});

it('[AC-B1-34h] the answered account carries display name and row version', async () => {
  const { writer } = setup();
  const answer = await writer.regenerate(ACTOR, TARGET);
  expect(answer).toMatchObject({
    kind: 'ok',
    initialPassword: 'Generated2Password',
    account: { adminId: TARGET, displayName: '客服', rowVersion: 1, totpBound: false },
  });
});

it('[AC-B1-34k] permission keys must be catalog points, each once', () => {
  expect(permissionsOk([])).toBe(true);
  expect(permissionsOk(['user.lookup', 'fund.view'])).toBe(true);
  expect(permissionsOk(['user.lookup', 'fund.unknown_point'])).toBe(false);
  expect(permissionsOk(['user.lookup', 'fund.view', 'user.lookup'])).toBe(false);
});

it('[AC-B1-34k] savePermissions refuses bad keys before the admin id and writes nothing', async () => {
  const { writer, writes } = setup();
  expect(
    await writer.savePermissions(ACTOR, 'not-a-uuid', {
      permissions: ['retired.unknown'],
      expected_row_version: 0,
    }),
  ).toEqual({ kind: 'fields', fields: ['permissions'] });
  expect(
    await writer.savePermissions(ACTOR, 'not-a-uuid', {
      permissions: ['user.lookup'],
      expected_row_version: 0,
    }),
  ).toEqual({ kind: 'fields', fields: ['admin_id'] });
  expect(writes.savePermissions).not.toHaveBeenCalled();
});

it('[AC-B1-34k] savePermissions hands the set and the CAS value to the write and maps refusals', async () => {
  const { writer, writes } = setup({
    savePermissions: vi
      .fn<AdminAccountWrites['savePermissions']>()
      .mockResolvedValueOnce({ kind: 'written', row: row({ permissionKeys: ['fund.view'] }) })
      .mockResolvedValueOnce({ kind: 'refused', reason: 'conflict' })
      .mockResolvedValueOnce({ kind: 'refused', reason: 'forbidden' })
      .mockResolvedValueOnce({ kind: 'refused', reason: 'unknown' }),
  });
  const body = { permissions: ['fund.view'], expected_row_version: 3 };
  expect(await writer.savePermissions(ACTOR, TARGET, body)).toMatchObject({
    kind: 'ok',
    account: { permissions: ['fund.view'] },
  });
  expect(vi.mocked(writes.savePermissions).mock.calls[0]![0]).toEqual({
    appId: APP,
    actor: ACTOR.adminId,
    ip: ACTOR.ip,
    adminId: TARGET,
    permissions: ['fund.view'],
    expectedRowVersion: 3,
  });
  expect(await writer.savePermissions(ACTOR, TARGET, body)).toEqual({ kind: 'conflict' });
  expect(await writer.savePermissions(ACTOR, TARGET, body)).toEqual({ kind: 'forbidden' });
  expect(await writer.savePermissions(ACTOR, TARGET, body)).toEqual({
    kind: 'fields',
    fields: ['admin_id'],
  });
});

it('[AC-B2-02ze-R3#4] money r1 第 4 条：写入已提交后组装视图（解密验证手机）失败，抛约定的结果未知错误（守卫保留令牌），不当作已回滚', async () => {
  const cipherRow = row({ verifyPhoneCipher: Buffer.from('cipher', 'utf8') });
  const regenerate = vi.fn(async () => ({ kind: 'written' as const, row: cipherRow }));
  const writer = createAdminAccountsWriter({
    clock: new FixedClock('2026-10-09T02:00:00.000Z'),
    writes: { ...setup().writes, regenerate },
    crypto: {
      decrypt: () => {
        throw new Error('synthetic decrypt failure');
      },
    },
    hashPassword: async () => 'hash',
    generatePassword: () => 'Generated2Password',
  });
  const thrown = await writer.regenerate(ACTOR, TARGET).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(regenerate).toHaveBeenCalledTimes(1);
  expect(isOutcomeUnknown(thrown)).toBe(true);
  // 反例：视图组装成功时照常作答。
  const { writer: ok } = setup();
  expect(await ok.regenerate(ACTOR, TARGET)).toMatchObject({ kind: 'ok' });
});
