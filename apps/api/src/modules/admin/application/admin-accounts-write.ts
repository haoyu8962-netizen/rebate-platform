// The super admin's admin account management (B1-34h; contract CT-24o adminCreateAdmin,
// adminRegenerateAdminInitialPassword, adminDisableAdmin, adminEnableAdmin, adminResetAdminTotp,
// adminUpdateAdminDisplayName; 08 BR-ID-43, BR-ID-42, BR-ID-34). The admin request check has
// already refused any account that is not a super admin (x-auth super, 10403) and the controller
// has checked the totp-tier step-up where the contract asks for one; the route schema has checked
// the body's shape. This use case trims and judges the values the schema cannot (a display name or
// a reason that is only whitespace), generates and hashes the one-time initial password and calls
// the writes (../infra/admin-account-writes.ts), each one transaction with its audit row.
//
// The initial password is returned to the caller once and never logged, audited or stored in
// clear (only its hash); the caller answers it with Cache-Control: no-store.
//
// B1-34k adds the permission point save (adminSaveAdminPermissions, totp-tier step-up in the
// controller): every key must be in the permission catalog (specs/permissions.yaml, the enum
// admin_permission) and appear once, else 20001 [permissions] before anything is read.
//
// Pure module (no decorators, erasable syntax).
import { randomUUID } from 'node:crypto';
import type { Clock, FieldCrypto } from '../../platform/index.ts';
import { isAdminId } from '../domain/admin-view.ts';
import { getAdminPermissionCatalog } from '../domain/permission-catalog.ts';
import { generateAdminInitialPassword } from '../domain/initial-password.ts';
import type { AccountRefusal, AdminAccountWrites } from '../infra/admin-account-writes.ts';
import type { AdminDirectoryRow } from '../infra/admin-directory.ts';
import { toAccountView, type AdminAccountView } from './admin-accounts-read.ts';
import { hashAdminPassword } from './bootstrap.ts';
import { AdminOutcomeUnknownError } from './step-up-outcome.ts';

/** admin_users.display_name: 1–32 characters after trimming (contract AdminDisplayName). */
export const ADMIN_DISPLAY_NAME_MAX = 32;

export interface AdminActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export type AdminAccountRefusal =
  /** 20001 with data.fields. */
  | { readonly kind: 'fields'; readonly fields: readonly string[] }
  /** 10403 admin_permission_denied. */
  | { readonly kind: 'forbidden' }
  /** 20902 resource=admin_account. */
  | { readonly kind: 'conflict' };

export type AccountAnswer =
  { readonly kind: 'ok'; readonly account: AdminAccountView } | AdminAccountRefusal;

export type CreatedAnswer =
  | { readonly kind: 'ok'; readonly account: AdminAccountView; readonly initialPassword: string }
  | AdminAccountRefusal;

export interface AdminAccountsWriter {
  create(
    actor: AdminActor,
    body: { readonly username: string; readonly display_name: string },
  ): Promise<CreatedAnswer>;
  regenerate(actor: AdminActor, adminId: string): Promise<CreatedAnswer>;
  disable(actor: AdminActor, adminId: string, reason: string): Promise<AccountAnswer>;
  enable(actor: AdminActor, adminId: string): Promise<AccountAnswer>;
  resetTotp(actor: AdminActor, adminId: string, reason: string): Promise<AccountAnswer>;
  rename(actor: AdminActor, adminId: string, displayName: string): Promise<AccountAnswer>;
  savePermissions(
    actor: AdminActor,
    adminId: string,
    body: { readonly permissions: readonly string[]; readonly expected_row_version: number },
  ): Promise<AccountAnswer>;
}

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(
  getAdminPermissionCatalog().map((entry) => entry.key),
);

/** Every key is a catalog point and none appears twice (contract: 20001 [permissions]). */
export function permissionsOk(keys: readonly string[]): boolean {
  return new Set(keys).size === keys.length && keys.every((key) => KNOWN_PERMISSIONS.has(key));
}

/** The display name as stored: trimmed, 1–32 characters (code points); null when invalid. */
export function normalizeDisplayName(value: string): string | null {
  const trimmed = value.trim();
  const length = [...trimmed].length;
  return length >= 1 && length <= ADMIN_DISPLAY_NAME_MAX ? trimmed : null;
}

/** A reason of whitespace only says nothing (BR-ID-43: the reason is required). */
export function reasonOk(value: string): boolean {
  return value.trim().length > 0;
}

const fields = (...names: string[]): AdminAccountRefusal => ({ kind: 'fields', fields: names });

const refusalOf = (reason: AccountRefusal): AdminAccountRefusal =>
  reason === 'unknown'
    ? fields('admin_id')
    : reason === 'forbidden'
      ? { kind: 'forbidden' }
      : { kind: 'conflict' };

export function createAdminAccountsWriter(deps: {
  readonly clock: Clock;
  readonly writes: AdminAccountWrites;
  readonly crypto: Pick<FieldCrypto, 'decrypt'>;
  /** Overridable in unit tests; production hashes with F1-06c's admin password hash. */
  readonly hashPassword?: (password: string) => Promise<string>;
  readonly generatePassword?: () => string;
}): AdminAccountsWriter {
  const { clock, writes, crypto } = deps;
  const hash = deps.hashPassword ?? hashAdminPassword;
  const generate = deps.generatePassword ?? generateAdminInitialPassword;

  /**
   * The written row as the answer shows it; runs after the write's COMMIT. Its only fallible step
   * (decrypting the verify phone for its mask) then must not pass for a roll-back: the step-up gate
   * would give the token back and a retry would repeat a committed write (a second initial
   * password, B2-02ze money r1 S1), so a failure here is the agreed outcome-unknown error.
   */
  const view = (row: AdminDirectoryRow): AdminAccountView => {
    try {
      return toAccountView(row, clock.now(), crypto);
    } catch (error) {
      throw new AdminOutcomeUnknownError('admin: account written, its view failed', {
        cause: error,
      });
    }
  };

  const answer = (result: Awaited<ReturnType<AdminAccountWrites['enable']>>): AccountAnswer =>
    result.kind === 'written'
      ? { kind: 'ok', account: view(result.row) }
      : refusalOf(result.reason);

  const target = (actor: AdminActor, adminId: string) => ({
    appId: actor.appId,
    actor: actor.adminId,
    ip: actor.ip,
    adminId,
  });

  return {
    async create(actor, body) {
      const displayName = normalizeDisplayName(body.display_name);
      if (displayName === null) return fields('display_name');
      const initialPassword = generate();
      const result = await writes.create({
        appId: actor.appId,
        actor: actor.adminId,
        ip: actor.ip,
        id: randomUUID(),
        loginName: body.username,
        displayName,
        passwordHash: await hash(initialPassword),
      });
      if (result.kind === 'username_taken') return fields('username');
      return { kind: 'ok', account: view(result.row), initialPassword };
    },

    async regenerate(actor, adminId) {
      if (!isAdminId(adminId)) return fields('admin_id');
      const initialPassword = generate();
      const result = await writes.regenerate({
        ...target(actor, adminId),
        passwordHash: await hash(initialPassword),
      });
      if (result.kind !== 'written') return refusalOf(result.reason);
      return { kind: 'ok', account: view(result.row), initialPassword };
    },

    async disable(actor, adminId, reason) {
      if (!reasonOk(reason)) return fields('reason');
      if (!isAdminId(adminId)) return fields('admin_id');
      return answer(await writes.disable({ ...target(actor, adminId), reason }));
    },

    async enable(actor, adminId) {
      if (!isAdminId(adminId)) return fields('admin_id');
      return answer(await writes.enable(target(actor, adminId)));
    },

    async resetTotp(actor, adminId, reason) {
      if (!reasonOk(reason)) return fields('reason');
      if (!isAdminId(adminId)) return fields('admin_id');
      return answer(await writes.resetTotp({ ...target(actor, adminId), reason }));
    },

    async rename(actor, adminId, displayName) {
      const normalized = normalizeDisplayName(displayName);
      if (normalized === null) return fields('display_name');
      if (!isAdminId(adminId)) return fields('admin_id');
      return answer(await writes.rename({ ...target(actor, adminId), displayName: normalized }));
    },

    async savePermissions(actor, adminId, body) {
      if (!permissionsOk(body.permissions)) return fields('permissions');
      if (!isAdminId(adminId)) return fields('admin_id');
      return answer(
        await writes.savePermissions({
          ...target(actor, adminId),
          permissions: body.permissions,
          expectedRowVersion: body.expected_row_version,
        }),
      );
    },
  };
}
