// POST /admin/v1/users/{user_id}/reverified-devices (adminAddUserReverifiedDevice, CT-26j, CT-26m;
// 规划/08 BR-WDR-01 细则「清除标记只走人工」; D10-513, D10-571 ⑨, D10-585; task B1-02zx §9–§11).
// identity is the only writer of app.reverified_devices.
//
// The operation guard (user.phone_change, totp step-up) and the contract's body schema have run
// before this. Here, first hit wins:
//   1. 20001 without an audit record, still the body's checks: device_id not a UUID, reason empty
//      after trimming (over-long reasons are the schema's, on the text as submitted, D10-585);
//      then a user_id that is not a UUID. No query could answer for these ids.
//   2. One transaction, on the user row lock (FOR NO KEY UPDATE, the lock of ../ports/lock-users.ts:
//      the expiry job and a re-verification pass both update this row, so neither can move the
//      account between the judgement and the write):
//        20001 [user_id]    no user of this app with that id;
//        20001 [device_id]  no such device in this app, the device revoked, or no session of this
//                           user, revoked sessions included, was ever bound to it. Devices are
//                           shared per install and nothing writes devices.user_id: sessions alone
//                           decide, and a device two accounts used is a device of both;
//        30419              account_deleted (stage done), then account_deleting with data.stage
//                           (stage processing, users.status deleting). The cooling period does not
//                           refuse: users.status is still normal then;
//        30419              reverify_not_pending: no flag on the account. A device already recorded
//                           does not pass this: a record from before a later flag would bypass it.
//      Then one reverified_devices row (source admin, the device's device_hash), or none when the
//      device is already recorded (created false, the first record's source and time).
//   3. One audit row user_reverified_device_add for everything that reached 2, refusals included,
//      in the same transaction: a record never commits without its audit row. It holds the reason
//      as trimmed; never the device_hash. The flag, its time, the trusted identities and the
//      failure count of 「加验依据」 are not touched.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no decorators.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { AuditPort, Clock, RootLogger } from '../../platform/index.ts';
import { addReverifiedDevice } from '../infra/reverify-store.ts';
import { createDeletionStageReader } from '../ports/deletion-stage.ts';

/** The audit action of every request that reaches the targets (contract). */
export const ADMIN_REVERIFIED_DEVICE_ACTION = 'user_reverified_device_add';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminReverifiedDeviceCommand {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
  readonly userId: string;
  readonly deviceId: string;
  /** As submitted; trimmed here. */
  readonly reason: string;
}

export interface AdminReverifiedDevice {
  readonly user_id: string;
  readonly device_id: string;
  readonly source: 'self' | 'admin';
  readonly created: boolean;
  readonly created_at: string;
}

export type AdminReverifiedDeviceRefusal =
  | { readonly reason: 'account_deleted' | 'reverify_not_pending' }
  | { readonly reason: 'account_deleting'; readonly stage: 'processing' };

export type AdminReverifiedDeviceResult =
  | { readonly code: 0; readonly data: AdminReverifiedDevice }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
  | { readonly code: 30419; readonly data: AdminReverifiedDeviceRefusal };

export interface AdminReverifiedDevicesOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info'>;
  /** Binds the audit port to a handle (app.module: admin's createAuditWriter). */
  readonly auditOn: (handle: Kysely<DB>) => AuditPort;
}

function refused(data: AdminReverifiedDeviceRefusal): AdminReverifiedDeviceResult {
  return { code: 30419, data };
}

const notFound = (field: 'user_id' | 'device_id'): AdminReverifiedDeviceResult => ({
  code: 20001,
  data: { fields: [field] },
});

export class AdminReverifiedDevices {
  readonly #options: AdminReverifiedDevicesOptions;
  readonly #stages: ReturnType<typeof createDeletionStageReader>;

  constructor(options: AdminReverifiedDevicesOptions) {
    this.#options = options;
    this.#stages = createDeletionStageReader({ db: options.db });
  }

  async record(command: AdminReverifiedDeviceCommand): Promise<AdminReverifiedDeviceResult> {
    const reason = command.reason.trim();
    const fields: string[] = [];
    if (!UUID.test(command.deviceId)) fields.push('device_id');
    if (reason.length === 0) fields.push('reason');
    if (fields.length > 0) return { code: 20001, data: { fields } };
    if (!UUID.test(command.userId)) return notFound('user_id');

    const result = await this.#options.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        const decided = await this.#decide(trx, command);
        await this.#audit(trx, command, reason, decided);
        return decided;
      });
    if (result.code === 0) {
      this.#options.logger.info(
        {
          app_id: command.appId,
          user_id: command.userId,
          admin_id: command.adminId,
          device_id: command.deviceId,
          created: result.data.created,
        },
        'identity_admin_device_reverified',
      );
    }
    return result;
  }

  async #decide(
    trx: Transaction<DB>,
    command: AdminReverifiedDeviceCommand,
  ): Promise<AdminReverifiedDeviceResult> {
    const { appId, userId, deviceId } = command;
    const app = trx.withSchema('app');
    // The first statement: everything below reads what committed before the lock was granted.
    const user = await app
      .selectFrom('users')
      .select('reverify_flagged_at')
      .where('app_id', '=', appId)
      .where('id', '=', userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (user === undefined) return notFound('user_id');

    const device = await app
      .selectFrom('devices')
      .select('device_hash')
      .where('app_id', '=', appId)
      .where('id', '=', deviceId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (device === undefined) return notFound('device_id');
    const session = await app
      .selectFrom('sessions')
      .select('id')
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .where('device_id', '=', deviceId)
      .limit(1)
      .executeTakeFirst();
    if (session === undefined) return notFound('device_id');

    const stages = await this.#stages.read(trx, { appId, userIds: [userId] });
    const stage = stages.get(userId) ?? 'none';
    if (stage === 'done') return refused({ reason: 'account_deleted' });
    if (stage === 'processing') return refused({ reason: 'account_deleting', stage });
    if (user.reverify_flagged_at === null) return refused({ reason: 'reverify_not_pending' });

    const row = await addReverifiedDevice(
      app,
      { app_id: appId, user_id: userId },
      { deviceHash: device.device_hash, now: this.#options.clock.now() },
    );
    return {
      code: 0,
      data: {
        user_id: userId,
        device_id: deviceId,
        source: row.source,
        created: row.created,
        created_at: row.created_at.toISOString(),
      },
    };
  }

  #audit(
    trx: Transaction<DB>,
    command: AdminReverifiedDeviceCommand,
    reason: string,
    result: AdminReverifiedDeviceResult,
  ): Promise<void> {
    const detail =
      result.code === 0
        ? { created: result.data.created }
        : result.code === 30419
          ? { refusal_reason: result.data.reason }
          : { fields: [...result.data.fields] };
    return this.#options.auditOn(trx).append({
      appId: command.appId,
      actor: command.adminId,
      action: ADMIN_REVERIFIED_DEVICE_ACTION,
      target: command.userId,
      before: null,
      after: {
        user_id: command.userId,
        device_id: command.deviceId,
        reason,
        result_code: result.code,
        ...detail,
      },
      ip: command.ip,
    });
  }
}
