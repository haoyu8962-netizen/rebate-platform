import { createHash } from 'node:crypto';
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock, type FieldCrypto } from '../../platform/index.ts';
import { DEVICE_CHECK_LOCK_TIMEOUT, DevicesRepository } from '../infra/devices.repository.ts';
import type { InvalidDeviceHashes } from '../infra/invalid-device-hashes.ts';
import {
  RegisterDeviceService,
  isDefiniteInsertFailure,
  type DeviceRegistrationPorts,
  type RegisterDeviceCommand,
} from './register-device.service.ts';

const NOW = '2026-10-05T04:00:00.000Z';
const hash = createHash('sha256').update('9774d56d682e549d').digest('hex');
const zeros = createHash('sha256').update('0').digest('hex');
const command: RegisterDeviceCommand = {
  appId: 'couli',
  platform: 'android',
  appVersion: '2.3.4',
  deviceHash: hash,
  idSource: 'android_id',
  clientIp: '192.0.2.10',
};

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/**
 * Kysely on a scripted driver: records every compiled statement plus begin / commit / rollback
 * markers and answers each statement with `reply` (rows, or an Error to reject with).
 */
function scriptedDb(reply: (statement: Statement) => readonly unknown[] | Error = () => []) {
  const statements: Statement[] = [];
  const mark = (name: string) => {
    statements.push({ sql: name, parameters: [] });
    return Promise.resolve();
  };
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const statement = { sql: compiled.sql, parameters: compiled.parameters };
      statements.push(statement);
      const rows = reply(statement);
      return rows instanceof Error ? Promise.reject(rows) : Promise.resolve({ rows: rows as R[] });
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: () => mark('begin'),
    commitTransaction: () => mark('commit'),
    rollbackTransaction: () => mark('rollback'),
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
}

/** Column → parameter of an `insert into "t" ("a", "b") values ($1, $2)` statement. */
function insertedRow(statement: Statement): Record<string, unknown> {
  const columns = /\(([^)]*)\) values/.exec(statement.sql)?.[1];
  if (columns === undefined) throw new Error('not an insert');
  const row: Record<string, unknown> = {};
  columns
    .split(',')
    .map((column) => column.trim().replaceAll('"', ''))
    .forEach((column, index) => {
      row[column] = statement.parameters[index];
    });
  return row;
}

/** The rows the repository inserted, by table. */
function fakeDb() {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const { db, statements } = scriptedDb((statement) => {
    if (statement.sql.startsWith('insert into')) {
      inserts.push({
        table: /^insert into "([^"]+)"/.exec(statement.sql)![1]!,
        row: insertedRow(statement),
      });
    }
    return [];
  });
  return { db, statements, inserts };
}

/** Stand-in cipher: records its calls; the output never contains the plaintext. */
function fakeCrypto() {
  const calls: { plaintext: string; context: string; ciphertext: string }[] = [];
  const unused = (): never => {
    throw new Error('not used by device registration');
  };
  const crypto: FieldCrypto = {
    currentKeyVersion: 1,
    encrypt(plaintext, context) {
      const digest = createHash('sha256').update(`${context}\0${plaintext}`).digest('base64url');
      const ciphertext = `v1.1.${digest}`;
      calls.push({ plaintext, context, ciphertext });
      return ciphertext;
    },
    decrypt: unused,
    keyVersionOf: unused,
    needsReencrypt: unused,
    reencrypt: unused,
    blindIndex: unused,
  };
  return { crypto, calls };
}

/** Records the risk port calls; admits unless `refuse` is set. */
function fakeRisk(refuse?: number) {
  const calls: string[] = [];
  const reservation = { appId: 'couli', ipDigest: 'd'.repeat(32), token: 't' };
  const risk: DeviceRegistrationPorts = {
    async reserve(input) {
      calls.push(`reserve:${input.appId}:${input.clientIp}`);
      return refuse === undefined
        ? { code: 0, reservation }
        : { code: 42901, retryAfterSec: refuse };
    },
    async release() {
      calls.push('release');
    },
    async reconcile(_reservation, deviceId, exists) {
      calls.push(`reconcile:${String(await exists(deviceId).catch(() => 'error'))}`);
    },
    async recordSuccess(input) {
      calls.push(`record:${input.deviceHash === hash ? 'hash' : input.deviceHash}`);
    },
  };
  return { risk, calls };
}

/** The invalid-hash list by app: `[zeros]` for every app; `apps` records each read. */
function fakeList(list: ReadonlySet<string> = new Set([zeros])) {
  const apps: string[] = [];
  const hashes: InvalidDeviceHashes = {
    forApp(appId) {
      apps.push(appId);
      return Promise.resolve(list);
    },
  };
  return { hashes, apps };
}

function service(options: {
  db?: Kysely<DB> | undefined;
  crypto?: FieldCrypto | undefined;
  risk?: DeviceRegistrationPorts;
  invalid?: InvalidDeviceHashes;
}) {
  return new RegisterDeviceService(
    new FixedClock(NOW),
    options.invalid ?? fakeList().hashes,
    new DevicesRepository(options.db),
    options.crypto,
    options.risk ?? fakeRisk().risk,
  );
}

/**
 * A database whose insert rejects with `error` and whose device select answers `present`;
 * `lockError` rejects the check's advisory lock (a lock_timeout, 55P03).
 */
function failingDb(error: unknown, present: boolean, lockError?: Error) {
  let locks = 0;
  const scripted = scriptedDb((statement) => {
    if (statement.sql.startsWith('insert into')) return error as Error;
    if (statement.sql.includes('pg_advisory_xact_lock')) {
      locks += 1;
      // The first lock is the insert's own; the second is the check's.
      return locks > 1 && lockError !== undefined ? lockError : [];
    }
    if (statement.sql.startsWith('select "id" from "devices"')) {
      return present ? [{ id: statement.parameters[1] }] : [];
    }
    return [];
  });
  return {
    db: scripted.db,
    statements: scripted.statements,
    get selects() {
      return scripted.statements
        .filter((statement) => statement.sql.startsWith('select "id" from "devices"'))
        .map((statement) => ({ table: 'devices', parameters: statement.parameters }));
    },
  };
}

it('[AC-B1-02c#2][AC-B1-02c#3] stores one unbound row whose cipher is the field encryption of the returned secret', async () => {
  const { db, inserts } = fakeDb();
  const { crypto, calls } = fakeCrypto();
  const result = await service({ db, crypto }).register(command);
  if (result.kind !== 'registered') throw new Error('expected a registration');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    plaintext: result.installSecret,
    context: `devices.install_secret:${result.deviceId}`,
  });
  expect(inserts).toHaveLength(1);
  expect(inserts[0]!.table).toBe('devices');
  const now = new FixedClock(NOW).now();
  expect(inserts[0]!.row).toEqual({
    id: result.deviceId,
    app_id: 'couli',
    user_id: null,
    device_hash: hash,
    id_source: 'android_id',
    platform: 'android',
    app_version: '2.3.4',
    install_secret_cipher: Buffer.from(calls[0]!.ciphertext, 'utf8'),
    last_login_sid: null,
    revoked_at: null,
    last_seen_at: now,
    created_at: now,
    updated_at: now,
  });
  const stored = inserts[0]!.row['install_secret_cipher'] as Buffer;
  expect(stored.includes(Buffer.from(result.installSecret))).toBe(false);
  expect(stored.includes(Buffer.from(result.installSecret, 'base64url'))).toBe(false);
});

it('[AC-B1-02c#7] issues a new device id and secret on every registration of the same hash', async () => {
  const { db, inserts } = fakeDb();
  const registration = service({ db, crypto: fakeCrypto().crypto });
  const first = await registration.register(command);
  const second = await registration.register(command);
  if (first.kind !== 'registered' || second.kind !== 'registered') throw new Error('expected two');
  // Lower-case UUIDv7 carrying the clock's millisecond (platform newUuidV7), distinct per call.
  for (const { deviceId } of [first, second]) {
    expect(deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(Number.parseInt(deviceId.replace(/-/g, '').slice(0, 12), 16)).toBe(
      new FixedClock(NOW).now().getTime(),
    );
  }
  expect(second.deviceId).not.toBe(first.deviceId);
  expect(second.installSecret).not.toBe(first.installSecret);
  expect(inserts.map(({ row }) => row['device_hash'])).toEqual([hash, hash]);
  expect(inserts.map(({ row }) => row['revoked_at'])).toEqual([null, null]);
});

it('[AC-B1-02c#5] refuses a hash on the invalid list without encrypting or storing anything', async () => {
  const { db, inserts } = fakeDb();
  const { crypto, calls } = fakeCrypto();
  const result = await service({ db, crypto }).register({ ...command, deviceHash: zeros });
  expect(result).toEqual({ kind: 'invalid_device_hash' });
  expect(calls).toEqual([]);
  expect(inserts).toEqual([]);
});

it('fails the request, storing nothing, when the process has no keyring or no database', async () => {
  const { db, inserts } = fakeDb();
  await expect(service({ db }).register(command)).rejects.toThrow(/keyring/);
  expect(inserts).toEqual([]);
  await expect(service({ crypto: fakeCrypto().crypto }).register(command)).rejects.toThrow(
    /database/,
  );
  // An invalid hash is still refused without them.
  expect(await service({}).register({ ...command, deviceHash: zeros })).toEqual({
    kind: 'invalid_device_hash',
  });
});

it('[AC-B1-03f#16] a refused reservation issues nothing: no secret, no cipher, no row', async () => {
  const { db, inserts } = fakeDb();
  const { crypto, calls } = fakeCrypto();
  const risk = fakeRisk(1201);
  const result = await service({ db, crypto, risk: risk.risk }).register(command);
  expect(result).toEqual({ kind: 'rate_limited', retryAfterSec: 1201 });
  expect(calls).toEqual([]);
  expect(inserts).toEqual([]);
  expect(risk.calls).toEqual(['reserve:couli:192.0.2.10']);
});

it('[AC-B1-03f#25] an invalid hash is refused before the reservation', async () => {
  const risk = fakeRisk();
  const result = await service({
    db: fakeDb().db,
    crypto: fakeCrypto().crypto,
    risk: risk.risk,
  }).register({ ...command, deviceHash: zeros });
  expect(result).toEqual({ kind: 'invalid_device_hash' });
  expect(risk.calls).toEqual([]);
});

it('[AC-B1-03f#23] a stored device is counted for the hot-hash alert after its reservation', async () => {
  const risk = fakeRisk();
  const result = await service({
    db: fakeDb().db,
    crypto: fakeCrypto().crypto,
    risk: risk.risk,
  }).register(command);
  expect(result.kind).toBe('registered');
  expect(risk.calls).toEqual(['reserve:couli:192.0.2.10', 'record:hash']);
});

it('[AC-B1-03f#27] a failing hot-hash count does not fail the registration', async () => {
  const risk = fakeRisk();
  const result = await service({
    db: fakeDb().db,
    crypto: fakeCrypto().crypto,
    risk: {
      ...risk.risk,
      recordSuccess: () => Promise.reject(new Error('hot count failed')),
    },
  }).register(command);
  expect(result.kind).toBe('registered');
});

it('[AC-B1-03f#20] a constraint rejection releases the reservation without a lookup', async () => {
  const risk = fakeRisk();
  const failing = failingDb(Object.assign(new Error('duplicate'), { code: '23505' }), false);
  await expect(
    service({ db: failing.db, crypto: fakeCrypto().crypto, risk: risk.risk }).register(command),
  ).rejects.toThrow('duplicate');
  expect(risk.calls).toEqual(['reserve:couli:192.0.2.10', 'release']);
  expect(failing.selects).toEqual([]);
});

for (const present of [true, false]) {
  it(`[AC-B1-03f#21] an unknown insert outcome reconciles against the device row (${String(present)})`, async () => {
    const risk = fakeRisk();
    const failing = failingDb(
      Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }),
      present,
    );
    await expect(
      service({ db: failing.db, crypto: fakeCrypto().crypto, risk: risk.risk }).register(command),
    ).rejects.toThrow('connection lost');
    expect(risk.calls).toEqual(['reserve:couli:192.0.2.10', `reconcile:${String(present)}`]);
    // The device row is looked up in this app only (app_id and id conditions).
    expect(failing.selects).toEqual([
      { table: 'devices', parameters: ['couli', expect.any(String)] },
    ]);
    expect(failing.statements.find((s) => s.sql.startsWith('select "id"'))!.sql).toMatch(
      /where "app_id" = \$1 and "id" = \$2/,
    );
  });
}

it('[AC-B1-03f#21] the insert and the check take the same device lock; the check waits for it before reading', async () => {
  const risk = fakeRisk();
  const failing = failingDb(
    Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }),
    false,
  );
  await expect(
    service({ db: failing.db, crypto: fakeCrypto().crypto, risk: risk.risk }).register(command),
  ).rejects.toThrow('connection lost');
  const kinds = failing.statements.map(({ sql }) =>
    sql.includes('pg_advisory_xact_lock')
      ? 'lock'
      : sql.includes("set_config('lock_timeout'")
        ? 'lock_timeout'
        : sql.split(' ')[0]!,
  );
  // Insert transaction: lock before the row; check transaction: bounded wait, lock, then read.
  expect(kinds).toEqual([
    'begin',
    'lock',
    'insert',
    'rollback',
    'begin',
    'lock_timeout',
    'lock',
    'select',
    'commit',
  ]);
  const locks = failing.statements.filter(({ sql }) => sql.includes('pg_advisory_xact_lock'));
  const select = failing.selects[0]!;
  expect(locks[0]!.parameters).toEqual([
    `identity.devices.issue:couli:${String(select.parameters[1])}`,
  ]);
  expect(locks[1]!.parameters).toEqual(locks[0]!.parameters);
  expect(locks[0]!.sql).toContain('hashtextextended');
  const timeout = failing.statements.find(({ sql }) => sql.includes('lock_timeout'))!;
  expect(timeout.parameters).toEqual([DEVICE_CHECK_LOCK_TIMEOUT]);
});

it('[AC-B1-03f#21] a check that cannot get the device lock reads nothing and keeps the slot', async () => {
  const risk = fakeRisk();
  const failing = failingDb(
    Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }),
    false,
    Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
  );
  await expect(
    service({ db: failing.db, crypto: fakeCrypto().crypto, risk: risk.risk }).register(command),
  ).rejects.toThrow('connection lost');
  // fakeRisk's reconcile records a rejected check as `error`; no release follows.
  expect(risk.calls).toEqual(['reserve:couli:192.0.2.10', 'reconcile:error']);
  expect(failing.selects).toEqual([]);
});

it('[AC-B1-02c#2] a stored device is written in one transaction after its device lock', async () => {
  const { db, statements } = fakeDb();
  const result = await service({ db, crypto: fakeCrypto().crypto }).register(command);
  if (result.kind !== 'registered') throw new Error('expected a registration');
  expect(statements.map(({ sql }) => sql.split(' ')[0])).toEqual([
    'begin',
    'SELECT',
    'insert',
    'commit',
  ]);
  expect(statements[1]!.parameters).toEqual([`identity.devices.issue:couli:${result.deviceId}`]);
});

it('[AC-B1-03f#20] classifies insert failures: SQLSTATE answers are definite, connection loss is not', () => {
  expect(isDefiniteInsertFailure({ code: '23505' })).toBe(true);
  expect(isDefiniteInsertFailure({ code: '40001' })).toBe(true);
  expect(isDefiniteInsertFailure({ code: '08006' })).toBe(false);
  expect(isDefiniteInsertFailure({ code: '57P01' })).toBe(false);
  expect(isDefiniteInsertFailure({ code: 'XX000' })).toBe(false);
  expect(isDefiniteInsertFailure({ code: 'ECONNRESET' })).toBe(false);
  expect(isDefiniteInsertFailure(new Error('no code'))).toBe(false);
  expect(isDefiniteInsertFailure(null)).toBe(false);
});

it("[AC-B1-02zzi#14][AC-B1-02zzi#16] reads the list of the request's app on every registration, before any statement", async () => {
  const { db, statements } = fakeDb();
  const list = fakeList();
  const registration = service({ db, crypto: fakeCrypto().crypto, invalid: list.hashes });
  const order: string[] = [];
  const recording: InvalidDeviceHashes = {
    async forApp(appId) {
      order.push(`read:${String(statements.length)}`);
      return list.hashes.forApp(appId);
    },
  };
  const tracked = service({ db, crypto: fakeCrypto().crypto, invalid: recording });
  expect((await registration.register(command)).kind).toBe('registered');
  expect((await registration.register({ ...command, appId: 'other' })).kind).toBe('registered');
  expect(list.apps).toEqual(['couli', 'other']);
  const before = statements.length;
  expect((await tracked.register(command)).kind).toBe('registered');
  // The list is read before the registration's first statement (no transaction is held).
  expect(order).toEqual([`read:${String(before)}`]);
});

it("[AC-B1-02zzi#1] a hash on the app's list is refused; the same hash off the list is registered", async () => {
  const listed = createHash('sha256').update('added-by-operations').digest('hex');
  const { db, inserts } = fakeDb();
  const byApp: InvalidDeviceHashes = {
    forApp: (appId) => Promise.resolve(new Set(appId === 'couli' ? [zeros, listed] : [zeros])),
  };
  const registration = service({ db, crypto: fakeCrypto().crypto, invalid: byApp });
  expect(await registration.register({ ...command, deviceHash: listed })).toEqual({
    kind: 'invalid_device_hash',
  });
  expect(inserts).toEqual([]);
  const other = await registration.register({ ...command, appId: 'other', deviceHash: listed });
  expect(other.kind).toBe('registered');
  expect(inserts.map(({ row }) => row['device_hash'])).toEqual([listed]);
});

it('[AC-B1-02c#4] a malformed hash is refused without reading the list', async () => {
  const list = fakeList();
  const registration = service({
    db: fakeDb().db,
    crypto: fakeCrypto().crypto,
    invalid: list.hashes,
  });
  for (const deviceHash of [hash.toUpperCase(), hash.slice(1), `${hash} `, '']) {
    expect(await registration.register({ ...command, deviceHash })).toEqual({
      kind: 'invalid_device_hash',
    });
  }
  expect(list.apps).toEqual([]);
});
