// B1-02zze rule-test kit: one page and its total of adminListUserDevices come from one snapshot
// (contract adminListUserDevices: items and total describe the same list; FU-ADMIN-DEVICES-SNAPSHOT,
// D10-968). The frozen kit of B1-02zz (../admin-user-devices/kit.ts) is only read, not imported.
//
// The store createKyselyAdminUserDeviceStore(db).page() is called directly on a real database. The
// Kysely it gets is the production one (createDb) over a pg pool whose clients pass every statement
// through a Gate:
// - statements run one at a time, in the order they reach the gate, whatever connection they use;
// - when the first statement that reads app.devices has returned, and before any other statement
//   of the store may start, the case's concurrent write commits on a separate pool.
// So a store that reads the page and the total in two snapshots (two connections, or two statements
// in READ COMMITTED) always sees one before and one after the write, whichever comes first; a store
// that reads both in one snapshot (one statement, or one REPEATABLE READ transaction) sees one state.
// Nothing waits on time. The cases assert, independent of the order, that the answer is exactly the
// expected page of the state before the write or exactly that of the state after it.
//
// Expected pages come from an oracle of this kit (last_seen_at desc, then device id desc; total is
// the number of listed devices), not from the store. A device of the user is one a session of that
// user was bound to, revoked sessions included, and the device itself not revoked (D10-585);
// devices.user_id is never read; another app is never seen.
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createDb, destroyDb, type DB } from '@couli/db';
import type {
  Kysely,
  PostgresCursor,
  PostgresPool,
  PostgresPoolClient,
  PostgresQueryResult,
} from 'kysely';
import { expect } from 'vitest';
import type { AdminUserDeviceRow } from '../../../../apps/api/src/modules/identity/application/admin-user-devices.ts';
import { createKyselyAdminUserDeviceStore } from '../../../../apps/api/src/modules/identity/infra/admin-user-device-reads.ts';

// The driver belongs to @couli/db; no new direct dependency for the test package.
type PoolConfig = Parameters<NonNullable<Parameters<typeof createDb>[0]['poolFactory']>>[0];
const requireDb = createRequire(new URL('../../../../packages/db/package.json', import.meta.url));
const { Pool } = requireDb('pg') as { Pool: new (config: PoolConfig) => PostgresPool };

/** A statement that reads app.devices (reverified_devices does not match). */
const DEVICES = /\bdevices\b/i;
/** A statement that changes rows. */
const WRITE = /^\s*(insert|update|delete|merge|truncate|copy)\b/i;

// ---------------------------------------------------------------- the gate

export class Gate {
  /** Every statement of the store, in the order it ran. */
  readonly statements: string[] = [];
  /** How many statements had run when the concurrent write committed; null: it never did. */
  writtenAfter: number | null = null;
  readonly #write: () => Promise<void>;
  #turn: Promise<void> = Promise.resolve();

  constructor(write: () => Promise<void>) {
    this.#write = write;
  }

  async run<T>(sql: string, execute: () => Promise<T>): Promise<T> {
    const previous = this.#turn;
    let done!: () => void;
    this.#turn = new Promise<void>((resolve) => {
      done = resolve;
    });
    await previous;
    try {
      this.statements.push(sql);
      const result = await execute();
      if (this.writtenAfter === null && DEVICES.test(sql)) {
        this.writtenAfter = this.statements.length;
        await this.#write();
      }
      return result;
    } finally {
      done();
    }
  }
}

function gatedClient(client: PostgresPoolClient, gate: Gate): PostgresPoolClient {
  function query<R>(
    sql: string,
    parameters: ReadonlyArray<unknown>,
  ): Promise<PostgresQueryResult<R>>;
  function query<R>(cursor: PostgresCursor<R>): PostgresCursor<R>;
  function query<R>(
    first: string | PostgresCursor<R>,
    parameters: ReadonlyArray<unknown> = [],
  ): Promise<PostgresQueryResult<R>> | PostgresCursor<R> {
    if (typeof first !== 'string') return client.query(first);
    return gate.run(first, () => client.query<R>(first, parameters));
  }
  return { query, release: () => client.release() };
}

function gatedPool(pool: PostgresPool, gate: Gate): PostgresPool {
  const clients = new WeakMap<PostgresPoolClient, PostgresPoolClient>();
  return {
    options: pool.options,
    async connect() {
      const client = await pool.connect();
      let wrapped = clients.get(client);
      if (wrapped === undefined) {
        wrapped = gatedClient(client, gate);
        clients.set(client, wrapped);
      }
      return wrapped;
    },
    end: () => pool.end(),
  };
}

// ---------------------------------------------------------------- database

export interface Harness {
  url: string;
  /** A plain pool: seeds, the concurrent write and the checks. */
  db: Kysely<DB>;
  close(): Promise<void>;
}

export function open(url: string): Harness {
  const db = createDb({ connectionString: url });
  return { url, db, close: () => destroyDb(db) };
}

// ---------------------------------------------------------------- seeds

const BASE = Date.parse('2026-11-01T08:00:00.000Z');
export const DAY = 1440;
/** `minutes` before a fixed instant (negative: after it). */
export const at = (minutes: number) => new Date(BASE - minutes * 60_000);

export interface Account {
  id: string;
  appId: string;
}

export interface World {
  h: Harness;
  appId: string;
  otherApp: string;
  /** The user whose devices are listed. */
  target: Account;
  /** Another user of the same app. */
  someone: Account;
  /** A user of another app. */
  stranger: Account;
}

async function account(db: Kysely<DB>, appId: string): Promise<Account> {
  const id = randomUUID();
  await db
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: `会员${randomBytes(3).toString('hex')}`,
      avatar: 'avatar:default',
      invite_code: id.replaceAll('-', ''),
      attr_code: `a-${id}`,
      level: 'L1',
      register_method: 'wechat',
      registered_channel: 'test',
    })
    .execute();
  return { id, appId };
}

export async function world(h: Harness): Promise<World> {
  const appId = `b1-02zze-${randomUUID()}`;
  const otherApp = `b1-02zze-other-${randomUUID()}`;
  return {
    h,
    appId,
    otherApp,
    target: await account(h.db, appId),
    someone: await account(h.db, appId),
    stranger: await account(h.db, otherApp),
  };
}

export interface DeviceSeed {
  lastSeenAt: Date;
  createdAt?: Date;
  platform?: 'ios' | 'android' | 'harmony';
  appVersion?: string;
  revokedAt?: Date;
  /** devices.user_id: never written by production code, filled only to show it is not read. */
  userColumn?: Account;
}

export interface Planned {
  id: string;
  appId: string;
  hash: string;
  platform: string;
  appVersion: string;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  userColumn: string | null;
}

/** A device row not yet written: what a concurrent write will insert. */
export function plan(appId: string, seed: DeviceSeed): Planned {
  return {
    id: randomUUID(),
    appId,
    hash: randomBytes(32).toString('hex'),
    platform: seed.platform ?? 'ios',
    appVersion: seed.appVersion ?? '2.0.0',
    createdAt: seed.createdAt ?? at(30 * DAY),
    lastSeenAt: seed.lastSeenAt,
    revokedAt: seed.revokedAt ?? null,
    userColumn: seed.userColumn?.id ?? null,
  };
}

export async function insertDevice(db: Kysely<DB>, device: Planned) {
  await db
    .insertInto('devices')
    .values({
      id: device.id,
      app_id: device.appId,
      user_id: device.userColumn,
      device_hash: device.hash,
      id_source: 'idfv',
      install_secret_cipher: randomBytes(32),
      platform: device.platform,
      app_version: device.appVersion,
      last_login_sid: null,
      revoked_at: device.revokedAt,
      last_seen_at: device.lastSeenAt,
      created_at: device.createdAt,
      updated_at: device.createdAt,
    })
    .execute();
  return device;
}

export const device = (w: World, appId: string, seed: DeviceSeed) =>
  insertDevice(w.h.db, plan(appId, seed));

export interface SessionOptions {
  revoked?: boolean;
}
export const REVOKED: SessionOptions = { revoked: true };

/** One sessions row of `owner` bound to `target`: what makes it a device of that user. */
export async function session(
  db: Kysely<DB>,
  owner: Account,
  target: Pick<Planned, 'id'>,
  options: SessionOptions = {},
) {
  const revoked = options.revoked === true;
  await db
    .insertInto('sessions')
    .values({
      id: randomUUID(),
      app_id: owner.appId,
      sid: randomBytes(16).toString('base64url'),
      login_method: null,
      user_id: owner.id,
      device_id: target.id,
      revoked_at: revoked ? at(DAY) : null,
      revoke_reason: revoked ? 'logout' : null,
      created_at: at(2 * DAY),
      updated_at: at(2 * DAY),
    })
    .execute();
}

/** A device of the target: registered, one live session of the target bound to it. */
export async function mine(w: World, seed: DeviceSeed) {
  const seeded = await device(w, w.appId, seed);
  await session(w.h.db, w.target, seeded);
  return seeded;
}

export interface Reverified {
  source: 'self' | 'admin';
  at: Date;
}

/** The target user's reverified_devices row for `seeded`. */
export async function reverified(
  w: World,
  seeded: Planned,
  source: Reverified['source'],
  when: Date,
): Promise<Reverified> {
  await w.h.db
    .insertInto('reverified_devices')
    .values({
      id: randomUUID(),
      app_id: w.appId,
      user_id: w.target.id,
      device_hash: seeded.hash,
      source,
      created_at: when,
    })
    .execute();
  return { source, at: when };
}

/**
 * Devices that are never the target's, all seen at the newest instant so a filter that is lost
 * shows on the first page: a revoked device with a live session of the target, a device whose
 * devices.user_id is the target but whose only session is another user's, a device of nobody, and
 * a device of another app.
 */
export async function noise(w: World) {
  await mine(w, { lastSeenAt: at(-5), revokedAt: at(0) });
  const column = await device(w, w.appId, { lastSeenAt: at(-5), userColumn: w.target });
  await session(w.h.db, w.someone, column);
  await device(w, w.appId, { lastSeenAt: at(-5) });
  const foreign = await device(w, w.otherApp, { lastSeenAt: at(-5) });
  await session(w.h.db, w.stranger, foreign);
}

// ---------------------------------------------------------------- concurrent writes

export const WRITTEN_AT = at(-10);

/** Revokes a device, as identity does on a device revocation. */
export async function revokeDevice(db: Kysely<DB>, target: Planned) {
  const result = await db
    .updateTable('devices')
    .set({ revoked_at: WRITTEN_AT, updated_at: WRITTEN_AT })
    .where('app_id', '=', target.appId)
    .where('id', '=', target.id)
    .executeTakeFirst();
  expect(result.numUpdatedRows).toBe(1n);
}

/** A new device and a live session of `owner` on it, in one transaction. */
export async function registerWithSession(db: Kysely<DB>, owner: Account, planned: Planned) {
  await db.transaction().execute(async (trx) => {
    await insertDevice(trx, planned);
    await session(trx, owner, planned);
  });
}

// ---------------------------------------------------------------- oracle and reads

/** A listed row in comparable form: the store's seven fields, times as instants. */
export interface Row {
  device_id: string;
  platform: string;
  app_version: string;
  created_at: number;
  last_seen_at: number;
  reverified_source: string | null;
  reverified_at: number | null;
}

export interface Expected {
  items: Row[];
  total: number;
}

export function row(seeded: Planned, record: Reverified | null = null): Row {
  return {
    device_id: seeded.id,
    platform: seeded.platform,
    app_version: seeded.appVersion,
    created_at: seeded.createdAt.getTime(),
    last_seen_at: seeded.lastSeenAt.getTime(),
    reverified_source: record === null ? null : record.source,
    reverified_at: record === null ? null : record.at.getTime(),
  };
}

/** The page `page` of `pageSize` of these listed devices: last_seen_at desc, then id desc. */
export function pageOf(listed: readonly Row[], page: number, pageSize: number): Expected {
  const sorted = [...listed].sort(
    (a, b) =>
      b.last_seen_at - a.last_seen_at ||
      (a.device_id < b.device_id ? 1 : a.device_id > b.device_id ? -1 : 0),
  );
  return {
    items: sorted.slice((page - 1) * pageSize, page * pageSize),
    total: listed.length,
  };
}

const instant = (value: Date | string) => new Date(value).getTime();

/** The seven fields of a store row; other properties a store may carry are not compared. */
export function normal(item: AdminUserDeviceRow): Row {
  return {
    device_id: item.device_id,
    platform: item.platform,
    app_version: item.app_version,
    created_at: instant(item.created_at),
    last_seen_at: instant(item.last_seen_at),
    reverified_source: item.reverified_source,
    reverified_at: item.reverified_at === null ? null : instant(item.reverified_at),
  };
}

/** Every row a read could change in these apps, and every audit record. */
async function state(w: World) {
  const apps = [w.appId, w.otherApp];
  const db = w.h.db;
  return {
    users: await db
      .selectFrom('users')
      .selectAll()
      .where('app_id', 'in', apps)
      .orderBy('id')
      .execute(),
    devices: await db
      .selectFrom('devices')
      .selectAll()
      .where('app_id', 'in', apps)
      .orderBy('id')
      .execute(),
    sessions: await db
      .selectFrom('sessions')
      .selectAll()
      .where('app_id', 'in', apps)
      .orderBy('id')
      .execute(),
    records: await db
      .selectFrom('reverified_devices')
      .selectAll()
      .where('app_id', 'in', apps)
      .orderBy('id')
      .execute(),
    audits: await db.selectFrom('audit_logs').selectAll().orderBy('id').execute(),
  };
}
type State = Awaited<ReturnType<typeof state>>;

export interface Query {
  page: number;
  pageSize: number;
}

export interface Run {
  result: Awaited<ReturnType<ReturnType<typeof createKyselyAdminUserDeviceStore>['page']>>;
  gate: Gate;
  before: State;
  written: State | null;
  after: State;
}

/**
 * page() of the target on a gated pool; `write` commits on the plain pool right after the store's
 * first statement on app.devices has returned and before its next statement starts.
 */
export async function readAcross(
  w: World,
  query: Query,
  write: (db: Kysely<DB>) => Promise<void>,
): Promise<Run> {
  const before = await state(w);
  const seen: { written: State | null } = { written: null };
  const gate = new Gate(async () => {
    await write(w.h.db);
    seen.written = await state(w);
  });
  const gated = createDb({
    connectionString: w.h.url,
    poolFactory: (config) => gatedPool(new Pool(config), gate),
  });
  try {
    const result = await createKyselyAdminUserDeviceStore(gated).page({
      appId: w.appId,
      userId: w.target.id,
      page: query.page,
      pageSize: query.pageSize,
    });
    return { result, gate, before, written: seen.written, after: await state(w) };
  } finally {
    await destroyDb(gated);
  }
}

/**
 * The answer is exactly the expected page of the state before the write or exactly that of the
 * state after it, whichever statement ran first; and page() changed no row.
 */
export function oneSnapshot(run: Run, before: Expected, after: Expected) {
  // The case itself: the write moves both the page and the total, so a mix is never either side.
  expect(before.total).not.toBe(after.total);
  expect(before.items).not.toEqual(after.items);
  expect(run.gate.writtenAfter, 'page() 必须经传入的 Kysely 读 app.devices').not.toBeNull();
  const got = { items: run.result.items.map(normal), total: run.result.total };
  expect(
    [before, after],
    `一页与总数必须出自同一快照（并发写在第 ${run.gate.writtenAfter} 条语句之后提交；语句：${JSON.stringify(run.gate.statements)}）`,
  ).toContainEqual(got);
  // Read only: the concurrent write landed, and page() itself left every row as it found it.
  expect(run.written).not.toBeNull();
  expect(run.written).not.toEqual(run.before);
  expect(run.after).toEqual(run.written);
  for (const statement of run.gate.statements) expect(statement).not.toMatch(WRITE);
}
