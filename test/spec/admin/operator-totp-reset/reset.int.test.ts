import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Insertable, Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import { runAdminTotpResetCommand } from '../../../../apps/api/scripts/admin-totp-reset.ts';
import {
  createOperatorTotpReset,
  type OperatorTotpResetDeps,
} from '../../../../apps/api/src/modules/admin/application/operator-totp-reset.ts';
import { systemActorName } from '../../../../apps/api/src/modules/admin/domain/audit-log-view.ts';
import { createSystemAuditWriter } from '../../../../apps/api/src/modules/admin/infra/system-audit.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { audit_system_actor } from '../../../../packages/contracts-ts/src/index.ts';
import { useDatabase } from '../system-audit/kit.ts';

const database = useDatabase(createTestDatabase);
const CLOCK_AT = '2026-11-25T02:00:00.250Z';
const BOUND_AT = '2026-11-20T02:00:00.000Z';
const REASON = '本人换手机，已当面核对身份';
const OLD_CIPHER = 'synthetic-totp-cipher-marker';
const SYSTEM_ACTOR = 'system:ops_command';

const appIdOf = () => `ops_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

async function seed(
  db: Kysely<DB>,
  appId: string,
  fields: Partial<Insertable<DB['admin_users']>> = {},
) {
  const id = randomUUID();
  return db
    .insertInto('admin_users')
    .values({
      id,
      app_id: appId,
      login_name: `account-${id}`,
      is_super: true,
      status: 'active',
      password_hash: 'synthetic-password-hash',
      totp_secret_cipher: Buffer.from(OLD_CIPHER),
      totp_bound_at: BOUND_AT,
      totp_last_step: 1n,
      ...fields,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function fixture() {
  const db = database.db();
  const appId = appIdOf();
  const clock = new FixedClock(CLOCK_AT);
  const target = await seed(db, appId, {
    verify_phone_cipher: Buffer.from('synthetic-phone-cipher'),
    verify_phone_hmac: 'synthetic-phone-hmac',
    verify_phone_set_at: BOUND_AT,
  });
  const request = { appId, loginName: target.login_name, reason: REASON };
  const audit = createSystemAuditWriter({ clock });
  const voidBefore = vi
    .fn<OperatorTotpResetDeps['revocations']['voidBefore']>()
    .mockResolvedValue(undefined);
  const deps: OperatorTotpResetDeps = { db, clock, audit, revocations: { voidBefore } };
  const read = (id = target.id) =>
    db.selectFrom('admin_users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const audits = () =>
    db.selectFrom('audit_logs').selectAll().where('app_id', '=', appId).orderBy('id').execute();
  const command = (
    useCase: ReturnType<typeof createOperatorTotpReset>,
    terminal: {
      readConfirmation: (prompt: string) => Promise<string | null>;
      write: (message: string) => void;
    },
  ) =>
    runAdminTotpResetCommand(['--app', appId, '--login', target.login_name], {
      useCase,
      terminal: { isTTY: true, readReason: async () => REASON, ...terminal },
    });
  return { appId, db, clock, deps, target, request, audit, voidBefore, read, audits, command };
}

it('[AC-B1-34t#5] 命令确认后清除验证器三列，保留短信和账号状态，写系统审计并作废目标凭证', async () => {
  const f = await fixture();
  const useCase = createOperatorTotpReset(f.deps);
  const messages: string[] = [];
  const code = await f.command(useCase, {
    write: (message) => messages.push(message),
    readConfirmation: async (prompt) => {
      messages.push(prompt);
      expect(await f.read()).toEqual(f.target);
      expect(await f.audits()).toEqual([]);
      expect(f.voidBefore).not.toHaveBeenCalled();
      return 'yes';
    },
  });

  expect(code).toBe(0);
  expect(await f.read()).toMatchObject({
    totp_secret_cipher: null,
    totp_bound_at: null,
    totp_last_step: null,
    status: f.target.status,
    is_super: f.target.is_super,
    password_hash: f.target.password_hash,
    password_must_change: f.target.password_must_change,
    verify_phone_cipher: f.target.verify_phone_cipher,
    verify_phone_hmac: f.target.verify_phone_hmac,
    verify_phone_set_at: f.target.verify_phone_set_at,
  });
  expect(f.voidBefore).toHaveBeenCalledExactlyOnceWith(
    { appId: f.appId, adminId: f.target.id },
    f.clock.now().getTime(),
  );
  const audits = await f.audits();
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    admin_id: null,
    system_actor: SYSTEM_ACTOR,
    action: 'admin_totp_reset',
    target: `admins:${f.target.id}`,
    after: { admin_id: f.target.id, totp_bound: false, reason: REASON },
  });
  expect(audit_system_actor).toContain(SYSTEM_ACTOR);
  expect(systemActorName(SYSTEM_ACTOR)).toBe('运维命令');
  const output = [...messages, JSON.stringify([audits[0]?.before, audits[0]?.after])].join('\n');
  expect(output).not.toContain(OLD_CIPHER);
  expect(output).not.toContain(f.target.totp_secret_cipher!.toString('hex'));
  expect(output).not.toContain('otpauth://');
});

it('[AC-B1-34t#6] 有另一位同应用、启用且已绑定的超管时，拒绝且双方数据、审计和令牌不变', async () => {
  const f = await fixture();
  const other = await seed(f.db, f.appId);
  const useCase = createOperatorTotpReset(f.deps);
  expect(await useCase.reset(f.request)).toEqual({
    kind: 'refused',
    reason: 'another_usable_super',
  });
  expect(await f.read()).toEqual(f.target);
  expect(await f.read(other.id)).toEqual(other);
  expect(await f.audits()).toEqual([]);
  expect(f.voidBefore).not.toHaveBeenCalled();
});

it('[AC-B1-34t#7] 普通账号、停用超管、未绑定超管及其他应用的超管均不阻止重置', async () => {
  const f = await fixture();
  const others = await Promise.all([
    seed(f.db, f.appId, { is_super: false }),
    seed(f.db, f.appId, { status: 'disabled' }),
    seed(f.db, f.appId, { totp_bound_at: null }),
    seed(f.db, appIdOf()),
  ]);
  const useCase = createOperatorTotpReset(f.deps);
  expect(await useCase.reset(f.request)).toEqual({ kind: 'reset' });
  expect(await f.read()).toMatchObject({ totp_bound_at: null });
  for (const other of others) {
    expect(await f.read(other.id)).toEqual(other);
  }
  expect(f.voidBefore).toHaveBeenCalledExactlyOnceWith(
    { appId: f.appId, adminId: f.target.id },
    f.clock.now().getTime(),
  );
});

it('[AC-B1-34t#8] 预览时未发现可用超管、确认前出现可用超管，仍拒绝重置', async () => {
  const f = await fixture();
  const useCase = createOperatorTotpReset(f.deps);
  const readConfirmation = vi.fn(async () => {
    await seed(f.db, f.appId);
    return 'yes';
  });
  expect(await f.command(useCase, { write: () => undefined, readConfirmation })).toBeGreaterThan(0);
  expect(readConfirmation).toHaveBeenCalledOnce();
  expect(await f.read()).toEqual(f.target);
  expect(await f.audits()).toEqual([]);
  expect(f.voidBefore).not.toHaveBeenCalled();
});

it.each(['登录名不存在', '应用不匹配', '普通账号', '非法原因'] as const)(
  '[AC-B1-34t#9] admin 用例拒绝%s且无副作用',
  async (scenario) => {
    const f = await fixture();
    const ordinary = await seed(f.db, f.appId, { is_super: false });
    const cases = {
      登录名不存在: { ...f.request, loginName: 'missing' },
      应用不匹配: { ...f.request, appId: appIdOf() },
      普通账号: { ...f.request, loginName: ordinary.login_name },
      非法原因: { ...f.request, reason: '' },
    };
    const useCase = createOperatorTotpReset(f.deps);
    expect(await useCase.reset(cases[scenario])).toMatchObject({ kind: 'refused' });
    expect(await f.read()).toEqual(f.target);
    expect(await f.read(ordinary.id)).toEqual(ordinary);
    expect(await f.audits()).toEqual([]);
    expect(f.voidBefore).not.toHaveBeenCalled();
  },
);

it('[AC-B1-34t#10] Redis 作废失败时，账号改动与系统审计一起回滚', async () => {
  const f = await fixture();
  const error = new Error('synthetic revocation write failure');
  f.voidBefore.mockRejectedValueOnce(error);
  const useCase = createOperatorTotpReset(f.deps);
  await expect(useCase.reset(f.request)).rejects.toThrow(error.message);
  expect(f.voidBefore).toHaveBeenCalledOnce();
  expect(await f.read()).toEqual(f.target);
  expect(await f.audits()).toEqual([]);
});

it('[AC-B1-34t#11] 审计写入后报错时，账号改动与审计一起回滚且未作废凭证', async () => {
  const f = await fixture();
  const error = new Error('synthetic audit write failure');
  const appendAction = vi.fn<OperatorTotpResetDeps['audit']['appendAction']>(async (trx, input) => {
    await f.audit.appendAction(trx, input);
    throw error;
  });
  const useCase = createOperatorTotpReset({ ...f.deps, audit: { appendAction } });
  await expect(useCase.reset(f.request)).rejects.toThrow(error.message);
  expect(appendAction).toHaveBeenCalledOnce();
  expect(await f.read()).toEqual(f.target);
  expect(await f.audits()).toEqual([]);
  expect(f.voidBefore).not.toHaveBeenCalled();
});
