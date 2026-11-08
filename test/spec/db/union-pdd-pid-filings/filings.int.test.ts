// B1-06zh storage rules (BR-ID-22: Pinduoduo authorisation is recorded per (user_id, pid);
// FU-PDD-BINDING-PID first order, D10-1097 (B)). Migration 0135 adds
// app.union_pdd_pid_filings and leaves app.union_bindings untouched. Column semantics pinned:
//   id uuid PK (application-generated, no SQL default), app_id text, user_id uuid → users,
//   pid text (non-empty), union_account_id uuid → the Pinduoduo union_accounts row used for the
//   query, filed_at timestamptz (instant authority.query answered "filed"; supplied by the
//   caller, no SQL clock), created_at timestamptz DEFAULT now(); all NOT NULL.
// Linking reads/writes, 30111 and authority.query belong to the second order and are not tested.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  FILED,
  LATER,
  TIMEOUT,
  columns,
  connect,
  foreignKeys,
  newAccount,
  newFiling,
  newPid,
  newUser,
  requireTable,
  shape,
  sqlState,
  stored,
  uniqueKeys,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  connect(app);
}, TIMEOUT);

afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
}, TIMEOUT);

const REQUIRED = ['id', 'app_id', 'user_id', 'pid', 'union_account_id', 'filed_at', 'created_at'];

it(
  '[AC-B1-06zh#1] filings table has the pinned NOT NULL columns, a uuid primary key and no SQL clock on filed_at',
  async () => {
    await requireTable();
    await shape('id', 'uuid', false, false);
    await shape('app_id', 'text', false);
    await shape('user_id', 'uuid', false);
    await shape('pid', 'text', false);
    await shape('union_account_id', 'uuid', false);
    await shape('filed_at', 'timestamptz', false, false);
    await shape('created_at', 'timestamptz', false, true);
    const primary = (await uniqueKeys()).filter((key) => key.primary);
    expect(primary.map((key) => key.keys)).toEqual([['id']]);
    const row = await newFiling();
    const [saved] = await stored(row['id']);
    expect(saved).toMatchObject({
      id: row['id'],
      app_id: 'couli',
      user_id: row['user_id'],
      pid: row['pid'],
      union_account_id: row['union_account_id'],
      filed_at: FILED,
    });
    expect(saved?.['created_at']).toBeInstanceOf(Date);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06zh#2] a full, non-partial unique key on exactly (app_id, user_id, pid) rejects a second filing of the same pid',
  async () => {
    await requireTable();
    const keys = await uniqueKeys();
    expect(keys).toContainEqual({
      keys: ['app_id', 'pid', 'user_id'],
      partial: false,
      primary: false,
    });
    const first = await newFiling();
    const same = { user_id: first['user_id'], pid: first['pid'] };
    // Neither the account used for the query nor the filing instant is part of the key.
    const otherAccount = await newAccount();
    const refiled = await sqlState(
      newFiling({ ...same, union_account_id: otherAccount, filed_at: LATER }),
    );
    expect(refiled, 'other account, later instant').toBe('23505');
    const duplicate = await sqlState(
      newFiling({ ...same, union_account_id: first['union_account_id'], filed_at: FILED }),
    );
    expect(duplicate, 'exact duplicate').toBe('23505');
    expect(await stored(first['id'])).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06zh#3] one user may hold filings for several pids, and several users may file the same pid',
  async () => {
    await requireTable();
    const first = await newFiling();
    const account = { union_account_id: first['union_account_id'] };
    const otherPid = await sqlState(newFiling({ ...account, user_id: first['user_id'] }));
    expect(otherPid, 'same user, different pid').toBe('no error');
    const otherUser = await sqlState(newFiling({ ...account, pid: first['pid'] }));
    expect(otherUser, 'different user, same pid').toBe('no error');
    // users.id is a global primary key, so "the same user in another app" cannot exist; the
    // tenant scope is pinned by app_id being part of the key (#2) and this cross-app case.
    const otherApp = await sqlState(newFiling({ app_id: 'couli_two', pid: first['pid'] }));
    expect(otherApp, 'different app, same pid').toBe('no error');
    const count = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM app.union_pdd_pid_filings
      WHERE user_id = ${first['user_id']}
    `.execute(app);
    expect(count.rows).toEqual([{ n: '2' }]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06zh#4] concurrent filings of one (app, user, pid) have exactly one winner',
  async () => {
    await requireTable();
    const user_id = await newUser();
    const union_account_id = await newAccount();
    const pid = newPid();
    const results = await Promise.all([
      sqlState(newFiling({ user_id, union_account_id, pid })),
      sqlState(newFiling({ user_id, union_account_id, pid })),
    ]);
    expect(results.sort()).toEqual(['23505', 'no error']);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06zh#5] insert-if-absent on the filing key keeps the first filing unchanged',
  async () => {
    await requireTable();
    const first = await newFiling();
    const original = await stored(first['id']);
    expect(original).toHaveLength(1);
    const again = await sql<{ id: string }>`
      INSERT INTO app.union_pdd_pid_filings
        (id, app_id, user_id, pid, union_account_id, filed_at)
      VALUES (${randomUUID()}, 'couli', ${first['user_id']}, ${first['pid']},
        ${first['union_account_id']}, ${LATER})
      ON CONFLICT (app_id, user_id, pid) DO NOTHING
      RETURNING id
    `.execute(app);
    expect(again.rows).toEqual([]);
    expect(await stored(first['id'])).toEqual(original);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06zh#6] every pinned column rejects NULL with not_null_violation',
  async () => {
    await requireTable();
    for (const name of REQUIRED) {
      expect(await sqlState(newFiling({ [name]: null })), name).toBe('23502');
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-06zh#7] an empty pid is rejected by a CHECK constraint',
  async () => {
    await requireTable();
    expect(await sqlState(newFiling({ pid: '' })), 'empty pid').toBe('23514');
    expect(await sqlState(newFiling({ pid: newPid() })), 'ordinary pid').toBe('no error');
  },
  TIMEOUT,
);

it(
  '[AC-B1-06zh#8] foreign keys keep the tenant-scoped user and account and never cascade',
  async () => {
    await requireTable();
    const keys = await foreignKeys();
    const user = keys.find(
      (k) =>
        k.target === 'users' &&
        k.source.join(',') === 'app_id,user_id' &&
        k.referenced.join(',') === 'app_id,id',
    );
    expect(user, 'users (app_id, id)').toBeDefined();
    const account = keys.find(
      (k) =>
        k.target === 'union_accounts' &&
        k.source.includes('app_id') &&
        k.source.includes('union_account_id'),
    );
    expect(account, 'union_accounts keyed by tenant').toBeDefined();
    const source = account?.source ?? [];
    const referenced = account?.referenced ?? [];
    expect(referenced[source.indexOf('union_account_id')], 'account key').toBe('id');
    expect(referenced[source.indexOf('app_id')], 'account tenant').toBe('app_id');
    for (const key of keys) {
      expect(key.validated, `${key.target} validated`).toBe(true);
      expect(['a', 'r'], `${key.target} ON DELETE`).toContain(key.on_delete);
      expect(['a', 'r'], `${key.target} ON UPDATE`).toContain(key.on_update);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-06zh#9] unknown or other-tenant users and accounts are rejected with foreign_key_violation',
  async () => {
    await requireTable();
    const unknownUser = await sqlState(newFiling({ user_id: randomUUID() }));
    expect(unknownUser, 'unknown user').toBe('23503');
    const foreignUser = await newUser({ app_id: 'couli_two' });
    const otherAppUser = await sqlState(newFiling({ user_id: foreignUser }));
    expect(otherAppUser, 'user of another app').toBe('23503');
    const unknownAccount = await sqlState(newFiling({ union_account_id: randomUUID() }));
    expect(unknownAccount, 'unknown account').toBe('23503');
    const foreignAccount = await newAccount('couli_two');
    const otherAppAccount = await sqlState(newFiling({ union_account_id: foreignAccount }));
    expect(otherAppAccount, 'account of another app').toBe('23503');
  },
  TIMEOUT,
);

it(
  '[AC-B1-06zh#10] the account behind a filing must be a Pinduoduo union account',
  async () => {
    await requireTable();
    for (const platform of ['taobao', 'jd', 'meituan']) {
      const account = await newAccount('couli', platform);
      const state = await sqlState(newFiling({ union_account_id: account }));
      expect(['23503', '23514'], platform).toContain(state);
    }
    const pdd = await newAccount('couli', 'pdd');
    expect(await sqlState(newFiling({ union_account_id: pdd })), 'pdd').toBe('no error');
  },
  TIMEOUT,
);

it(
  '[AC-B1-06zh#11] union_bindings gains no pid column and keeps both of its unique keys',
  async () => {
    await requireTable();
    await requireTable('union_bindings');
    const names = (await columns('union_bindings')).map((c) => c.name);
    expect(names).toContain('pdd_custom');
    expect(names).not.toContain('pid');
    const keys = (await uniqueKeys('union_bindings')).map((key) => key.keys);
    expect(keys).toContainEqual(['app_id', 'union_account_id', 'platform', 'relation_id'].sort());
    expect(keys).toContainEqual(['app_id', 'user_id', 'platform'].sort());
  },
  TIMEOUT,
);
