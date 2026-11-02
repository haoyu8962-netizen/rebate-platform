// GET /admin/v1/users/{user_id}/devices (adminListUserDevices, CT-26j, CT-26m; D10-571 ⑨, D10-585;
// task B1-02zz): the devices of one user with their re-verified record, the list the console picks
// the device_id from for POST .../reverified-devices.
//
// The operation guard (user.phone_change, read only: no step-up) and the route schema have run
// before this. A device of this user is one a session of this user was bound to, revoked sessions
// included, and the device itself not revoked: the same judgement as AdminReverifiedDevices, so
// whatever is listed can be recorded. devices.user_id is never read.
//
// Read only: no audit record and no write of any kind.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no decorators.
import type { Schema } from '@couli/contracts-ts';

/** The contract's own check is only a length; a value that is no UUID cannot be a user id. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminUserDevicesQuery {
  readonly page?: number;
  readonly page_size?: number;
}

export interface AdminUserDeviceRow {
  readonly device_id: string;
  readonly platform: string;
  readonly app_version: string;
  readonly created_at: Date;
  readonly last_seen_at: Date;
  /** Of this user's reverified_devices row for the device; both null without one. */
  readonly reverified_source: string | null;
  readonly reverified_at: Date | null;
}

export interface AdminUserDeviceStore {
  userExists(input: { readonly appId: string; readonly userId: string }): Promise<boolean>;
  page(input: {
    readonly appId: string;
    readonly userId: string;
    readonly page: number;
    readonly pageSize: number;
  }): Promise<{ readonly items: readonly AdminUserDeviceRow[]; readonly total: number }>;
}

export type AdminUserDevicesResult =
  | { readonly code: 0; readonly data: Schema<'AdminUserDevicePage'> }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } };

function reverified(row: AdminUserDeviceRow): Schema<'AdminUserDevice'>['reverified'] {
  if (row.reverified_source === null || row.reverified_at === null) return null;
  return {
    // reverified_devices_source_check allows nothing else.
    source: row.reverified_source as 'self' | 'admin',
    created_at: row.reverified_at.toISOString(),
  };
}

/** Field by field: the response never carries more than the contract's six names. */
function project(row: AdminUserDeviceRow): Schema<'AdminUserDevice'> {
  return {
    device_id: row.device_id,
    platform: row.platform as Schema<'ClientPlatformCode'>,
    app_version: row.app_version,
    created_at: row.created_at.toISOString(),
    last_seen_at: row.last_seen_at.toISOString(),
    reverified: reverified(row),
  };
}

export class AdminUserDevices {
  readonly #store: AdminUserDeviceStore;

  constructor(store: AdminUserDeviceStore) {
    this.#store = store;
  }

  async list(
    appId: string,
    userId: string,
    query: AdminUserDevicesQuery,
  ): Promise<AdminUserDevicesResult> {
    const unknown: AdminUserDevicesResult = { code: 20001, data: { fields: ['user_id'] } };
    if (!UUID.test(userId)) return unknown;
    if (!(await this.#store.userExists({ appId, userId }))) return unknown;
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const result = await this.#store.page({ appId, userId, page, pageSize });
    return {
      code: 0,
      data: {
        items: result.items.map(project),
        page,
        page_size: pageSize,
        total: result.total,
      },
    };
  }
}
