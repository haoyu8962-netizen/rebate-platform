// identity's reads for the console's list of a user's devices (B1-02zz; contract
// adminListUserDevices, D10-585). Always filtered by the admin actor's app_id and the user_id: a
// user of another app reads as absent.
//
// sessions decide whose device it is, through EXISTS, so a device with many sessions is one row and
// one count, and sessions of other accounts add nothing. devices.user_id is not read: devices are
// shared per install and nothing writes it. reverified_devices is keyed by (app_id, user_id,
// device_hash), which is unique, so the join adds no row either; the record is this user's only.
// device_hash stays in the join: it is never selected.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { AdminUserDeviceStore } from '../application/admin-user-devices.ts';

export function createKyselyAdminUserDeviceStore(db: Kysely<DB>): AdminUserDeviceStore {
  const app = db.withSchema('app');
  return {
    async userExists({ appId, userId }) {
      const row = await app
        .selectFrom('users')
        .select('id')
        .where('app_id', '=', appId)
        .where('id', '=', userId)
        .executeTakeFirst();
      return row !== undefined;
    },

    async page({ appId, userId, page, pageSize }) {
      const devices = app
        .selectFrom('devices')
        .where('devices.app_id', '=', appId)
        .where('devices.revoked_at', 'is', null)
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom('sessions')
              .select('sessions.id')
              .whereRef('sessions.app_id', '=', 'devices.app_id')
              .whereRef('sessions.device_id', '=', 'devices.id')
              .where('sessions.user_id', '=', userId),
          ),
        );
      const [items, count] = await Promise.all([
        devices
          .leftJoin('reverified_devices as record', (join) =>
            join
              .onRef('record.app_id', '=', 'devices.app_id')
              .onRef('record.device_hash', '=', 'devices.device_hash')
              .on('record.user_id', '=', userId),
          )
          .select([
            'devices.id as device_id',
            'devices.platform',
            'devices.app_version',
            'devices.created_at',
            'devices.last_seen_at',
            'record.source as reverified_source',
            'record.created_at as reverified_at',
          ])
          // devices.id settles equal times, so pages neither repeat nor skip a device.
          .orderBy('devices.last_seen_at', 'desc')
          .orderBy('devices.id', 'desc')
          .limit(pageSize)
          .offset((page - 1) * pageSize)
          .execute(),
        devices.select((eb) => eb.fn.countAll<bigint>().as('total')).executeTakeFirstOrThrow(),
      ]);
      return { items, total: Number(count.total) };
    },
  };
}
