import { expect, it } from 'vitest';
import { createAuditLogIdCodec } from '../infra/audit-log-id.ts';
import type { AuditLogFilter, AuditLogRow, AuditLogStore } from '../infra/audit-log-store.ts';
import { auditRangeInvalid, createAuditLogsReader, type AuditCaller } from './audit-logs-read.ts';

const ME = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01';
const OTHER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b02';
const ids = createAuditLogIdCodec(Buffer.alloc(16, 3));

function row(id: bigint, adminId: string, patch: Partial<AuditLogRow> = {}): AuditLogRow {
  return {
    id,
    adminId,
    systemActor: null,
    displayName: null,
    loginName: 'ops01',
    action: 'admin.login',
    target: `admin_users:${adminId}`,
    before: null,
    after: null,
    ip: '192.0.2.1',
    at: new Date(Date.parse('2026-10-08T00:00:00Z')),
    ...patch,
  };
}

function setup(ticked: string[] = []) {
  const rows = [row(2n, OTHER, { displayName: '运营乙' }), row(1n, ME)];
  const filters: AuditLogFilter[] = [];
  const store: AuditLogStore = {
    count: (filter) => {
      filters.push(filter);
      return Promise.resolve(
        rows.filter((r) => filter.actorId === undefined || r.adminId === filter.actorId).length,
      );
    },
    page: (filter) =>
      Promise.resolve(
        rows.filter((r) => filter.actorId === undefined || r.adminId === filter.actorId),
      ),
    byId: (_appId, id, actorId) =>
      Promise.resolve(
        rows.find((r) => r.id === id && (actorId === undefined || r.adminId === actorId)),
      ),
  };
  const reader = createAuditLogsReader({
    store,
    profiles: { permissionKeys: () => Promise.resolve(ticked) },
    ids: () => ids,
    configPermissions: new Map(),
  });
  return { reader, filters };
}

const caller: AuditCaller = { appId: 'couli', adminId: ME, isSuper: false };
const query = { page: 1, pageSize: 20 };

it('[AC-B1-34a] without audit.view_all the actor is forced to the caller', async () => {
  const { reader, filters } = setup(['risk.ban']);
  const own = await reader.list(caller, query);
  expect(own.items.map((item) => item.actorId)).toEqual([ME]);
  expect(own.items[0]).toMatchObject({ actorName: 'ops01', targetType: 'admin_user' });
  expect(filters[0]).toMatchObject({ appId: 'couli', actorId: ME });
  expect(await reader.list(caller, { ...query, actorId: OTHER })).toEqual({
    items: [],
    page: 1,
    pageSize: 20,
    total: 0,
  });
  expect(filters).toHaveLength(1);
  expect(await reader.get(caller, ids.encode(2n))).toBeUndefined();
  expect((await reader.get(caller, ids.encode(1n)))?.actorId).toBe(ME);
});

it('[AC-B1-34a] audit.view_all or super sees every account; names fall back to the username', async () => {
  for (const [ticked, isSuper] of [
    [['audit.view_all'], false],
    [[], true],
  ] as const) {
    const { reader } = setup([...ticked]);
    const all = await reader.list({ ...caller, isSuper }, query);
    expect(all.items.map((item) => [item.actorId, item.actorName])).toEqual([
      [OTHER, '运营乙'],
      [ME, 'ops01'],
    ]);
    expect((await reader.get({ ...caller, isSuper }, ids.encode(2n)))?.actorId).toBe(OTHER);
  }
});

it('[AC-B1-34a] a filter that can match nothing and a malformed id never query', async () => {
  const { reader, filters } = setup(['audit.view_all']);
  expect((await reader.list(caller, { ...query, permission: 'invented.permission' })).total).toBe(
    0,
  );
  expect((await reader.list(caller, { ...query, targetType: 'nothing' })).total).toBe(0);
  expect(filters).toEqual([]);
  expect(await reader.get(caller, 'aud_AAAAAAAAAAAAAAAAAAAAAA')).toBeUndefined();
});

it('[AC-B1-34a] from later than to is refused; equal or one-sided bounds are not', () => {
  expect(auditRangeInvalid('2026-10-09T00:00:00Z', '2026-10-08T00:00:00Z')).toBe(true);
  expect(auditRangeInvalid('2026-10-08T08:00:00+08:00', '2026-10-08T00:00:00Z')).toBe(false);
  expect(auditRangeInvalid('2026-10-09T00:00:00Z', undefined)).toBe(false);
});

it('[AC-B1-34j] from / to compare to the microsecond; equal instants are not inverted', () => {
  expect(auditRangeInvalid('2026-10-08T00:00:00.000500Z', '2026-10-08T00:00:00.000100Z')).toBe(
    true,
  );
  expect(auditRangeInvalid('2026-10-08T08:00:00.0005+08:00', '2026-10-08T00:00:00.000500Z')).toBe(
    false,
  );
  // Digits past the microsecond round as timestamptz reads them (half to even).
  expect(auditRangeInvalid('2026-10-08T00:00:00.0000014Z', '2026-10-08T00:00:00.000001Z')).toBe(
    false,
  );
  expect(auditRangeInvalid('2026-10-08T00:00:00.0000016Z', '2026-10-08T00:00:00.000001Z')).toBe(
    true,
  );
  expect(auditRangeInvalid('2026-10-08T00:00:00.0000015Z', '2026-10-08T00:00:00.000002Z')).toBe(
    false,
  );
});

it('[AC-B1-34j] a non-UUID actor_id is the empty page without reading the store', async () => {
  for (const ticked of [[], ['audit.view_all']]) {
    const { reader, filters } = setup(ticked);
    for (const actorId of ['not-a-uuid', `${ME}x`, '']) {
      expect(await reader.list(caller, { ...query, actorId })).toEqual({
        items: [],
        page: 1,
        pageSize: 20,
        total: 0,
      });
    }
    expect(filters).toEqual([]);
  }
});

it('[AC-B1-34e] the export walk passes its fixed bound and continues by keyset after a cursor', async () => {
  const filters: AuditLogFilter[] = [];
  const calls: [number, number, bigint | undefined][] = [];
  const store: AuditLogStore = {
    count: (filter) => {
      filters.push(filter);
      return Promise.resolve(0);
    },
    page: (_filter, offset, limit, after) => {
      calls.push([offset, limit, after]);
      return Promise.resolve([]);
    },
    byId: () => Promise.resolve(undefined),
  };
  const reader = createAuditLogsReader({
    store,
    profiles: { permissionKeys: () => Promise.resolve([]) },
    ids: () => ids,
    configPermissions: new Map(),
  });
  const upTo = new Date(Date.parse('2026-10-08T00:00:00Z'));
  await reader.list(caller, { page: 3, pageSize: 50, upTo, to: '2026-10-09T00:00:00Z' });
  await reader.list(caller, { page: 4, pageSize: 50, upTo, after: ids.encode(7n) });
  expect(filters.map((filter) => filter.upTo)).toEqual([upTo, upTo]);
  expect(filters[0]).toMatchObject({ to: '2026-10-09T00:00:00Z' });
  expect(calls).toEqual([
    [100, 50, undefined],
    [0, 50, 7n],
  ]);
  await expect(
    reader.list(caller, { page: 2, pageSize: 50, after: 'aud_AAAAAAAAAAAAAAAAAAAAAA' }),
  ).rejects.toThrow(RangeError);
});

const SYSTEM_ROW: AuditLogRow = {
  id: 9n,
  adminId: null,
  systemActor: 'system:risk',
  displayName: null,
  loginName: null,
  action: 'order_auto_hold',
  target: `orders:${ME}`,
  before: { hold: false, hold_reason: null },
  after: { hold: true, hold_reason: 'UNMAPPED_STATUS' },
  ip: null,
  at: new Date(Date.parse('2026-10-08T00:00:00Z')),
};

function systemSetup(row: AuditLogRow) {
  const store: AuditLogStore = {
    count: () => Promise.resolve(1),
    page: () => Promise.resolve([row]),
    byId: () => Promise.resolve(row),
  };
  return createAuditLogsReader({
    store,
    profiles: { permissionKeys: () => Promise.resolve(['audit.view_all']) },
    ids: () => ids,
    configPermissions: new Map(),
  });
}

it('[AC-B1-34p] a system row reads with the system fields and the enum name, an account row without them', async () => {
  const reader = systemSetup(SYSTEM_ROW);
  const { items } = await reader.list(caller, query);
  expect(items[0]).toMatchObject({
    actorId: null,
    actorKind: 'system',
    systemActor: 'system:risk',
    actorName: '系统（风控）',
    targetType: 'order',
    targetId: ME,
    permission: null,
  });
  const account = await systemSetup(row(1n, ME)).list(caller, query);
  expect(account.items[0]).not.toHaveProperty('actorKind');
  expect(account.items[0]).not.toHaveProperty('systemActor');
});

it('[AC-B1-34p] a system identity the enum does not have yet reads with a null name', async () => {
  const reader = systemSetup({ ...SYSTEM_ROW, systemActor: 'system:new_engine' });
  const { items } = await reader.list(caller, query);
  expect(items[0]).toMatchObject({ systemActor: 'system:new_engine', actorName: null });
});
